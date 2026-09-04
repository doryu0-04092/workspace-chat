/**
 * WebSocket で配信するイベントの定義。
 *
 * **ここが唯一の定義である。** フロントエンドとバックエンドで別々に書かない
 * （CLAUDE.md 3）。2箇所に書くと、食い違いが実行時まで露見しない。
 *
 * 出所は要件定義書 4.1「リアルタイム配信の対象イベント」と機能一覧 5.1。
 * **種類は7つだが、イベント名は8つある**（入力中インジケータが start と stop の
 * 2つの名前を持つため）。文書が「7種類」と数えているのは種類のほうである。
 *
 * 配信内容（payload）の型はここに置いていない。**それぞれの機能を実装するときに、
 * その機能と一緒に足す。** 先に決めると、要件に無い形を作り込むことになる。
 */

/** 配信する変化の種類。文書が「7種類」と数えている単位。 */
export const REALTIME_EVENT_KINDS = [
  'message:new',
  'message:updated',
  'message:deleted',
  'reaction:changed',
  'unread:updated',
  'typing',
  'presence:changed',
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
] as const;

export type RealtimeEventName = (typeof REALTIME_EVENT_NAMES)[number];
