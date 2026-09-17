import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  HERE_MENTION_NOTICE,
  type HereMentionPayload,
  type HereMentionReceipt,
} from '@workspace-chat/shared';
import { RealtimeGateway, userRoom } from './realtime.gateway';

/**
 * `@here` の受け取りを待つ期限（F-21。機能一覧 9.2「判断が必要な点」。実装時に決めた値）。期限までに返らなかった利用者は、受け取らなかったとして扱う。
 * **他のタスクの分は、そのタスクがこの期限まで待ってから答える**ため、Redis アダプタがタスクをまたぐ問い合わせを打ち切る期限
 * （`requestsTimeout`。既定 5,000 ミリ秒）より、タスクの間の往復の分だけ短くしておく。チャンネルを開いている画面は、届いたその場で返す。
 */
export const HERE_RECEIPT_TIMEOUT_MS = 3_000;

/**
 * 他のタスクの答えを待つ上限。Redis アダプタは、Valkey に繋がらず購読者数を問い合わせられないとき、答えを返さずに黙って終える
 * （`serverSideEmitWithAck` の失敗を握りつぶす）。待ち続けないように、アダプタの打ち切りの期限（5,000 ミリ秒）の後で自分から打ち切る。
 */
const REMOTE_ANSWER_LIMIT_MS = 6_000;

/** 他のタスクへ、手元の接続での受け取りの確かめを頼むサーバー間の通知の名前。クライアントとはやりとりしない。 */
const COLLECT = 'here:server:collect';

type CollectRequest = { payload: HereMentionPayload; userIds: string[] };

/**
 * `@here` の受け取りを確かめる（F-21。機能一覧 9.2「タスクをまたぐ在席」）。宛先の利用者の接続へ `HERE_MENTION_NOTICE` を
 * acknowledgement 付きで送り、**どれか1本でも受け取りを返した利用者**を返す（画面はそのチャンネルを開いていれば返し、開いていなければ返さずに弾く）。
 *
 * - **接続ごとに送り、利用者の部屋へのブロードキャストの acknowledgement は使わない。** Socket.IO のブロードキャストの acknowledgement は、
 *   Redis アダプタに購読者数を問い合わせ、その失敗を受け取らない（`BroadcastOperator#emit` の `serverCount().then`）。
 *   Valkey が止まっている間に使うと未処理の reject になり、タスクが落ちる（確かめた。要件定義書 4.2「未処理の例外にしない」）。
 *   接続ごとの acknowledgement はアダプタを通らない
 * - **誰が返したかは、送った接続で決まる**（利用者の部屋に入っているのは、認証を通ったその利用者の接続だけである）。返事の中身で利用者を名乗らせない
 * - 他のタスクの接続には、そのタスクに頼んで同じことをしてもらい、受け取った利用者を返してもらう（サーバー間の通知の acknowledgement。
 *   失敗はアダプタの中で閉じ、答えが無ければ `REMOTE_ANSWER_LIMIT_MS` で打ち切る）。**Valkey が止まっている間は、手元の接続の分だけになる**（4.2 の代償）
 * - 送る相手がそのチャンネルの参加者であることは、呼ぶ側が確かめてから渡す（5.2）
 */
@Injectable()
export class HereReceipts implements OnApplicationBootstrap {
  constructor(private readonly gateway: RealtimeGateway) {}

  onApplicationBootstrap(): void {
    this.gateway.server.on(
      COLLECT,
      (request: CollectRequest, answer: (received: string[]) => void) => {
        void this.local(request).then(answer);
      },
    );
  }

  async collect(payload: HereMentionPayload, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const request: CollectRequest = { payload, userIds: [...userIds] };
    const [local, remote] = await Promise.all([this.local(request), this.remote(request)]);
    return new Set([...local, ...remote].filter((userId) => userIds.includes(userId)));
  }

  /** このタスクの接続で確かめる。 */
  private async local({ payload, userIds }: CollectRequest): Promise<string[]> {
    const namespace = this.gateway.server.sockets;
    const answers = await Promise.all(
      userIds.map(async (userId) => {
        const sockets = [...(namespace.adapter.rooms.get(userRoom(userId)) ?? [])].flatMap(
          (id) => namespace.sockets.get(id) ?? [],
        );
        const receipts = await Promise.all(
          sockets.map((socket) =>
            socket
              .timeout(HERE_RECEIPT_TIMEOUT_MS)
              .emitWithAck(HERE_MENTION_NOTICE, payload)
              .then(
                (receipt: HereMentionReceipt | undefined) => receipt?.received === true,
                () => false,
              ),
          ),
        );
        return receipts.includes(true) ? [userId] : [];
      }),
    );
    return answers.flat();
  }

  /** 他のタスクに頼む。答えが揃わなくても、届いた分は使う。 */
  private remote(request: CollectRequest): Promise<string[]> {
    return new Promise((resolve) => {
      const limit = setTimeout(() => resolve([]), REMOTE_ANSWER_LIMIT_MS);
      this.gateway.server.serverSideEmit(
        COLLECT,
        request,
        (_error: Error | null, answers: string[][] | undefined) => {
          clearTimeout(limit);
          resolve((answers ?? []).flat());
        },
      );
    });
  }
}
