import { fakeFetch, json, PROFILE, token } from './fake-api';

/** メッセージの画面のテストで使う、ワークスペース・チャンネル・利用者（実在の人物ではない）と、api の応答の雛形。 */

export const WORKSPACE_ID = '01920000-0000-7000-8000-0000000000a1';
export const GENERAL = {
  id: '01920000-0000-7000-8000-0000000000c1',
  name: 'general',
  visibility: 'PUBLIC',
  joined: true,
  // 参加した時刻。**既読位置をまだ持たないチャンネルの「ここから未読」の線に要る**（F-23。機能一覧 10.1）。
  // メッセージの雛形（`message(n)` は n 分目）より前に置き、既定ではすべてが参加より後になるようにする
  joinedAt: '2026-09-14T00:00:00.000Z',
  unread: 0,
  mentions: 0,
  lastReadMessageId: null,
};
/** テストで使うワークスペース。参加している側にする（オーナー専用の作成のフォームを出さない）。 */
export const WORKSPACE = {
  id: WORKSPACE_ID,
  name: '開発チーム',
  createdAt: '2026-09-14T00:00:00.000Z',
  role: 'MEMBER',
};
/** テストで使うもう1人の利用者。 */
export const BOB = {
  id: '01920000-0000-7000-8000-000000000002',
  userId: 'bob',
  displayName: 'ボブ',
};
export const SENT_AT = '2026-09-14T00:00:00.000Z';

export const CHANNEL_PATH = `/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}`;
export const MESSAGES = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/messages`;
/** 既読位置の更新（F-23。機能一覧 10.1）。 */
export const READ = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/read`;
/** 利用者ごとの設定（F-23）。 */
export const SETTINGS = '/api/users/me/settings';

/** `n` 番目のメッセージ（REST の Message と同じ形）。id は `n` から作り、作った時刻は `n` 分目にする。 */
export function message(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    channelId: GENERAL.id,
    author: BOB,
    body: `メッセージ ${n}`,
    createdAt: new Date(Date.UTC(2026, 8, 14, 0, n)).toISOString(),
    editedAt: null as string | null,
    deleted: false,
    parentId: null as string | null,
    replyCount: 0,
    replyParticipants: [] as (typeof BOB)[],
    mentions: [] as { userId: string; user: typeof BOB | null }[],
    reactions: [] as { emoji: string; count: number; users: (typeof BOB)[] }[],
    ...overrides,
  };
}

export type TestMessage = ReturnType<typeof message>;

/** 一覧の1ページの応答（新しい順）。 */
export function page(messages: TestMessage[], nextBefore: string | null = null): Response {
  return json(200, { messages, nextBefore });
}

/** ログインを復元し、`GENERAL` に参加している状態の応答。`extra` で足す・置き換える。 */
export function routes(extra: Parameters<typeof fakeFetch>[0] = {}) {
  return {
    'POST /api/auth/refresh': () => token('t1'),
    'GET /api/users/me': () => json(200, PROFILE),
    // ログインした画面の枠が、未承諾の招待の件数を読む（F-38。#532）
    'GET /api/invitations': () => json(200, []),
    [`GET /api/workspaces/${WORKSPACE_ID}`]: () => json(200, WORKSPACE),
    [`GET /api/workspaces/${WORKSPACE_ID}/channels`]: () => json(200, [GENERAL]),
    // ワークスペースの画面が、自分の DM の一覧を読む（F-19。#574）
    [`GET /api/workspaces/${WORKSPACE_ID}/dms`]: () => json(200, []),
    [`GET ${SETTINGS}`]: () => json(200, { threadUnreadIncluded: true }),
    [`PUT ${READ}`]: () => new Response(null, { status: 204 }),
    ...extra,
  };
}

/**
 * 未読のあるチャンネル（F-23。機能一覧 10.1）。
 * 既読位置は `lastReadMessageId`、**既読位置をまだ持たないときの線の境目**は `joinedAt` で渡す。
 */
export function channelWithUnread({
  unread,
  mentions = 0,
  lastReadMessageId = null,
  joinedAt = GENERAL.joinedAt,
}: {
  unread: number;
  mentions?: number;
  lastReadMessageId?: string | null;
  joinedAt?: string | null;
}) {
  return { ...GENERAL, unread, mentions, lastReadMessageId, joinedAt };
}
