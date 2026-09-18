import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, USER } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  page,
  routes,
  WORKSPACE,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 2.2（F-08）: プライベートチャンネルへの招待の web。#548。

const CHANNELS = `GET /api/workspaces/${WORKSPACE_ID}/channels`;
const MEMBERS = `GET /api/workspaces/${WORKSPACE_ID}/members`;
const CHANNEL_MEMBERS = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/members`;
const MANAGED = `GET /api/workspaces/${WORKSPACE_ID}/managed-channels`;
const SECRET = { ...GENERAL, name: 'secret', visibility: 'PRIVATE' };

/** テストで使う3人目の利用者（実在の人物ではない）。 */
const CAROL = {
  id: '01920000-0000-7000-8000-000000000003',
  userId: 'carol',
  displayName: 'キャロル',
};
const WORKSPACE_MEMBERS = [
  { ...USER, role: 'OWNER' },
  { ...BOB, role: 'MEMBER' },
  { ...CAROL, role: 'MEMBER' },
];

/** 初回だけ返し、取り直しは返さない応答——キャッシュの一覧が、取り直しを待つ間にどう描かれるかを見るため。 */
function onceThenNever(first: () => Response) {
  let calls = 0;
  return () => (calls++ === 0 ? first() : new Promise<Response>(() => {}));
}

/** プライベートチャンネル（ログインしている利用者とボブが参加）の画面を描く偽物。メッセージの一覧は空で返す。 */
function privateRoutes(extra: Parameters<typeof routes>[0] = {}) {
  return routes({
    [CHANNELS]: () => json(200, [SECRET]),
    [`GET ${MESSAGES}`]: () => page([]),
    [MEMBERS]: () => json(200, WORKSPACE_MEMBERS),
    [`GET ${CHANNEL_MEMBERS}`]: onceThenNever(() => json(200, [USER, BOB])),
    ...extra,
  });
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function openCandidates() {
  fireEvent.click(await screen.findByRole('button', { name: 'メンバーを招待する' }));
  return within(await screen.findByRole('list', { name: '招待できるメンバー' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('プライベートチャンネルへの招待（F-08）', () => {
  it('押したときにだけメンバーと参加者を読み、参加していないメンバーだけを候補に並べる', async () => {
    const { count } = fakeFetch(privateRoutes());
    renderApp(CHANNEL_PATH);
    await screen.findByRole('button', { name: 'メンバーを招待する' });
    await pause();
    expect(count(MEMBERS)).toBe(0);
    expect(count(`GET ${CHANNEL_MEMBERS}`)).toBe(0);

    const candidates = await openCandidates();

    expect(candidates.getByText('キャロル @carol')).toBeDefined();
    expect(candidates.queryByText(/ボブ/)).toBeNull();
    expect(candidates.queryByText(new RegExp(USER.displayName))).toBeNull();
  });

  it('絞り込みの入力で、ユーザーID か表示名に当たるメンバーだけを、先頭一致を上に並べる（#616）', async () => {
    const DAVE = {
      id: '01920000-0000-7000-8000-000000000004',
      userId: 'dave_car',
      displayName: 'デイブ',
    };
    const ELLE = {
      id: '01920000-0000-7000-8000-000000000005',
      userId: 'elle',
      displayName: 'carさん',
    };
    fakeFetch(
      privateRoutes({
        [MEMBERS]: () =>
          json(200, [
            ...WORKSPACE_MEMBERS,
            { ...DAVE, role: 'MEMBER' },
            { ...ELLE, role: 'MEMBER' },
          ]),
      }),
    );
    renderApp(CHANNEL_PATH);
    const candidates = await openCandidates();
    expect(candidates.getAllByRole('listitem')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('名前かユーザーID で絞り込む'), {
      target: { value: 'CAR' },
    });

    expect(
      within(screen.getByRole('list', { name: '招待できるメンバー' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('キャロル @carol'),
      expect.stringContaining('carさん @elle'),
      expect.stringContaining('デイブ @dave_car'),
    ]);
  });

  it('パブリックチャンネルには招待を出さない（自由に参加できる）', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([]) }));
    renderApp(CHANNEL_PATH);
    await screen.findByRole('heading', { name: '# general' });
    await pause();

    expect(screen.queryByRole('button', { name: 'メンバーを招待する' })).toBeNull();
  });

  it('招待すると memberId を送り、取り直しを待たずに候補から外して参加者の一覧に足す', async () => {
    const invite = vi.fn<(init: RequestInit) => Response>(
      () => new Response(null, { status: 204 }),
    );
    fakeFetch(privateRoutes({ [`POST ${CHANNEL_MEMBERS}`]: invite }));
    renderApp(CHANNEL_PATH);

    const candidates = await openCandidates();
    fireEvent.click(candidates.getByRole('button', { name: 'キャロル を招待する' }));

    expect(await screen.findByText('招待できるメンバーはいません。')).toBeDefined();
    const sent = JSON.parse(String(invite.mock.calls[0]?.[0]?.body)) as { memberId: string };
    expect(sent.memberId).toBe(CAROL.id);
    fireEvent.click(screen.getByRole('button', { name: '参加者を見る' }));
    const members = within(await screen.findByRole('list', { name: '参加者' }));
    expect(members.getByText('キャロル @carol')).toBeDefined();
  });

  it('断られたら理由を出す', async () => {
    fakeFetch(
      privateRoutes({ [`POST ${CHANNEL_MEMBERS}`]: () => error(409, 'already_channel_member') }),
    );
    renderApp(CHANNEL_PATH);

    const candidates = await openCandidates();
    fireEvent.click(candidates.getByRole('button', { name: 'キャロル を招待する' }));

    expect(await screen.findByRole('alert')).toBeDefined();
  });

  it('読み込めなければ理由を出す', async () => {
    fakeFetch(privateRoutes({ [MEMBERS]: () => error(500, 'internal_error') }));
    renderApp(CHANNEL_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'メンバーを招待する' }));

    expect((await screen.findByRole('alert')).textContent).toContain('読み込めませんでした');
  });

  // 管理用の一覧（F-35）の「参加者 N 人」は、招待した分だけ増える。**開き直したときの取り直しは返さない。**
  it('オーナーが招待したら、管理用の一覧のそのチャンネルの人数を、取り直しを待たずに1人増やす', async () => {
    const managed = {
      id: SECRET.id,
      name: 'secret',
      visibility: 'PRIVATE',
      memberCount: 2,
      archived: false,
    };
    fakeFetch(
      privateRoutes({
        [`GET /api/workspaces/${WORKSPACE_ID}`]: () => json(200, { ...WORKSPACE, role: 'OWNER' }),
        [MANAGED]: onceThenNever(() => json(200, [managed])),
        [`POST ${CHANNEL_MEMBERS}`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(`/workspaces/${WORKSPACE_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'チャンネルを管理する' }));
    expect(await screen.findByText('参加者 2 人')).toBeDefined();

    fireEvent.click(await screen.findByRole('link', { name: '# secret（プライベート）' }));
    const candidates = await openCandidates();
    fireEvent.click(candidates.getByRole('button', { name: 'キャロル を招待する' }));
    await screen.findByText('招待できるメンバーはいません。');
    fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));
    fireEvent.click(await screen.findByRole('button', { name: 'チャンネルを管理する' }));

    expect(await screen.findByText('参加者 3 人')).toBeDefined();
  });
});
