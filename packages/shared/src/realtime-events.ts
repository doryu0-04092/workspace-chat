/**
 * WebSocket で配信するイベントの定義。
 *
 * **ここが唯一の定義である。** フロントエンドとバックエンドで別々に書かない
 * （CLAUDE.md 3）。2箇所に書くと、食い違いが実行時まで露見しない。
 *
 * **出所は要件定義書 4.1「リアルタイム配信の対象イベント」の1つだけである**（#9 で機能一覧 5.1 の
 * 重複を消した）。**この並びは realtime-events.test.ts がその表を読んで突き合わせている。**
 * **イベント名は種類より1つ多い**（入力中インジケータが start と stop の
 * 2つの名前を持つため）。文書が「N種類」と数えているのは種類のほうである。
 *
 * **ここに数を書かない。** 検査5（scripts/check-docs.sh）が照合しているのは `.md` の宣言だけで、
 * **この `.ts` は照合の対象に入っていない。** 数を書くと、イベントが増えたときここだけが黙って残る。
 *
 * **踏むと壊れる: ハンドシェイクの `path` は `/api/socket.io/` である**（#77 の決定。機能一覧 5.2）。
 * **サーバー（apps/api/src/realtime/realtime-io.adapter.ts の createIOServer）とクライアント（`io()` の `path` オプション）の両方で、下の `REALTIME_PATH` を渡す。**
 * サーバーは `@WebSocketGateway()` のオプションで渡しても、createIOServer が上書きするため効かない。
 * 既定の `/socket.io/` のままだと、CloudFront が `/api/*` だけを ALB へ振り分けるため ALB に届かず、
 * **アプリ側のログには何も出ない**（`apps/api/src/app.module.ts` の注記と同じ理由）。
 *
 * **踏むと壊れる: クライアントは `transports` を下の `REALTIME_TRANSPORTS`（WebSocket だけ）にする。** socket.io-client の既定は
 * polling（XHR の GET）でハンドシェイクを始めるが、**ブラウザは同一 origin の GET に `Origin` を付けず**（Fetch 標準。付けるのは CORS・
 * WebSocket・GET と HEAD 以外のとき）、サーバーは `Origin` を持たない要求を断る（要件定義書 4.3。CSWSH の対処）。
 * web と api は同じ origin（#77）なので、既定のまま繋ぐとハンドシェイクが 403 で断られ、polling から WebSocket へは落ちない。
 * **代償: polling へのフォールバックが無い**（WebSocket を通さない経路からは繋がらない。機能一覧 5.2）。
 *
 * 配信内容（payload）の型は、**それぞれの機能を実装するときに、
 * その機能と一緒にこのファイルの下へ足す**（先に全部は置かない）。 先に決めると、要件に無い形を作り込むことになる。
 * **サーバーが自発的に配るイベントの payload には、送信時刻を載せる**（要件定義書 4.6 の配信遅延をメトリクスにするため。
 * 決定・2026-09-12・#287）。**その型も、payload の型と一緒に、その機能の実装で足す。**
 *
 * **入室要求・退室要求とその acknowledgement、`@here` の受け取りの返事など、クライアントとサーバーの間でやりとりするものの名前と型も、この package に置く**（機能一覧 9.2。
 * フロントとバックで二重に書かない——CLAUDE.md 3）。**ただし `REALTIME_EVENT_KINDS` / `REALTIME_EVENT_NAMES` には足さない。**
 * この2つは要件定義書 4.1 の配信の対象イベントと突き合わせており（realtime-events.test.ts）、
 * 要求とその応答（acknowledgement）・`@here` の受け取りの返事は、サーバーが自発的に配るイベントではない。**足すときは、この2つとは別の定義として置く。**
 */

import type { components } from './api.gen';

/** ハンドシェイクの `path`（上の「踏むと壊れる」）。サーバーとクライアントはこれを読む。 */
export const REALTIME_PATH = '/api/socket.io/';

