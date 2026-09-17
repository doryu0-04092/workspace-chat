import { useQueryClient } from '@tanstack/react-query';
import {
  type ChannelEnterAck,
  type ChannelRoomRequest,
  type MessageDeletedPayload,
  type MessageNewPayload,
  type MessageUpdatedPayload,
  type PresenceChangedPayload,
  REALTIME_REQUESTS,
  type RealtimeEventName,
} from '@workspace-chat/shared';
import { useEffect, useState } from 'react';
import type { Failure } from '../auth/failure';
import {
  addMessage,
  listKeyOf,
  markDeleted,
  type Message,
  type MessagePages,
  messagesKey,
  replaceMessage,
} from '../messages/queries';
import { presenceKey } from './presence';
import { useRealtime } from './realtime-context';

const MESSAGE_NEW = 'message:new' satisfies RealtimeEventName;
const MESSAGE_UPDATED = 'message:updated' satisfies RealtimeEventName;
const MESSAGE_DELETED = 'message:deleted' satisfies RealtimeEventName;
const PRESENCE_CHANGED = 'presence:changed' satisfies RealtimeEventName;

/** 入室要求が上限（429）で断られたとき、送り直すまで待つ時間。api の入室の上限の窓（1分）と同じ。 */
export const ENTER_RETRY_DELAY_MS = 60_000;

/** 開いているチャンネルの在席を、入室要求を送り直して取り直す間隔（機能一覧 9.2「開いている画面の在席も5分ごとに取り直す」）。 */
export const PRESENCE_REFRESH_MS = 5 * 60 * 1000;

/**
 * 開いているチャンネルのリアルタイムの反映（F-16。機能一覧 5.2・9.2）。入室を断られたら、その理由を返す。
 *
 * - **接続したら（再接続を含む）入室要求を送り、入れたら一覧を読み直す**——入室の前と、切れていた間に投稿されたメッセージを補完する
 *   （5.2「再接続後、切断中に発生したメッセージが補完される」。`connect` は「upon connection and reconnection」に届く）
 * - **上限（429）で断られたら、1分おいて、繋がっていれば入室要求を送り直す**（9.2「画面は時間をおいてやり直す」）。ほかの断りは送り直さない
 * - チャンネルを離れたら、繋がっていれば退室要求を送る（9.2）
 * - `message:new` / `message:updated` / `message:deleted` を、このチャンネルの一覧と、読み込んであるスレッドの返信のキャッシュに反映する
 *   （技術スタックの「データ取得」。機能一覧 6）。`message:new` は同じ id を2行にしない（自分の投稿は、投稿の応答と配信の両方で届く）
 * - **在席（F-22）は部屋の側の経路だけで持つ**（9.2）: 入室の acknowledgement の `present` で置き換え、`presence:changed` で足し・外し、
 *   `PRESENCE_REFRESH_MS` ごとに、繋がっていれば入室要求を送り直して置き換える（9.2「5分ごとの取り直しの契機」。サーバーは既に部屋に入っている接続の
 *   入室要求で一覧を取り直してから返す）。**取り直しの入室ではメッセージの一覧を読み直さない**——読み直しは切れていた間の補完のためであり、
 *   繋がったままの取り直しで遡って読んだページを全部引き直すと、5分ごとに往復が重なる。**断られたら在席を空にする**（部屋に入っていない接続は在席を受け取れない）。
 *   チャンネルを離れたら在席を捨てる
 */
export function useChannelRealtime(workspaceId: string, channelId: string): Failure | null {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();
  const [rejected, setRejected] = useState<Failure | null>(null);

  useEffect(() => {
    const key = messagesKey(workspaceId, channelId);
    const room: ChannelRoomRequest = { channelId };
    /** 本体のメッセージはチャンネルの一覧に、返信はその親の返信に（`listKeyOf`。編集の応答と同じ決め方）。読み込んでいないキャッシュは作らない（更新が undefined を返す）。 */
    const listOf = (message: Message) => listKeyOf(workspaceId, channelId, message);
    const update = (
      target: readonly unknown[],
      change: (data: MessagePages | undefined) => MessagePages | undefined,
    ) => queryClient.setQueryData<MessagePages>(target, change);

    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const presence = presenceKey(workspaceId, channelId);
    /** `reload`: 入れたらメッセージの一覧を読み直すか（接続・繋ぎ直しの入室では読み直し、在席の取り直しでは読み直さない）。 */
    const enter = (reload = true) => {
      clearTimeout(retry);
      socket.emit(REALTIME_REQUESTS.channelEnter, room, (ack: ChannelEnterAck) => {
        if (!active) return;
        if (!ack.ok) {
          setRejected({ ok: false, status: ack.status, code: ack.error.code });
          queryClient.setQueryData<readonly string[]>(presence, []);
          if (ack.status === 429) {
            retry = setTimeout(() => {
              if (socket.connected) enter(reload);
            }, ENTER_RETRY_DELAY_MS);
          }
          return;
        }
        setRejected(null);
        queryClient.setQueryData<readonly string[]>(presence, ack.present);
        if (reload) void queryClient.invalidateQueries({ queryKey: key });
      });
    };
    const onConnect = () => enter();
    const refresh = setInterval(() => {
      if (socket.connected) enter(false);
    }, PRESENCE_REFRESH_MS);
    const onPresenceChanged = ({ channelId: target, userId, present }: PresenceChangedPayload) => {
      if (target !== channelId) return;
      queryClient.setQueryData<readonly string[]>(presence, (current = []) => {
        const others = current.filter((id) => id !== userId);
        return present ? [...others, userId] : others;
      });
    };
    const onNew = ({ message }: MessageNewPayload) => {
      // スレッドの返信は、チャンネル本体の一覧に混ぜない（機能一覧 6）。件数が変わった親は message:updated で置き換わる
      if (message.channelId === channelId) {
        update(listOf(message), (data) => addMessage(data, message));
      }
    };
    const onUpdated = ({ message }: MessageUpdatedPayload) => {
      if (message.channelId === channelId) {
        update(listOf(message), (data) => replaceMessage(data, message));
      }
    };
    const onDeleted = (payload: MessageDeletedPayload) => {
      // 削除の配信は親を持たないため、チャンネルの一覧と、その下に置いた返信のキャッシュのすべてに当てる（鍵の前方で一致する）
      if (payload.channelId === channelId) {
        queryClient.setQueriesData<MessagePages>({ queryKey: key }, (data) =>
          markDeleted(data, payload.messageId),
        );
      }
    };

    socket.on('connect', onConnect);
    socket.on(PRESENCE_CHANGED, onPresenceChanged);
    socket.on(MESSAGE_NEW, onNew);
    socket.on(MESSAGE_UPDATED, onUpdated);
    socket.on(MESSAGE_DELETED, onDeleted);
    if (socket.connected) enter();
    return () => {
      active = false;
      clearTimeout(retry);
      clearInterval(refresh);
      queryClient.removeQueries({ queryKey: presence, exact: true });
      socket.off('connect', onConnect);
      socket.off(PRESENCE_CHANGED, onPresenceChanged);
      socket.off(MESSAGE_NEW, onNew);
      socket.off(MESSAGE_UPDATED, onUpdated);
      socket.off(MESSAGE_DELETED, onDeleted);
      if (socket.connected) socket.emit(REALTIME_REQUESTS.channelExit, room);
    };
  }, [socket, queryClient, workspaceId, channelId]);

  return rejected;
}
