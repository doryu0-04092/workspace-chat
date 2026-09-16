import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, USER } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  page,
  WORKSPACE,
  WORKSPACE_ID,
  routes,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

const WORKSPACE_PATH = `/workspaces/${WORKSPACE_ID}`;
const MEMBERS = `/api/workspaces/${WORKSPACE_ID}/members`;
const CHANNEL_MEMBERS = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/members`;
const AS_OWNER = {
  [`GET /api/workspaces/${WORKSPACE_ID}`]: () => json(200, { ...WORKSPACE, role: 'OWNER' }),
};

/** テストで使うメンバー（実在の人物ではない）。アリスはログインしている利用者。 */
const ALICE_AS_OWNER = { ...USER, role: 'OWNER' };
const BOB_AS_MEMBER = { ...BOB, role: 'MEMBER' };

/**
 * チャンネルの画面を描く偽物。**メッセージの一覧は空で返す**——返さないと、メッセージの読み込みが黙って失敗し、
 * その alert が出て、参加者の一覧の失敗の表示と取り違える。
 */
function channelRoutes(extra: Parameters<typeof routes>[0] = {}) {
  return routes({ [`GET ${MESSAGES}`]: () => page([]), ...extra });
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function openList(buttonName: string, listName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return within(await screen.findByRole('list', { name: listName }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 機能一覧 2.2（F-09）: キックの web。#539。
describe('ワークスペースのメンバー（F-06・F-09）', () => {
  it('押すまで読まない。押すと参加した順に、表示名・ユーザーID・役割を出す', async () => {
    const { count, calls } = fakeFetch(
      routes({ [`GET ${MEMBERS}`]: () => json(200, [ALICE_AS_OWNER, BOB_AS_MEMBER]) }),
    );
    renderApp(WORKSPACE_PATH);
    await screen.findByRole('button', { name: 'メンバーを見る' });
    expect(count(`GET ${MEMBERS}`)).toBe(0);

    const list = await openList('メンバーを見る', 'メンバー');

    const items = list.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(items[0]).toContain('アリス');
    expect(items[0]).toContain('@alice');
    expect(items[0]).toContain('オーナー');
    expect(items[1]).toContain('ボブ');
    expect(items[1]).toContain('@bob');
    const read = calls.find((c) => c.key === `GET ${MEMBERS}`)!;
    expect(headerOf(read.init, 'Authorization')).toBe('Bearer t1');
  });

  it('オーナーには自分以外の相手に「キックする」を出し、自分には出さない', async () => {
    fakeFetch(
      routes({ ...AS_OWNER, [`GET ${MEMBERS}`]: () => json(200, [ALICE_AS_OWNER, BOB_AS_MEMBER]) }),
    );
    renderApp(WORKSPACE_PATH);

    const list = await openList('メンバーを見る', 'メンバー');

    expect(list.getByRole('button', { name: 'ボブ をキックする' })).toBeDefined();
    expect(list.queryByRole('button', { name: 'アリス をキックする' })).toBeNull();
  });

  it('メンバーには、誰にも「キックする」を出さない', async () => {
    fakeFetch(routes({ [`GET ${MEMBERS}`]: () => json(200, [ALICE_AS_OWNER, BOB_AS_MEMBER]) }));
    renderApp(WORKSPACE_PATH);

    const list = await openList('メンバーを見る', 'メンバー');

    expect(list.queryByRole('button', { name: /をキックする$/ })).toBeNull();
  });

  it('キックすると、確かめてから api に送り、一覧から外す', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MEMBERS}`]: () => json(200, [ALICE_AS_OWNER, BOB_AS_MEMBER]),
        [`DELETE ${MEMBERS}/${BOB.id}`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openList('メンバーを見る', 'メンバー');

    fireEvent.click(list.getByRole('button', { name: 'ボブ をキックする' }));

    await waitFor(() => expect(list.queryByText(/ボブ/)).toBeNull());
    expect(list.getByText(/アリス/)).toBeDefined();
    expect(confirm).toHaveBeenCalledOnce();
    const kick = calls.find((c) => c.key === `DELETE ${MEMBERS}/${BOB.id}`)!;
    expect(headerOf(kick.init, 'Authorization')).toBe('Bearer t1');
  });

  it('キックの確かめを取り消したら送らない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { count } = fakeFetch(
      routes({ ...AS_OWNER, [`GET ${MEMBERS}`]: () => json(200, [ALICE_AS_OWNER, BOB_AS_MEMBER]) }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openList('メンバーを見る', 'メンバー');

    fireEvent.click(list.getByRole('button', { name: 'ボブ をキックする' }));
    // **要求は非同期で出る**ので、出る分だけ待ってから数える（送ってしまう実装でも、クリックの直後はまだ 0 である）
    await pause();

    expect(count(`DELETE ${MEMBERS}/${BOB.id}`)).toBe(0);
    expect(list.getByText(/ボブ/)).toBeDefined();
  });

  it('キックが断られたら理由を出し、一覧に残す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MEMBERS}`]: () => json(200, [ALICE_AS_OWNER, BOB_AS_MEMBER]),
        [`DELETE ${MEMBERS}/${BOB.id}`]: () => error(403, 'owner_only'),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openList('メンバーを見る', 'メンバー');

    fireEvent.click(list.getByRole('button', { name: 'ボブ をキックする' }));

    expect((await screen.findByRole('alert')).textContent).toContain('オーナーだけが行えます');
    expect(list.getByText(/ボブ/)).toBeDefined();
  });

  it('メンバーの一覧を読めなければ、理由を出す', async () => {
    fakeFetch(routes({ [`GET ${MEMBERS}`]: () => error(500, 'internal_error') }));
    renderApp(WORKSPACE_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'メンバーを見る' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'メンバーを読み込めませんでした',
    );
  });
});

