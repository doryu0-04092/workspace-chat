import type { components } from '@workspace-chat/shared';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Message = Schemas['Message'];
type MessagePage = Schemas['MessagePage'];
export type MessagePages = InfiniteData<MessagePage, string | null>;

export function messagesKey(workspaceId: string, channelId: string) {
  return ['workspaces', workspaceId, 'channels', channelId, 'messages'] as const;
}

/** 最新のページの先頭（画面の最後）に足す。同じ id が既にあれば足さない（投稿の応答と配信のどちらが先に届いても1行にする）。 */
export function addMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  const [newest, ...older] = data?.pages ?? [];
  if (!data || !newest) return data;
  if (data.pages.some((page) => page.messages.some((m) => m.id === message.id))) return data;
  return {
    ...data,
    pages: [{ ...newest, messages: [message, ...newest.messages] }, ...older],
  };
}

/** 同じ id のメッセージを置き換える（編集。機能一覧 4.2）。 */
export function replaceMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  return mapMessages(data, (m) => (m.id === message.id ? message : m));
}

/** 削除済みにする（本文を持たない。機能一覧 4.2）。 */
export function markDeleted(
  data: MessagePages | undefined,
  messageId: string,
): MessagePages | undefined {
  return mapMessages(data, (m) => (m.id === messageId ? { ...m, body: null, deleted: true } : m));
}

function mapMessages(
  data: MessagePages | undefined,
  change: (message: Message) => Message,
): MessagePages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, messages: page.messages.map(change) })),
  };
}

/**
 * スレッドの返信（F-17）。**チャンネルの一覧の鍵の下に置く**——入室のときの一覧の読み直し（`invalidateQueries` は鍵の前方で一致する）と
 * 削除の反映が、開いているスレッドの返信にも届く。
 */
export function repliesKey(workspaceId: string, channelId: string, parentId: string) {
  return [...messagesKey(workspaceId, channelId), parentId, 'replies'] as const;
}

/**
 * メッセージを載せる一覧の鍵（F-11・F-17）。**本体はチャンネルの一覧、返信はその親の返信。**
 * **1件のメッセージを一覧に反映するとき（編集の応答・`message:new`・`message:updated`）は、この鍵に当てる**——
 * 要求の経路と配信の経路で決め方を分けると、反映先の規則を変えるときに片方だけが変わる（#536 第0巡の設計の提案①）。
 * 削除は配信が親を持たないため、`messagesKey` の前方一致で当てる（`markDeleted`）。
 */
export function listKeyOf(
  workspaceId: string,
  channelId: string,
  message: Pick<Message, 'parentId'>,
): readonly unknown[] {
  return message.parentId === null
    ? messagesKey(workspaceId, channelId)
    : repliesKey(workspaceId, channelId, message.parentId);
}

function messagesPath(workspaceId: string, channelId: string): string {
  return `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/messages`;
}

function repliesPath(workspaceId: string, channelId: string, parentId: string): string {
  return `${messagesPath(workspaceId, channelId)}/${segment(parentId)}/replies`;
}

/**
 * 新しい順のページを遡って読む。1ページ目が最新で、続きは `nextBefore` を `before` に渡して古い側へ遡る（カーソルページネーション。機能一覧 4.1・6）。
 * `enabled` が false なら読まず、同じ鍵のキャッシュを見るだけにする。
 */
