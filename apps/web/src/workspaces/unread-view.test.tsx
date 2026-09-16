import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../testing/fake-api';
import {
  CHANNEL_PATH,
  channelWithUnread,
  GENERAL,
  MESSAGES,
  message,
  page,
  READ,
  routes,
  SETTINGS,
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
      fakeFetch(routes({ [CHANNELS]: () => json(200, [channelWithUnread(3)]) }));

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).getByText(/未読 3 件/)).toBeDefined();
      // **太字は装飾であり、支援技術には伝わらない**ので、件数は文字でも出す（上の行）。
      // 太字そのものは、未読があるチャンネルにだけ付ける
      expect(item.querySelector('.font-bold')).not.toBeNull();
    });

    it('未読が 0 のチャンネルは太字にせず、件数も出さない', async () => {
      fakeFetch(routes({ [CHANNELS]: () => json(200, [channelWithUnread(0)]) }));

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).queryByText(/未読/)).toBeNull();
      expect(item.querySelector('.font-bold')).toBeNull();
    });

    it('参加していないチャンネルには未読を出さない', async () => {
      // **未読の値が入っていても出さない。** api は参加していないチャンネルの未読を常に 0 で返すが、
      // 画面はその値に頼らず、参加しているかどうかで決める（機能一覧 10.1）
      const notJoined = { ...channelWithUnread(3), joined: false };
      fakeFetch(routes({ [CHANNELS]: () => json(200, [notJoined]) }));

      renderApp(WORKSPACE_PATH);

      const item = await screen.findByRole('listitem');
      expect(within(item).queryByText(/未読/)).toBeNull();
    });
  });

  describe('「ここから未読」の区切り線', () => {
    it('開いた時点の既読位置の次に出し、読み進めても動かさない', async () => {
      const older = message(1);
      const newer = message(2);
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread(1, older.id)]),
          [`GET ${MESSAGES}`]: () => page([newer, older]),
        }),
      );

      renderApp(CHANNEL_PATH);

      // **区切り線は装飾ではなく境目**なので、支援技術にも分かれ目として渡す（`separator`）
      await screen.findByRole('separator', { name: 'ここから未読' });
      // 線は「既読位置の次のメッセージ」の上に出る。並びは DOM の順で読む
      const texts = [...document.querySelectorAll('article, [role="separator"]')].map(
        (node) => node.textContent ?? '',
      );
      const dividerAt = texts.findIndex((text) => text.includes('ここから未読'));
      expect(dividerAt).toBeGreaterThan(-1);
      expect(texts[dividerAt + 1] ?? '').toContain('メッセージ 2');
    });

    it('一覧を取り直して既読位置が進んでも、開いている間は線が動かない', async () => {
      const older = message(1);
      const newer = message(2);
      // 2回目の取得では、既読位置が最新まで進んでいる（別の端末で読んだ場合など）
      const { count } = fakeFetch(
        routes({
          [CHANNELS]: [
            () => json(200, [channelWithUnread(1, older.id)]),
            () => json(200, [channelWithUnread(0, newer.id)]),
          ],
          [`GET ${MESSAGES}`]: () => page([newer, older]),
        }),
      );

      renderApp(CHANNEL_PATH);
      await screen.findByRole('separator', { name: 'ここから未読' });

      // 画面に戻ったときの取り直し。**TanStack Query は `window` の `visibilitychange` を購読する**
      // （@tanstack/query-core の focusManager。`document` に投げても届かない）
      fireEvent(window, new Event('visibilitychange'));
      await waitFor(() => expect(count(CHANNELS)).toBe(2));

      const texts = [...document.querySelectorAll('article, [role="separator"]')].map(
        (node) => node.textContent ?? '',
      );
      const dividerAt = texts.findIndex((text) => text.includes('ここから未読'));
      expect(texts[dividerAt + 1] ?? '').toContain('メッセージ 2');
    });

    // **既読位置をまだ持たないチャンネルでは、参加した時点より後の最初の上に出す**（機能一覧 10.1・openapi の Channel.lastReadMessageId）。
    // **参加した直後に初めて開いたチャンネルは全部が未読**であり、線がいちばん要る場面である
    it('既読位置を持たないチャンネルでは、参加した時点より後の最初の上に出す', async () => {
      const before = message(1);
      const after = message(2);
      fakeFetch(
        routes({
          // 参加したのは 1 件目と 2 件目の間
          [CHANNELS]: () => json(200, [channelWithUnread(1, null, after.createdAt)]),
          [`GET ${MESSAGES}`]: () => page([after, before]),
        }),
      );

      renderApp(CHANNEL_PATH);

      await screen.findByRole('separator', { name: 'ここから未読' });
      const texts = [...document.querySelectorAll('article, [role="separator"]')].map(
        (node) => node.textContent ?? '',
      );
      const dividerAt = texts.findIndex((text) => text.includes('ここから未読'));
      // 参加する前のメッセージの上には出さない
      expect(texts[dividerAt - 1] ?? '').toContain('メッセージ 1');
      expect(texts[dividerAt + 1] ?? '').toContain('メッセージ 2');
    });

    it('既読位置も参加した時刻も無ければ線を出さない', async () => {
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [{ ...channelWithUnread(0, null, null), joined: true }]),
          [`GET ${MESSAGES}`]: () => page([message(1)]),
        }),
      );

      renderApp(CHANNEL_PATH);

      await screen.findByText('メッセージ 1');
      expect(screen.queryByRole('separator', { name: 'ここから未読' })).toBeNull();
    });
  });

  describe('既読の更新', () => {
    it('最新のページを読み込んだら、いちばん新しい本体の id で既読位置を進める', async () => {
      const older = message(1);
      const newer = message(2);
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread(2, null)]),
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
          [CHANNELS]: () => json(200, [channelWithUnread(2, null)]),
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

    it('同じ位置を繰り返し送らない', async () => {
      const only = message(1);
      const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
      fakeFetch(
        routes({
          [CHANNELS]: () => json(200, [channelWithUnread(1, null)]),
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
      const channels = vi.fn<Handler>(() => json(200, [channelWithUnread(0), other]));
      fakeFetch(routes({ [CHANNELS]: channels }));

      const { sockets } = renderApp(WORKSPACE_PATH);
      await screen.findAllByRole('listitem');
      const calls = channels.mock.calls.length;

      // **サーバーが配った**を起こす（`emit` は画面からサーバーへ送る側であり、向きが逆になる）
      sockets[0]?.deliver('unread:updated', {
        channelId: GENERAL.id,
        unread: 2,
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
