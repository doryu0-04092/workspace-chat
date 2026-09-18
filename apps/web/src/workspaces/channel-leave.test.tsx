import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, USER } from '../testing/fake-api';
import {
  BOB,
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

// 機能一覧 2.2（F-10）: チャンネルからの退出の web。#541。

const CHANNELS = `GET /api/workspaces/${WORKSPACE_ID}/channels`;
const LEAVE = `POST /api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/leave`;
const MANAGED = `GET /api/workspaces/${WORKSPACE_ID}/managed-channels`;
const CHANNEL_MEMBERS = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/members`;
const SECRET = { ...GENERAL, name: 'secret', visibility: 'PRIVATE' };

/** メッセージの一覧は空で返す（返さないと、その読み込みの失敗の alert を、退出の失敗と取り違える）。 */
function channelRoutes(extra: Parameters<typeof routes>[0] = {}) {
  return routes({ [`GET ${MESSAGES}`]: () => page([]), ...extra });
}

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('チャンネルからの退出（F-10）', () => {
  it('確かめを取り消したら、api に送らない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { count } = fakeFetch(channelRoutes());
    renderApp(CHANNEL_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'このチャンネルから抜ける' }));
    await pause();

    expect(confirm).toHaveBeenCalledOnce();
    expect(count(LEAVE)).toBe(0);
    expect(screen.getByRole('heading', { name: '# general' })).toBeDefined();
  });

  // **一覧の取り直しは返さない**——抜けたチャンネルが、取り直しを待つ間も参加しているように描かれないことを見る（#533 第0巡の 🔴1 と同じ型）。
  it('パブリックチャンネルから抜けるとワークスペースの画面へ移り、取り直しを待たずに「参加する」に変わる', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { count } = fakeFetch(
      channelRoutes({
        [CHANNELS]: onceThenNever(() => json(200, [GENERAL])),
        [LEAVE]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(CHANNEL_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'このチャンネルから抜ける' }));

    const list = within(await screen.findByRole('list', { name: 'チャンネル' }));
    expect(list.getByRole('button', { name: 'general に参加する' })).toBeDefined();
    expect(list.queryByRole('link', { name: /general/ })).toBeNull();
    expect(count(LEAVE)).toBe(1);
  });

  it('プライベートチャンネルから抜けるときは戻れないことを確かめ、抜けたら取り直しを待たずに一覧から外す', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const other = { ...GENERAL, id: '01920000-0000-7000-8000-0000000000c2', name: 'random' };
    fakeFetch(
      channelRoutes({
        [CHANNELS]: onceThenNever(() => json(200, [other, SECRET])),
        [LEAVE]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(CHANNEL_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'このチャンネルから抜ける' }));

    const list = within(await screen.findByRole('list', { name: 'チャンネル' }));
    expect(list.getByRole('link', { name: '# random' })).toBeDefined();
    expect(list.queryByText(/secret/)).toBeNull();
    expect(confirm.mock.calls[0]?.[0]).toContain('招待');
  });

  it('断られたら理由を出して、チャンネルの画面に留まる', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fakeFetch(channelRoutes({ [LEAVE]: () => error(404, 'not_found') }));
    renderApp(CHANNEL_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'このチャンネルから抜ける' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('heading', { name: '# general' })).toBeDefined();
  });

  // 管理用の一覧（F-35）の行は「参加者 N 人」と参加者の一覧を並べて出す。**抜けたら両方から本人の分を外す**（片方だけだと同じ行で食い違う。#549 第0巡の 🔴1）。
  // **開き直したときの取り直しは返さない**——キャッシュが、取り直しを待つ間に抜ける前のまま描かれないことを見る。
  it('オーナーが抜けたら、管理用の一覧のそのチャンネルの人数と参加者の一覧から、取り直しを待たずに本人を外す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const managed = {
      id: GENERAL.id,
      name: 'general',
      visibility: 'PUBLIC',
      memberCount: 2,
      archived: false,
    };
    fakeFetch(
      channelRoutes({
        [`GET /api/workspaces/${WORKSPACE_ID}`]: () => json(200, { ...WORKSPACE, role: 'OWNER' }),
        [CHANNELS]: onceThenNever(() => json(200, [GENERAL])),
        [MANAGED]: onceThenNever(() => json(200, [managed])),
        [`GET ${CHANNEL_MEMBERS}`]: onceThenNever(() => json(200, [USER, BOB])),
        [LEAVE]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(`/workspaces/${WORKSPACE_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'チャンネルを管理する' }));
    expect(await screen.findByText('参加者 2 人')).toBeDefined();

    fireEvent.click(await screen.findByRole('link', { name: '# general' }));
    // 抜ける前に参加者の一覧を開き、キャッシュに本人を載せる
    fireEvent.click(await screen.findByRole('button', { name: '参加者を見る' }));
    expect(
      await within(await screen.findByRole('list', { name: '参加者' })).findByText('アリス @alice'),
    ).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: 'このチャンネルから抜ける' }));
    await screen.findByRole('button', { name: 'general に参加する' });
    fireEvent.click(await screen.findByRole('button', { name: 'チャンネルを管理する' }));

    expect(await screen.findByText('参加者 1 人')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '参加者を見る' }));
    const members = within(await screen.findByRole('list', { name: '参加者' }));
    expect(members.getByText('ボブ @bob')).toBeDefined();
    expect(members.queryByText('アリス @alice')).toBeNull();
  });

  // 抜けている間はそのチャンネルの配信が届かない。**参加し直して開いたら、メッセージを読み直す**（抜けていた間の投稿を出す）。
  // 参加の取り直しは一般の一覧に `exact` で当てるため（#553）、読み直すのはチャンネルを開いたときである。
  it('抜けてから参加し直して開くと、メッセージを読み直し、抜けていた間の投稿を出す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let joined = true;
    const { count } = fakeFetch(
      routes({
        [CHANNELS]: () => json(200, [{ ...GENERAL, joined }]),
        [`GET ${MESSAGES}`]: [() => page([message(1)]), () => page([message(2), message(1)])],
        [LEAVE]: () => {
          joined = false;
          return new Response(null, { status: 204 });
        },
        [`POST /api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/join`]: () => {
          joined = true;
          return new Response(null, { status: 204 });
        },
      }),
    );
    renderApp(CHANNEL_PATH);
    expect(await screen.findByText('メッセージ 1')).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: 'このチャンネルから抜ける' }));
    fireEvent.click(await screen.findByRole('button', { name: 'general に参加する' }));
    fireEvent.click(await screen.findByRole('link', { name: '# general' }));

    expect(await screen.findByText('メッセージ 2')).toBeDefined();
    expect(count(`GET ${MESSAGES}`)).toBe(2);
  });
});
