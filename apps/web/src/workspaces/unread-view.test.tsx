import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, USER } from '../testing/fake-api';
import {
  CHANNEL_PATH,
  channelWithUnread,
  GENERAL,
  MESSAGES,
  message,
  page,
  READ,
  routes,
  SENT_AT,
  SETTINGS,
  type TestMessage,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

const WORKSPACE_PATH = `/workspaces/${WORKSPACE_ID}`;
const CHANNELS = `GET /api/workspaces/${WORKSPACE_ID}/channels`;

/** 偽の fetch の応答（`fakeFetch` の Handler と同じ形）。送った本体を `mock.calls` から読むために、署名を型で与える。 */
type Handler = (init: RequestInit) => Response;

// 機能一覧 10.1（F-23）: 未読の画面。サイドバーの太字・「ここから未読」の区切り線・既読の更新・設定の切り替え。#509。
describe('未読の画面（F-23）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('サイドバーの未読', () => {
    it('未読のあるチャンネルは太字で、件数を文字でも出す', async () => {
      fakeFetch(routes({ [CHANNELS]: () => json(200, [channelWithUnread({ unread: 3 })]) }));

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).getByText(/未読 3 件/)).toBeDefined();
      // **太字は装飾であり、支援技術には伝わらない**ので、件数は文字でも出す（上の行）。
      // 太字そのものは、未読があるチャンネルにだけ付ける
      expect(item.querySelector('.font-bold')).not.toBeNull();
    });

    it('未読が 0 のチャンネルは太字にせず、件数も出さない', async () => {
      fakeFetch(routes({ [CHANNELS]: () => json(200, [channelWithUnread({ unread: 0 })]) }));

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).queryByText(/未読/)).toBeNull();
      expect(item.querySelector('.font-bold')).toBeNull();
    });

    it('参加していないチャンネルには未読を出さない', async () => {
      // **未読の値が入っていても出さない。** api は参加していないチャンネルの未読を常に 0 で返すが、
      // 画面はその値に頼らず、参加しているかどうかで決める（機能一覧 10.1）
      const notJoined = { ...channelWithUnread({ unread: 3 }), joined: false };
      fakeFetch(routes({ [CHANNELS]: () => json(200, [notJoined]) }));

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).queryByText(/未読/)).toBeNull();
    });
  });

  // 機能一覧 10.2（F-24）: 自分宛のメンションの件数を、画面内のバッジで出す。**ブラウザ通知の許可によらず出す。** #516。
  describe('メンションのバッジ（F-24）', () => {
    it('メンションのあるチャンネルに、件数のバッジを文字で出す', async () => {
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread({ unread: 3, mentions: 2 })]),
        }),
      );

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).getByText(/メンション 2 件/)).toBeDefined();
    });

    it('メンションが 0 なら、未読があってもバッジを出さない', async () => {
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread({ unread: 3, mentions: 0 })]),
        }),
      );

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).getByText(/未読 3 件/)).toBeDefined();
      expect(within(item).queryByText(/メンション/)).toBeNull();
    });

    it('参加していないチャンネルにはバッジを出さない', async () => {
      const notJoined = {
        ...channelWithUnread({ unread: 3, mentions: 2 }),
        joined: false,
      };
      fakeFetch(routes({ [CHANNELS]: () => json(200, [notJoined]) }));

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).queryByText(/メンション/)).toBeNull();
    });

    it('unread:updated を受けて、一覧を読み直さずにメンションの件数を差し替える', async () => {
      const channels = vi.fn<Handler>(() =>
        json(200, [channelWithUnread({ unread: 1, mentions: 0 })]),
      );
      fakeFetch(routes({ [CHANNELS]: channels }));

      const { sockets } = renderApp(WORKSPACE_PATH);
      const item = await screen.findByRole('listitem');
      expect(within(item).queryByText(/メンション/)).toBeNull();
      const calls = channels.mock.calls.length;

      sockets[0]?.deliver('unread:updated', {
        channelId: GENERAL.id,
        unread: 2,
        mentions: 1,
        sentAt: '2026-09-16T00:00:00.000Z',
      });

      expect(await screen.findByText(/メンション 1 件/)).toBeDefined();
      expect(channels.mock.calls.length).toBe(calls);

      // 既読を進めて 0 が届けば、バッジは消える
      sockets[0]?.deliver('unread:updated', {
        channelId: GENERAL.id,
        unread: 0,
        mentions: 0,
        sentAt: '2026-09-16T00:00:01.000Z',
      });
      await waitFor(() => expect(screen.queryByText(/メンション/)).toBeNull());
    });
  });

  describe('「ここから上が未読」の区切り線', () => {
    it('開いた時点の既読位置の次のメッセージの下に出し、読み進めても動かさない（上が新しい並び。#608）', async () => {
      const older = message(1);
      const newer = message(2);
      fakeFetch(
        routes({
          [CHANNELS]: () =>
            json(200, [channelWithUnread({ unread: 1, lastReadMessageId: older.id })]),
          [`GET ${MESSAGES}`]: () => page([newer, older]),
        }),
      );

      renderApp(CHANNEL_PATH);

      // **区切り線は装飾ではなく境目**なので、支援技術にも分かれ目として渡す（`separator`）
      await screen.findByRole('separator', { name: 'ここから上が未読' });
      // 線は「既読位置の次のメッセージ」の下に出る（上が新しい並び）。並びは DOM の順で読む
      const texts = [...document.querySelectorAll('article, [role="separator"]')].map(
        (node) => node.textContent ?? '',
      );
      const dividerAt = texts.findIndex((text) => text.includes('ここから上が未読'));
      expect(dividerAt).toBeGreaterThan(-1);
      expect(texts[dividerAt - 1] ?? '').toContain('メッセージ 2');
      expect(texts[dividerAt + 1] ?? '').toContain('メッセージ 1');
    });

    it('一覧を取り直して既読位置が進んでも、開いている間は線が動かない', async () => {
      const older = message(1);
      const newer = message(2);
      // 2回目の取得では、既読位置が最新まで進んでいる（別の端末で読んだ場合など）
      const { count } = fakeFetch(
        routes({
          [CHANNELS]: [
            () => json(200, [channelWithUnread({ unread: 1, lastReadMessageId: older.id })]),
            () => json(200, [channelWithUnread({ unread: 0, lastReadMessageId: newer.id })]),
          ],
          [`GET ${MESSAGES}`]: () => page([newer, older]),
        }),
      );

      renderApp(CHANNEL_PATH);
      await screen.findByRole('separator', { name: 'ここから上が未読' });

      // 画面に戻ったときの取り直し。**TanStack Query は `window` の `visibilitychange` を購読する**
      // （@tanstack/query-core の focusManager。`document` に投げても届かない）
      fireEvent(window, new Event('visibilitychange'));
      await waitFor(() => expect(count(CHANNELS)).toBe(2));

      const texts = [...document.querySelectorAll('article, [role="separator"]')].map(
        (node) => node.textContent ?? '',
      );
      const dividerAt = texts.findIndex((text) => text.includes('ここから上が未読'));
      expect(texts[dividerAt - 1] ?? '').toContain('メッセージ 2');
    });

    // **既読位置をまだ持たないチャンネルでは、参加した時点より後の最初の上に出す**（機能一覧 10.1・openapi の Channel.lastReadMessageId）。
    // **参加した直後に初めて開いたチャンネルは全部が未読**であり、線がいちばん要る場面である
    it('既読位置を持たないチャンネルでは、参加した時点より後の最初の下に出す', async () => {
      const before = message(1);
      const after = message(2);
      fakeFetch(
        routes({
          // 参加したのは 1 件目と 2 件目の間
          [CHANNELS]: () =>
            json(200, [
              channelWithUnread({ unread: 1, lastReadMessageId: null, joinedAt: after.createdAt }),
            ]),
          [`GET ${MESSAGES}`]: () => page([after, before]),
        }),
      );

      renderApp(CHANNEL_PATH);

      await screen.findByRole('separator', { name: 'ここから上が未読' });
      const texts = [...document.querySelectorAll('article, [role="separator"]')].map(
        (node) => node.textContent ?? '',
      );
      const dividerAt = texts.findIndex((text) => text.includes('ここから上が未読'));
      // 参加する前のメッセージは線の下（既読の側）に置く
      expect(texts[dividerAt - 1] ?? '').toContain('メッセージ 2');
      expect(texts[dividerAt + 1] ?? '').toContain('メッセージ 1');
    });

    it('自分の投稿は未読に数えないので、線も自分の投稿を飛ばして、他人の未読のうち最も古いものの下に出す', async () => {
      const older = message(1);
      const mine = message(2, { author: USER });
      const newer = message(3);
      fakeFetch(
        routes({
          [CHANNELS]: () =>
            json(200, [channelWithUnread({ unread: 1, lastReadMessageId: older.id })]),
          [`GET ${MESSAGES}`]: () => page([newer, mine, older]),
        }),
      );

      renderApp(CHANNEL_PATH);

      await screen.findByRole('separator', { name: 'ここから上が未読' });
      const texts = [...document.querySelectorAll('article, [role="separator"]')].map(
        (node) => node.textContent ?? '',
      );
      const dividerAt = texts.findIndex((text) => text.includes('ここから上が未読'));
      expect(texts[dividerAt - 1] ?? '').toContain('メッセージ 3');
      expect(texts[dividerAt + 1] ?? '').toContain('メッセージ 2');
    });

    it('既読位置より後が自分の投稿だけなら、線を出さない', async () => {
      const older = message(1);
      const mine = message(2, { author: USER });
      fakeFetch(
        routes({
          [CHANNELS]: () =>
            json(200, [channelWithUnread({ unread: 0, lastReadMessageId: older.id })]),
          [`GET ${MESSAGES}`]: () => page([mine, older]),
        }),
      );

      renderApp(CHANNEL_PATH);

      await screen.findByText('メッセージ 2');
      expect(screen.queryByRole('separator', { name: 'ここから上が未読' })).toBeNull();
    });

    it('既読位置も参加した時刻も無ければ線を出さない', async () => {
      fakeFetch(
        routes({
          [CHANNELS]: () =>
            json(200, [
              {
                ...channelWithUnread({ unread: 0, lastReadMessageId: null, joinedAt: null }),
                joined: true,
              },
            ]),
          [`GET ${MESSAGES}`]: () => page([message(1)]),
        }),
      );

      renderApp(CHANNEL_PATH);

      await screen.findByText('メッセージ 1');
      expect(screen.queryByRole('separator', { name: 'ここから上が未読' })).toBeNull();
    });
  });

  describe('既読の更新', () => {
    it('最新のページを読み込んだら、いちばん新しい本体の id で既読位置を進める', async () => {
      const older = message(1);
      const newer = message(2);
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread({ unread: 2, lastReadMessageId: null })]),
          [`GET ${MESSAGES}`]: () => page([newer, older]),
          [`PUT ${READ}`]: read,
        }),
      );

      renderApp(CHANNEL_PATH);

      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(String(read.mock.calls[0]?.[0]?.body)) as {
        lastReadMessageId: string;
      };
      expect(sent.lastReadMessageId).toBe(newer.id);
    });

    it('返信が最新でも、既読位置は本体の id で進める', async () => {
      const body = message(1);
      // 返信はスレッドごとに別の既読位置を持つため、チャンネルの既読位置には渡さない（機能一覧 10.1）
      const reply = message(2, { parentId: body.id });
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread({ unread: 2, lastReadMessageId: null })]),
          [`GET ${MESSAGES}`]: () => page([reply, body]),
          [`PUT ${READ}`]: read,
        }),
      );

      renderApp(CHANNEL_PATH);

      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(String(read.mock.calls[0]?.[0]?.body)) as {
        lastReadMessageId: string;
      };
      expect(sent.lastReadMessageId).toBe(body.id);
    });

    // **一覧の api は削除済みも返すが、既読の更新は削除済みの id を受け取らない**（404 を返す）。
    // 最後の投稿が消されただけで既読が進まなくなると、読んでもそのチャンネルは未読のまま残る（機能一覧 10.1・4.2）
    it('いちばん新しい本体が削除済みなら、その1つ前の本体の id で進める', async () => {
      const kept = message(1);
      const removed = message(2, { body: null, deleted: true });
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread({ unread: 2, lastReadMessageId: null })]),
          [`GET ${MESSAGES}`]: () => page([removed, kept]),
          [`PUT ${READ}`]: read,
        }),
      );

      renderApp(CHANNEL_PATH);

      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(String(read.mock.calls[0]?.[0]?.body)) as {
        lastReadMessageId: string;
      };
      expect(sent.lastReadMessageId).toBe(kept.id);
    });

    it('本体がすべて削除済みなら、既読を進めない（api が断る id を送らない）', async () => {
      const removed = message(1, { body: null, deleted: true });
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread({ unread: 1, lastReadMessageId: null })]),
          [`GET ${MESSAGES}`]: () => page([removed]),
          [`PUT ${READ}`]: read,
        }),
      );

      renderApp(CHANNEL_PATH);

      await screen.findByText('このメッセージは削除されました');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(read).not.toHaveBeenCalled();
    });

    it('同じ位置を繰り返し送らない', async () => {
      const only = message(1);
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread({ unread: 1, lastReadMessageId: null })]),
          [`GET ${MESSAGES}`]: () => page([only]),
          [`PUT ${READ}`]: read,
        }),
      );

      renderApp(CHANNEL_PATH);

      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      // 一覧が再描画されても、位置が変わらないうちは送り直さない
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  // **返信の未読はスレッドの既読位置で決まる**（機能一覧 10.1）。既定の設定は「含める」なので、
  // スレッドを開いて読んでも位置を進めなければ、返信の未読はいつまでも消えない。#546。
  describe('スレッドの既読の更新', () => {
    function reply(n: number, parent: TestMessage, overrides: Record<string, unknown> = {}) {
      return message(n, { parentId: parent.id, body: `返信 ${n}`, ...overrides });
    }
    const repliesOf = (parent: TestMessage) => `${MESSAGES}/${parent.id}/replies`;
    const threadReadOf = (parent: TestMessage) => `${MESSAGES}/${parent.id}/read`;
    const sentId = (handler: ReturnType<typeof vi.fn<Handler>>, index: number) =>
      (JSON.parse(String(handler.mock.calls[index]?.[0]?.body)) as { lastReadMessageId: string })
        .lastReadMessageId;

    it('スレッドを開いて返信を読み込んだら、いちばん新しい返信の id でスレッドの既読位置を進める', async () => {
      const parent = message(1, { replyCount: 2 });
      const newer = reply(3, parent);
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [`GET ${MESSAGES}`]: () => page([parent]),
          [`GET ${repliesOf(parent)}`]: () => page([newer, reply(2, parent)]),
          [`PUT ${threadReadOf(parent)}`]: read,
        }),
      );

      renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);

      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(sentId(read, 0)).toBe(newer.id);
    });

    it('いちばん新しい返信が削除済みなら、その1つ前の返信の id で進める（api が断る id を送らない）', async () => {
      const parent = message(1, { replyCount: 2 });
      const kept = reply(2, parent);
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [`GET ${MESSAGES}`]: () => page([parent]),
          [`GET ${repliesOf(parent)}`]: () =>
            page([reply(3, parent, { body: null, deleted: true }), kept]),
          [`PUT ${threadReadOf(parent)}`]: read,
        }),
      );

      renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);

      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(sentId(read, 0)).toBe(kept.id);
    });

    it('返信がすべて削除済みなら、スレッドの既読を進めない', async () => {
      const parent = message(1, { replyCount: 1 });
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [`GET ${MESSAGES}`]: () => page([parent]),
          [`GET ${repliesOf(parent)}`]: () =>
            page([reply(2, parent, { body: null, deleted: true })]),
          [`PUT ${threadReadOf(parent)}`]: read,
        }),
      );

      renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);

      const thread = within(await screen.findByRole('region', { name: 'スレッド' }));
      await thread.findByText('このメッセージは削除されました');
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(read).not.toHaveBeenCalled();
    });

    it('同じ位置を繰り返し送らず、開いている間に届いた返信まで進める', async () => {
      const parent = message(1, { replyCount: 1 });
      const first = reply(2, parent);
      const arrived = reply(3, parent);
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [`GET ${MESSAGES}`]: () => page([parent]),
          [`GET ${repliesOf(parent)}`]: () => page([first]),
          [`PUT ${threadReadOf(parent)}`]: read,
        }),
      );

      const { sockets } = renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(read).toHaveBeenCalledTimes(1);

      act(() => sockets.at(-1)?.deliver('message:new', { message: arrived, sentAt: SENT_AT }));

      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      expect(sentId(read, 1)).toBe(arrived.id);
    });

    it('別のスレッドに切り替えたら、切り替えた先の親のスレッドの既読位置を進める', async () => {
      const first = message(1, { replyCount: 1 });
      const second = message(5, { replyCount: 1 });
      const firstRead = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      const secondRead = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [`GET ${MESSAGES}`]: () => page([second, first]),
          [`GET ${repliesOf(first)}`]: () => page([reply(2, first)]),
          [`GET ${repliesOf(second)}`]: () => page([reply(6, second)]),
          [`PUT ${threadReadOf(first)}`]: firstRead,
          [`PUT ${threadReadOf(second)}`]: secondRead,
        }),
      );

      renderApp(CHANNEL_PATH);
      const list = within(await screen.findByRole('region', { name: 'メッセージの一覧' }));
      const openFrom = async (body: string) =>
        fireEvent.click(
          within((await list.findByText(body)).closest('article')!).getByRole('button', {
            name: '1件の返信',
          }),
        );

      await openFrom('メッセージ 1');
      await waitFor(() => expect(firstRead).toHaveBeenCalledTimes(1));
      await openFrom('メッセージ 5');

      await waitFor(() => expect(secondRead).toHaveBeenCalledTimes(1));
      expect(sentId(secondRead, 0)).toBe(reply(6, second).id);
      expect(firstRead).toHaveBeenCalledTimes(1);
    });
  });

  describe('設定の切り替え', () => {
    it('スレッドの未読を含めるかを切り替えると、api に送る', async () => {
      const update = vi.fn<Handler>(() => json(200, { threadUnreadIncluded: false }));
      fakeFetch(routes({ [`PATCH ${SETTINGS}`]: update }));

      // **設定はプロフィールにもワークスペースにも混ぜず、独立した画面に置く**（機能一覧 10.1）
      renderApp('/settings');

      const toggle = (await screen.findByRole('checkbox', {
        name: 'スレッドの未読をチャンネルの未読に含める',
      })) as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      fireEvent.click(toggle);

      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(String(update.mock.calls[0]?.[0]?.body)) as {
        threadUnreadIncluded: boolean;
      };
      expect(sent.threadUnreadIncluded).toBe(false);
    });
  });

  describe('配信の反映', () => {
    it('unread:updated を受けて、一覧を読み直さずに未読数を差し替える', async () => {
      // **配信は宛先のチャンネルにだけ当てる**ので、もう1つ置いて巻き添えを見る
      const other = { ...GENERAL, id: '01920000-0000-7000-8000-0000000000c2', name: 'random' };
      const channels = vi.fn<Handler>(() => json(200, [channelWithUnread({ unread: 0 }), other]));
      fakeFetch(routes({ [CHANNELS]: channels }));

      const { sockets } = renderApp(WORKSPACE_PATH);
      await screen.findAllByRole('listitem');
      const calls = channels.mock.calls.length;

      // **サーバーが配った**を起こす（`emit` は画面からサーバーへ送る側であり、向きが逆になる）
      sockets[0]?.deliver('unread:updated', {
        channelId: GENERAL.id,
        unread: 2,
        mentions: 0,
        sentAt: '2026-09-16T00:00:00.000Z',
      });

      expect(await screen.findByText(/未読 2 件/)).toBeDefined();
      // 宛先でないチャンネルは動かない
      const items = screen.getAllByRole('listitem');
      expect(within(items[1]!).queryByText(/未読/)).toBeNull();
      // **一覧は読み直さない**（技術スタックの「データ取得」。キャッシュを差し替える）
      expect(channels.mock.calls.length).toBe(calls);
    });
  });
});