function usePages(key: readonly unknown[], path: string, enabled = true) {
  const store = useSessionStore();
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      requestJson<MessagePage>(
        store,
        pageParam === null ? path : `${path}?${new URLSearchParams({ before: pageParam })}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled,
  });
}

/** チャンネルのメッセージ（F-11・F-12。REST の仕様の listMessages）。 */
export function useMessages(workspaceId: string, channelId: string) {
  return usePages(messagesKey(workspaceId, channelId), messagesPath(workspaceId, channelId));
}

/** チャンネルの一覧に読み込み済みのメッセージ。読み込んでいなければ undefined（一覧を読み直さない）。 */
export function useLoadedMessage(
  workspaceId: string,
  channelId: string,
  messageId: string,
): Message | undefined {
  const messages = usePages(
    messagesKey(workspaceId, channelId),
    messagesPath(workspaceId, channelId),
    false,
  );
  return messages.data?.pages.flatMap((page) => page.messages).find((m) => m.id === messageId);
}

/** スレッドの返信（F-17。REST の仕様の listReplies）。 */
export function useReplies(workspaceId: string, channelId: string, parentId: string) {
  return usePages(
    repliesKey(workspaceId, channelId, parentId),
    repliesPath(workspaceId, channelId, parentId),
  );
}

/** 本文を送り、応答のメッセージを最新のページの先頭に足す。一覧は読み直さない。 */
function usePost(key: readonly unknown[], path: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      requestJson<Message>(store, path, {
        method: 'POST',
        body: { body } satisfies Schemas['PostMessageRequest'],
      }),
    onSuccess: (message) =>
      queryClient.setQueryData<MessagePages>(key, (data) => addMessage(data, message)),
  });
}

/** 投稿する（REST の仕様の postMessage）。 */
export function usePostMessage(workspaceId: string, channelId: string) {
  return usePost(messagesKey(workspaceId, channelId), messagesPath(workspaceId, channelId));
}

/**
 * 自分のメッセージを編集する（F-13。REST の仕様の editMessage。判定は api）。
 * **通ったら、そのメッセージを載せる一覧（`listKeyOf`。本体はチャンネルの一覧、返信はその親の返信）で置き換える**。一覧は読み直さない。
 * スレッドの親はチャンネルの一覧から読む（`useLoadedMessage`）ので、本体の置き換えはスレッドの親にも届く。
 */
export function useEditMessage(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: string }) =>
      requestJson<Message>(
        store,
        `${messagesPath(workspaceId, channelId)}/${segment(messageId)}`,
        // 編集の本文は投稿と同じ形（REST の仕様は editMessage の本体に PostMessageRequest を使う）
        { method: 'PATCH', body: { body } satisfies Schemas['PostMessageRequest'] },
      ),
    onSuccess: (message) =>
      queryClient.setQueryData<MessagePages>(listKeyOf(workspaceId, channelId, message), (data) =>
        replaceMessage(data, message),
      ),
  });
}

/**
 * 自分のメッセージを削除する（F-13。論理削除。判定は api）。
 * 通ったら、`messagesKey` の前方一致で、チャンネルの一覧と読み込んである全ての返信のキャッシュで削除済みにする（削除の配信と同じ当て方）。
 */
export function useDeleteMessage(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      requestJson<void>(store, `${messagesPath(workspaceId, channelId)}/${segment(messageId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, messageId) =>
      queryClient.setQueriesData<MessagePages>(
        { queryKey: messagesKey(workspaceId, channelId) },
        (data) => markDeleted(data, messageId),
      ),
  });
}

/** スレッドに返信する（REST の仕様の postReply）。親の件数と参加者は、配られる `message:updated` で置き換わる。 */
export function usePostReply(workspaceId: string, channelId: string, parentId: string) {
  return usePost(
    repliesKey(workspaceId, channelId, parentId),
    repliesPath(workspaceId, channelId, parentId),
  );
}

/**
 * スレッドの既読位置を進める（F-23。REST の仕様の updateThreadRead）。**親は呼ぶたびに渡す**——開いているスレッドを切り替えても、
 * 送る先を読み込んだ返信の親と揃える。戻さないのは api が持つ不変条件で、進めた後の未読数は `unread:updated` で届く。
 */
export function useUpdateThreadRead(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  return useMutation({
    mutationFn: ({
      parentId,
      lastReadMessageId,
    }: {
      parentId: string;
      lastReadMessageId: string;
    }) =>
      requestJson<void>(
        store,
        `${messagesPath(workspaceId, channelId)}/${segment(parentId)}/read`,
        {
          method: 'PUT',
          body: { lastReadMessageId } satisfies Schemas['UpdateChannelReadRequest'],
        },
      ),
  });
}
