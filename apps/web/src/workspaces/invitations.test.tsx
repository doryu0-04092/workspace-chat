import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, PROFILE, token } from '../testing/fake-api';
import { renderApp } from '../testing/render-app';

/** テストで使うワークスペースと利用者（実在の人物ではない）。 */
const OWNED = {
  id: '01920000-0000-7000-8000-0000000000a1',
  name: '開発チーム',
  createdAt: '2026-09-13T00:00:00.000Z',
  role: 'OWNER',
};
const AS_MEMBER = { ...OWNED, role: 'MEMBER' };
const BOOK_CLUB = {
  id: '01920000-0000-7000-8000-0000000000b1',
  name: '読書会',
  createdAt: '2026-09-14T00:00:00.000Z',
  role: 'MEMBER',
};
const INVITATION = {
  id: '01920000-0000-7000-8000-0000000000e1',
  workspace: { id: BOOK_CLUB.id, name: BOOK_CLUB.name },
  invitedBy: {
    id: '01920000-0000-7000-8000-000000000003',
    userId: 'carol',
    displayName: 'キャロル',
  },
  createdAt: '2026-09-16T00:00:00.000Z',
};
const PHOTO_CLUB = {
  id: '01920000-0000-7000-8000-0000000000b2',
  name: '写真部',
  createdAt: '2026-09-14T00:00:00.000Z',
  role: 'MEMBER',
};
const PHOTO = {
  ...INVITATION,
  id: '01920000-0000-7000-8000-0000000000e2',
  workspace: { id: PHOTO_CLUB.id, name: PHOTO_CLUB.name },
};

const INVITATIONS = 'GET /api/invitations';
const session = {
  'POST /api/auth/refresh': () => token('t1'),
  'GET /api/users/me': () => json(200, PROFILE),
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// 機能一覧 2.2（F-08 招待）・F-38（招待の承諾と退出）の web。#532。
describe('招待の通知（F-38）', () => {
  it('未承諾の招待があれば、どの画面でもヘッダーに件数を出し、一覧の画面へのリンクにする', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: () => json(200, [INVITATION]),
      'GET /api/workspaces': () => json(200, []),
      'GET /api/users/me/settings': () => json(200, { threadUnreadIncluded: true }),
    });
    renderApp('/settings');

    const notice = await screen.findByRole('link', { name: '招待 1 件' });
    expect(notice.getAttribute('href')).toBe('/workspaces');
  });

  // **読めなかったことを、どの画面でも黙らない**——ヘッダーが黙ると、チャンネルを見ている利用者には
  // 「招待が無い」と「読めなかった」が同じ見え方になる（一覧の画面は理由を出している。#533 第0巡の 🟡3）。
  it('招待の一覧を読めなければ、どの画面でもヘッダーにそのことを出す', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: () => error(500, 'internal_error'),
      'GET /api/users/me/settings': () => json(200, { threadUnreadIncluded: true }),
    });
    renderApp('/settings');

    expect(await screen.findByText('招待を読み込めませんでした')).toBeDefined();
    expect(screen.queryByRole('link', { name: /招待 \d+ 件/ })).toBeNull();
  });

  it('未承諾の招待が無ければ、ヘッダーに件数を出さない', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: () => json(200, []),
      'GET /api/workspaces': () => json(200, []),
    });
    renderApp('/workspaces');

    await screen.findByText('所属しているワークスペースはありません。');
    expect(screen.queryByRole('link', { name: /招待/ })).toBeNull();
  });

  // **payload を一覧に当てず、取り直す**——payload（`invitationId`・`sentAt`）と一覧の項目（`id`・`createdAt`）の形が違う（#532）。
  it('invitation:new を受けたら招待の一覧を取り直し、件数を増やす', async () => {
    const { count } = fakeFetch({
      ...session,
      [INVITATIONS]: [() => json(200, []), () => json(200, [INVITATION])],
      'GET /api/workspaces': () => json(200, []),
    });
    const { sockets } = renderApp('/workspaces');
    await screen.findByText('所属しているワークスペースはありません。');
    expect(screen.queryByRole('link', { name: /招待/ })).toBeNull();

    sockets[0]?.deliver('invitation:new', {
      invitationId: INVITATION.id,
      workspace: INVITATION.workspace,
      invitedBy: INVITATION.invitedBy,
      sentAt: '2026-09-16T00:00:00.000Z',
    });

    expect(await screen.findByRole('link', { name: '招待 1 件' })).toBeDefined();
    expect(count(INVITATIONS)).toBe(2);
  });
});

