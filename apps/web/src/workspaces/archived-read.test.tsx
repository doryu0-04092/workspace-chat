import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, USER } from '../testing/fake-api';
import {
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  WORKSPACE,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 3.2（F-35）: アーカイブ後も参加者は読める。投稿・返信・編集・削除はできない。#552。

const WORKSPACE_PATH = `/workspaces/${WORKSPACE_ID}`;
const CHANNELS = `GET /api/workspaces/${WORKSPACE_ID}/channels`;
const ARCHIVED = `GET /api/workspaces/${WORKSPACE_ID}/archived-channels`;
const MANAGED = `GET /api/workspaces/${WORKSPACE_ID}/managed-channels`;
const ARCHIVED_GENERAL = { ...GENERAL, name: 'general-1' };

/** 初回だけ返し、取り直しは返さない応答——キャッシュの一覧が、取り直しを待つ間にどう描かれるかを見るため。 */
function onceThenNever(first: () => Response) {
  let calls = 0;
  return () => (calls++ === 0 ? first() : new Promise<Response>(() => {}));
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function openArchivedList() {
  fireEvent.click(await screen.findByRole('button', { name: 'アーカイブ済みのチャンネル' }));
  return within(await screen.findByRole('list', { name: 'アーカイブ済みのチャンネル' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('アーカイブ済みのチャンネルを読む（F-35）', () => {
  it('ワークスペースの画面で、押したときにだけ自分が参加しているアーカイブ済みのチャンネルを読み、開けるように並べる', async () => {
    const { count } = fakeFetch(
      routes({
        [CHANNELS]: () => json(200, []),
        [ARCHIVED]: () => json(200, [ARCHIVED_GENERAL]),
        [`GET ${MESSAGES}`]: () => page([]),
      }),
    );
    renderApp(WORKSPACE_PATH);
    await screen.findByRole('button', { name: 'アーカイブ済みのチャンネル' });
    await pause();
    expect(count(ARCHIVED)).toBe(0);

    const list = await openArchivedList();
    fireEvent.click(list.getByRole('link', { name: '# general-1' }));

    expect(await screen.findByRole('heading', { name: '# general-1' })).toBeDefined();
  });

  it('アーカイブ済みのチャンネルが無ければ、無いと出す。読み込めなければ理由を出す', async () => {
    fakeFetch(routes({ [ARCHIVED]: [() => json(200, []), () => error(500, 'internal_error')] }));
    const { unmount } = renderApp(WORKSPACE_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'アーカイブ済みのチャンネル' }));
    expect(await screen.findByText('アーカイブ済みのチャンネルはありません。')).toBeDefined();
    unmount();

    renderApp(WORKSPACE_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'アーカイブ済みのチャンネル' }));
    expect((await screen.findByRole('alert')).textContent).toContain('読み込めませんでした');
  });

  it('アーカイブ済みのチャンネルを開くとメッセージを読め、投稿・返信・編集・削除の操作は出さない（自分のメッセージでも）', async () => {
    const mine = message(1, { author: USER, body: '自分の投稿' });
    const withReplies = message(2, { replyCount: 1 });
    fakeFetch(
      routes({
        [CHANNELS]: () => json(200, []),
        [ARCHIVED]: () => json(200, [ARCHIVED_GENERAL]),
        [`GET ${MESSAGES}`]: () => page([withReplies, mine]),
        [`GET ${MESSAGES}/${withReplies.id}/replies`]: () =>
          page([message(3, { parentId: withReplies.id, author: USER, body: '自分の返信' })]),
      }),
    );
    renderApp(CHANNEL_PATH);

    expect(await screen.findByText('自分の投稿')).toBeDefined();
    expect(screen.getByText(/アーカイブ済み/)).toBeDefined();
    expect(screen.queryByRole('button', { name: '送信する' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /編集/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /削除/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '返信する' })).toBeNull();

    // 返信は読めるが、返信の入力欄・自分の返信の編集と削除は出さない
    fireEvent.click(screen.getByRole('button', { name: '1件の返信' }));
    const thread = within(await screen.findByRole('region', { name: 'スレッド' }));
    expect(await thread.findByText('自分の返信')).toBeDefined();
    expect(thread.queryByRole('textbox')).toBeNull();
    expect(thread.queryByRole('button', { name: /編集|削除|返信を送信する/ })).toBeNull();
  });

  it('一般の一覧にもアーカイブ済みの一覧にも無いチャンネルは、見つからないと出す', async () => {
    fakeFetch(
      routes({
        [CHANNELS]: () => json(200, []),
        [ARCHIVED]: () => json(200, []),
      }),
    );
    renderApp(CHANNEL_PATH);

    expect(await screen.findByText('チャンネルが見つかりません。')).toBeDefined();
  });

  // アーカイブ済みのチャンネルからも抜けられる（機能一覧 3.2）。抜けたら、アーカイブ済みの一覧から**取り直しを待たずに外す**。
  it('アーカイブ済みのチャンネルから抜けたら、アーカイブ済みの一覧から取り直しを待たずに外す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fakeFetch(
      routes({
        [CHANNELS]: () => json(200, []),
        [ARCHIVED]: onceThenNever(() => json(200, [ARCHIVED_GENERAL])),
        [`GET ${MESSAGES}`]: () => page([]),
        [`POST /api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/leave`]: () =>
          new Response(null, { status: 204 }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openArchivedList();
    fireEvent.click(list.getByRole('link', { name: '# general-1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'このチャンネルから抜ける' }));

    await screen.findByRole('button', { name: 'アーカイブ済みのチャンネル' });
    fireEvent.click(screen.getByRole('button', { name: 'アーカイブ済みのチャンネル' }));
    expect(await screen.findByText('アーカイブ済みのチャンネルはありません。')).toBeDefined();
  });

  // 管理用の一覧で復元したら、そのチャンネルはアーカイブ済みの一覧から、**取り直しを待たずに外す**（#533 第0巡の 🔴1）。
  it('オーナーが復元したら、アーカイブ済みの一覧から取り直しを待たずに外す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const managed = {
      id: GENERAL.id,
      name: 'general-1',
      visibility: 'PUBLIC',
      memberCount: 1,
      archived: true,
    };
    fakeFetch(
      routes({
        [`GET /api/workspaces/${WORKSPACE_ID}`]: () => json(200, { ...WORKSPACE, role: 'OWNER' }),
        [CHANNELS]: onceThenNever(() => json(200, [])),
        [ARCHIVED]: onceThenNever(() => json(200, [ARCHIVED_GENERAL])),
        [MANAGED]: () => json(200, [managed]),
        [`POST /api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/restore`]: () =>
          json(200, { ...managed, archived: false }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const archivedList = await openArchivedList();
    expect(archivedList.getByRole('link', { name: '# general-1' })).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: 'チャンネルを管理する' }));
    fireEvent.click(await screen.findByRole('button', { name: 'general-1 を復元する' }));
    await screen.findByRole('button', { name: 'general-1 をアーカイブする' });

    expect(await screen.findByText('アーカイブ済みのチャンネルはありません。')).toBeDefined();
  });
});