describe('チャンネルの参加者（F-10・F-09）', () => {
  it('押すまで読まない。押すと参加者の表示名とユーザーID を出す', async () => {
    const { count } = fakeFetch(
      channelRoutes({ [`GET ${CHANNEL_MEMBERS}`]: () => json(200, [USER, BOB]) }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByRole('button', { name: '参加者を見る' });
    expect(count(`GET ${CHANNEL_MEMBERS}`)).toBe(0);

    const list = await openList('参加者を見る', '参加者');

    const items = list.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[1]).toContain('ボブ');
    expect(items[1]).toContain('@bob');
  });

  it('オーナーには自分以外の参加者に「チャンネルから外す」を出し、メンバーには出さない', async () => {
    fakeFetch(
      channelRoutes({ ...AS_OWNER, [`GET ${CHANNEL_MEMBERS}`]: () => json(200, [USER, BOB]) }),
    );
    const owner = renderApp(CHANNEL_PATH);
    const ownerList = await openList('参加者を見る', '参加者');
    expect(ownerList.getByRole('button', { name: 'ボブ をチャンネルから外す' })).toBeDefined();
    expect(ownerList.queryByRole('button', { name: 'アリス をチャンネルから外す' })).toBeNull();
    owner.unmount();

    fakeFetch(channelRoutes({ [`GET ${CHANNEL_MEMBERS}`]: () => json(200, [USER, BOB]) }));
    renderApp(CHANNEL_PATH);
    const memberList = await openList('参加者を見る', '参加者');
    expect(memberList.queryByRole('button', { name: /をチャンネルから外す$/ })).toBeNull();
  });

  it('チャンネルから外すと、確かめてから api に送り、一覧から外す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { count } = fakeFetch(
      channelRoutes({
        ...AS_OWNER,
        [`GET ${CHANNEL_MEMBERS}`]: () => json(200, [USER, BOB]),
        [`DELETE ${CHANNEL_MEMBERS}/${BOB.id}`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(CHANNEL_PATH);
    const list = await openList('参加者を見る', '参加者');

    fireEvent.click(list.getByRole('button', { name: 'ボブ をチャンネルから外す' }));

    await waitFor(() => expect(list.queryByText(/ボブ/)).toBeNull());
    expect(count(`DELETE ${CHANNEL_MEMBERS}/${BOB.id}`)).toBe(1);
  });

  it('チャンネルから外す確かめを取り消したら送らない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { count } = fakeFetch(
      channelRoutes({ ...AS_OWNER, [`GET ${CHANNEL_MEMBERS}`]: () => json(200, [USER, BOB]) }),
    );
    renderApp(CHANNEL_PATH);
    const list = await openList('参加者を見る', '参加者');

    fireEvent.click(list.getByRole('button', { name: 'ボブ をチャンネルから外す' }));
    await pause();

    expect(count(`DELETE ${CHANNEL_MEMBERS}/${BOB.id}`)).toBe(0);
  });

  it('参加者の一覧を読めなければ、理由を出す', async () => {
    fakeFetch(channelRoutes({ [`GET ${CHANNEL_MEMBERS}`]: () => error(500, 'internal_error') }));
    renderApp(CHANNEL_PATH);

    fireEvent.click(await screen.findByRole('button', { name: '参加者を見る' }));

    expect(await screen.findByText(/参加者を読み込めませんでした/)).toBeDefined();
  });
});