describe('届いた招待の承諾と辞退（F-38）', () => {
  it('届いた招待に、ワークスペース名と、招待したオーナーの表示名・ユーザーID を出す', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: () => json(200, [INVITATION]),
      'GET /api/workspaces': () => json(200, []),
    });
    renderApp('/workspaces');

    const list = await screen.findByRole('list', { name: '届いた招待' });
    const item = within(list).getByRole('listitem');
    expect(item.textContent).toContain('読書会');
    expect(item.textContent).toContain('キャロル');
    expect(item.textContent).toContain('@carol');
  });

  it('承諾すると api に送り、招待を消して、そのワークスペースを所属の一覧に並べる', async () => {
    const { calls } = fakeFetch({
      ...session,
      [INVITATIONS]: [() => json(200, [INVITATION]), () => json(200, [])],
      'GET /api/workspaces': [() => json(200, []), () => json(200, [BOOK_CLUB])],
      [`POST /api/invitations/${INVITATION.id}/accept`]: () => json(200, BOOK_CLUB),
    });
    renderApp('/workspaces');
    await screen.findByRole('list', { name: '届いた招待' });

    fireEvent.click(screen.getByRole('button', { name: '読書会 への招待を承諾する' }));

    const joined = await screen.findByRole('link', { name: '読書会' });
    expect(joined.getAttribute('href')).toBe(`/workspaces/${BOOK_CLUB.id}`);
    await waitFor(() => expect(screen.queryByRole('list', { name: '届いた招待' })).toBeNull());
    const accept = calls.find((c) => c.key === `POST /api/invitations/${INVITATION.id}/accept`)!;
    expect(headerOf(accept.init, 'Authorization')).toBe('Bearer t1');
  });

  it('辞退すると api に送り、招待を消す（所属は増えない）', async () => {
    const { count } = fakeFetch({
      ...session,
      [INVITATIONS]: [() => json(200, [INVITATION]), () => json(200, [])],
      'GET /api/workspaces': () => json(200, []),
      [`POST /api/invitations/${INVITATION.id}/decline`]: () => new Response(null, { status: 204 }),
    });
    renderApp('/workspaces');
    await screen.findByRole('list', { name: '届いた招待' });

    fireEvent.click(screen.getByRole('button', { name: '読書会 への招待を辞退する' }));

    await waitFor(() => expect(screen.queryByRole('list', { name: '届いた招待' })).toBeNull());
    expect(count(`POST /api/invitations/${INVITATION.id}/decline`)).toBe(1);
    expect(count('GET /api/workspaces')).toBe(1);
  });

  // **読めなかったことを黙らない**——黙ると、届いている招待が見えないまま、利用者は無いと思い込む。
  it('招待の一覧を読めなければ、理由を出す', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: () => error(500, 'internal_error'),
      'GET /api/workspaces': () => json(200, []),
    });
    renderApp('/workspaces');

    expect((await screen.findByRole('alert')).textContent).toContain(
      '届いた招待を読み込めませんでした',
    );
  });

  it('承諾が断られたら理由を出す', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: () => json(200, [INVITATION]),
      'GET /api/workspaces': () => json(200, []),
      [`POST /api/invitations/${INVITATION.id}/accept`]: () => error(409, 'already_member'),
    });
    renderApp('/workspaces');
    await screen.findByRole('list', { name: '届いた招待' });

    fireEvent.click(screen.getByRole('button', { name: '読書会 への招待を承諾する' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      '既にこのワークスペースのメンバーです',
    );
  });

  // **出す理由は、直前の操作のものだけにする**——承諾と辞退の失敗を合わせて出すため（#534）。
  it('承諾が断られた後に別の招待の辞退が通ったら、承諾の理由を残さない', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: [() => json(200, [INVITATION, PHOTO]), () => json(200, [INVITATION])],
      'GET /api/workspaces': () => json(200, []),
      [`POST /api/invitations/${INVITATION.id}/accept`]: () => error(409, 'already_member'),
      [`POST /api/invitations/${PHOTO.id}/decline`]: () => new Response(null, { status: 204 }),
    });
    renderApp('/workspaces');
    const list = await screen.findByRole('list', { name: '届いた招待' });

    fireEvent.click(screen.getByRole('button', { name: '読書会 への招待を承諾する' }));
    expect(await screen.findByText(/既にこのワークスペースのメンバーです/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '写真部 への招待を辞退する' }));

    await waitFor(() => expect(list.textContent).not.toContain('写真部'));
    expect(screen.queryByText(/既にこのワークスペースのメンバーです/)).toBeNull();
  });

  it('辞退が断られた後に別の招待の承諾が通ったら、辞退の理由を残さない', async () => {
    fakeFetch({
      ...session,
      [INVITATIONS]: [() => json(200, [INVITATION, PHOTO]), () => json(200, [INVITATION])],
      'GET /api/workspaces': [() => json(200, []), () => json(200, [PHOTO_CLUB])],
      [`POST /api/invitations/${INVITATION.id}/decline`]: () => error(404, 'not_found'),
      [`POST /api/invitations/${PHOTO.id}/accept`]: () => json(200, PHOTO_CLUB),
    });
    renderApp('/workspaces');
    const list = await screen.findByRole('list', { name: '届いた招待' });

    fireEvent.click(screen.getByRole('button', { name: '読書会 への招待を辞退する' }));
    expect(await screen.findByText(/見つかりません/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '写真部 への招待を承諾する' }));

    await waitFor(() => expect(list.textContent).not.toContain('写真部'));
    expect(await screen.findByRole('link', { name: '写真部' })).toBeDefined();
    expect(screen.queryByText(/見つかりません/)).toBeNull();
  });
});