/** クライアントの `transports`（上の「踏むと壊れる」）。ブラウザが `Origin` を必ず付ける WebSocket だけで繋ぐ。 */
export const REALTIME_TRANSPORTS = ['websocket'] as const;

/** 配信する変化の種類。文書が「N種類」と数えている単位。 */
export const REALTIME_EVENT_KINDS = [
  'message:new',
  'message:updated',
  'message:deleted',
  'reaction:changed',
  'unread:updated',
  'typing',
  'presence:changed',
  'invitation:new',
] as const;

export type RealtimeEventKind = (typeof REALTIME_EVENT_KINDS)[number];

/** 実際に送受信するイベント名。typing だけが2つに分かれる。 */
export const REALTIME_EVENT_NAMES = [
  'message:new',
  'message:updated',
  'message:deleted',
  'reaction:changed',
  'unread:updated',
  'typing:start',
  'typing:stop',
  'presence:changed',
  'invitation:new',
] as const;

export type RealtimeEventName = (typeof REALTIME_EVENT_NAMES)[number];

/**
 * `invitation:new` の payload（F-08 / F-38。決定・2026-09-12・依頼側。#326）。招待された利用者の部屋へ送る。
 * `sentAt` はサーバーが送った時刻（ISO 8601）——配信遅延を測るため（機能一覧 5.2）。
 */
export type InvitationNewPayload = {
  readonly invitationId: string;
  readonly workspace: { readonly id: string; readonly name: string };
  readonly invitedBy: {
    readonly id: string;
    readonly userId: string;
    readonly displayName: string;
  };
  readonly sentAt: string;
};

/**
 * クライアントからサーバーへの要求の名前（機能一覧 9.2「部屋（Socket.IO の room）」）。**配信の対象イベントではない**ため、
 * 上の `REALTIME_EVENT_KINDS` / `REALTIME_EVENT_NAMES` には入れない。
 * - `channelEnter`: チャンネルを開いたときの入室要求。サーバーが参加者であることを確かめてから、その接続をチャンネルの部屋に入れる
 * - `channelExit`: チャンネルを閉じたときの退室要求
 */
export const REALTIME_REQUESTS = {
  channelEnter: 'channel:enter',
  channelExit: 'channel:exit',
} as const;

/** 入室要求・退室要求の本体。 */
export type ChannelRoomRequest = { readonly channelId: string };

/**
 * 入室要求・退室要求を断ったときの acknowledgement。HTTP と同じ状態コードとエラーの本体を返す
 * （コードは参加者一覧と同じ2段階。入室要求が上限を超えたら 429。本体は REST の ErrorResponse と同じ形。機能一覧 9.2）。
 */
export type ChannelRoomRejection = {
  readonly ok: false;
  readonly status: number;
  readonly error: components['schemas']['ErrorResponse'];
};

/**
 * 入室要求の acknowledgement。入れたら、その時点でその部屋に入っている参加者の利用者 ID
 * （自分と、他のタスクに繋いだ人を含む）を返す（機能一覧 9.2「在席を画面へ渡す経路は、部屋の側だけにする」）。
 */
export type ChannelEnterAck =
  { readonly ok: true; readonly present: readonly string[] } | ChannelRoomRejection;

/** 退室要求の acknowledgement。 */
export type ChannelRoomAck = { readonly ok: true } | ChannelRoomRejection;

/**
 * `presence:changed` の payload（F-22。機能一覧 9.2）。そのチャンネルの部屋へ送る。
 * 利用者の最初の接続が部屋に入ったとき `present: true`、最後の接続が外れたとき `present: false`。
 * `sentAt` はサーバーが送った時刻（ISO 8601）——配信遅延を測るため（機能一覧 5.2）。
 */
export type PresenceChangedPayload = {
  readonly channelId: string;
  readonly userId: string;
  readonly present: boolean;
  readonly sentAt: string;
};