describe('ワークスペースへの招待（F-08）', () => {
  function workspaceRoutes(workspace: typeof OWNED) {
    return {
      ...session,
      [INVITATIONS]: () => json(200, []),
      [`GET /api/workspaces/${workspace.id}`]: () => json(200, workspace),
      [`GET /api/workspaces/${workspace.id}/channels`]: () => json(200, []),
      [`GET /api/workspaces/${workspace.id}/dms`]: () => json(200, []),
      // 入力に合わせて候補を読む（#616）。既存の検査が入れる 'bob' には候補を返さない
      [`GET /api/workspaces/${workspace.id}/invitation-candidates?q=bob`]: () => json(200, []),
    };
  }

  /** 招待の候補の問い合わせのキー（#616）。 */
  const candidatesKey = (workspaceId: string, q: string) =>
    `GET /api/workspaces/${workspaceId}/invitation-candidates?${new URLSearchParams({ q })}`;

  /** テストで使う試用の利用者（実在の人物ではない）。 */
  const TRIAL_1 = {
    id: '01920000-0000-7000-8000-0000000000a1',
    userId: 'trial_1',
    displayName: '試用さん1',
  };
  const TRIAL_2 = {
    id: '01920000-0000-7000-8000-0000000000a2',
    userId: 'trial_2',
    displayName: '試用さん2',
  };

  it('招待の入力に一部を入れると候補を出し、押すとその人のユーザーID で招待する（#616）', async () => {
    const { calls } = fakeFetch({
      ...workspaceRoutes(OWNED),
      [candidatesKey(OWNED.id, 'tr')]: () => json(200, [TRIAL_1, TRIAL_2]),
      [`POST /api/workspaces/${OWNED.id}/invitations`]: () =>
        json(201, {
          id: INVITATION.id,
          workspaceId: OWNED.id,
          invitee: TRIAL_2,
          createdAt: '2026-09-18T00:00:00.000Z',
        }),
    });
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    type('招待するユーザーID', 'tr');

    const list = within(await screen.findByRole('list', { name: '招待の候補' }));
    expect(list.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('試用さん1 @trial_1'),
      expect.stringContaining('試用さん2 @trial_2'),
    ]);
    fireEvent.click(list.getByRole('button', { name: '試用さん2（@trial_2）を招待する' }));

    expect((await screen.findByRole('status', { name: '招待の結果' })).textContent).toContain(
      '試用さん2（@trial_2）を招待しました',
    );
    const invite = calls.find((c) => c.key === `POST /api/workspaces/${OWNED.id}/invitations`)!;
    expect(JSON.parse(String(invite.init.body))).toEqual({ userId: 'trial_2' });
    await waitFor(() => expect(screen.queryByRole('list', { name: '招待の候補' })).toBeNull());
  });

  it('表示名（日本語）でも探せ、空白だけでは探さない（#616）', async () => {
    const { calls } = fakeFetch({
      ...workspaceRoutes(OWNED),
      [candidatesKey(OWNED.id, '試用')]: () => json(200, [TRIAL_1]),
    });
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    type('招待するユーザーID', '  ');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.some((c) => c.key.includes('invitation-candidates'))).toBe(false);

    type('招待するユーザーID', '試用');
    const list = within(await screen.findByRole('list', { name: '招待の候補' }));
    expect(list.getByText('試用さん1 @trial_1')).toBeDefined();
  });

  it('候補が無ければ無いことを出す（#616）', async () => {
    fakeFetch({ ...workspaceRoutes(OWNED), [candidatesKey(OWNED.id, 'zzz')]: () => json(200, []) });
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    type('招待するユーザーID', 'zzz');

    expect(await screen.findByText('招待できる利用者は見つかりません。')).toBeDefined();
  });

  it('オーナーには招待のフォームを出し、ユーザーID を送る。招待できたら入力を空にし、招待したことを出す', async () => {
    const { calls } = fakeFetch({
      ...workspaceRoutes(OWNED),
      [`POST /api/workspaces/${OWNED.id}/invitations`]: () =>
        json(201, {
          id: INVITATION.id,
          workspaceId: OWNED.id,
          invitee: {
            id: '01920000-0000-7000-8000-000000000002',
            userId: 'bob',
            displayName: 'ボブ',
          },
          createdAt: '2026-09-16T00:00:00.000Z',
        }),
    });
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    type('招待するユーザーID', 'bob');
    fireEvent.click(screen.getByRole('button', { name: '招待する' }));

    expect((await screen.findByRole('status', { name: '招待の結果' })).textContent).toContain(
      'ボブ（@bob）を招待しました',
    );
    expect((screen.getByLabelText('招待するユーザーID') as HTMLInputElement).value).toBe('');
    const invite = calls.find((c) => c.key === `POST /api/workspaces/${OWNED.id}/invitations`)!;
    expect(JSON.parse(String(invite.init.body))).toEqual({ userId: 'bob' });
  });

  it('メンバーには招待のフォームを出さない', async () => {
    fakeFetch(workspaceRoutes(AS_MEMBER));
    renderApp(`/workspaces/${AS_MEMBER.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    expect(screen.queryByLabelText('招待するユーザーID')).toBeNull();
  });

  it.each([
    { code: 'already_invited', status: 409, text: '既にこの利用者を招待しています' },
    { code: 'already_member', status: 409, text: '既にこのワークスペースのメンバーです' },
    { code: 'invitee_not_found', status: 422, text: 'そのユーザーID の利用者はいません' },
  ])('招待が $code で断られたら理由を出し、入力を残す', async ({ code, status, text }) => {
    fakeFetch({
      ...workspaceRoutes(OWNED),
      [`POST /api/workspaces/${OWNED.id}/invitations`]: () => error(status, code),
    });
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    type('招待するユーザーID', 'bob');
    fireEvent.click(screen.getByRole('button', { name: '招待する' }));

    expect((await screen.findByRole('alert')).textContent).toContain(text);
    expect((screen.getByLabelText('招待するユーザーID') as HTMLInputElement).value).toBe('bob');
  });
});

describe('ワークスペースからの退出（F-38）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // **抜けた利用者は自分では戻れない**ので、送る前に確かめる。確かめを取り消したら送らない。
  it('退出の確かめを取り消したら、api に送らない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { count } = fakeFetch({
      ...session,
      [INVITATIONS]: () => json(200, []),
      [`GET /api/workspaces/${AS_MEMBER.id}`]: () => json(200, AS_MEMBER),
      [`GET /api/workspaces/${AS_MEMBER.id}/channels`]: () => json(200, []),
    });
    renderApp(`/workspaces/${AS_MEMBER.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    fireEvent.click(screen.getByRole('button', { name: 'このワークスペースから退出する' }));
    // **要求は非同期で出る**ので、クリックの直後に数えると、送ってしまう実装でもまだ 0 である。出る分だけ待ってから数える
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(confirm).toHaveBeenCalledOnce();
    expect(count(`POST /api/workspaces/${AS_MEMBER.id}/leave`)).toBe(0);
    expect(screen.getByRole('heading', { name: '開発チーム' })).toBeDefined();
  });

  // **一覧の画面から入り、所属の一覧をキャッシュに載せてから抜ける**——実際の使い方の順である。
  // ワークスペースの画面から始めると、一覧は退出の後に初めて読まれ、抜けたワークスペースが並ばないのは初回の取得の結果になる（#533 第0巡の 🔴1）。
  // **退出の後の一覧の取り直しは返さない**——キャッシュに残った一覧が、取り直しを待つ間に描かれないことを見るため。
  it('メンバーが退出すると api に送り、ワークスペースの一覧へ移る。抜けたワークスペースは、取り直しを待たずに並ばない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { count } = fakeFetch({
      ...session,
      [INVITATIONS]: () => json(200, []),
      'GET /api/workspaces': [
        () => json(200, [AS_MEMBER, BOOK_CLUB]),
        () => new Promise<Response>(() => {}),
      ],
      [`GET /api/workspaces/${AS_MEMBER.id}`]: () => json(200, AS_MEMBER),
      [`GET /api/workspaces/${AS_MEMBER.id}/channels`]: () => json(200, []),
      [`POST /api/workspaces/${AS_MEMBER.id}/leave`]: () => new Response(null, { status: 204 }),
    });
    renderApp('/workspaces');
    fireEvent.click(await screen.findByRole('link', { name: '開発チーム' }));
    await screen.findByRole('heading', { name: '開発チーム' });

    fireEvent.click(screen.getByRole('button', { name: 'このワークスペースから退出する' }));

    // 一覧の画面に戻ったら、残ったワークスペースは並び、抜けたワークスペースは並ばない
    expect(await screen.findByRole('link', { name: '読書会' })).toBeDefined();
    expect(screen.queryByRole('link', { name: '開発チーム' })).toBeNull();
    expect(count(`POST /api/workspaces/${AS_MEMBER.id}/leave`)).toBe(1);
  });

  // 機能一覧 F-38 の受け入れ条件「オーナーが退出しようとすると拒否され、理由が画面に表示される」。
  it('オーナーが退出しようとすると、断られた理由を出して画面に留まる', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fakeFetch({
      ...session,
      [INVITATIONS]: () => json(200, []),
      [`GET /api/workspaces/${OWNED.id}`]: () => json(200, OWNED),
      [`GET /api/workspaces/${OWNED.id}/channels`]: () => json(200, []),
      [`GET /api/workspaces/${OWNED.id}/dms`]: () => json(200, []),
      [`POST /api/workspaces/${OWNED.id}/leave`]: () => error(403, 'owner_cannot_leave'),
    });
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('heading', { name: '開発チーム' });

    fireEvent.click(screen.getByRole('button', { name: 'このワークスペースから退出する' }));

    expect((await screen.findByRole('alert')).textContent).toContain('オーナーは退出できません');
    expect(screen.getByRole('heading', { name: '開発チーム' })).toBeDefined();
  });
});
