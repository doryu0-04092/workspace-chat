import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, PROFILE, token } from '../testing/fake-api';
import { renderApp } from '../testing/render-app';

const OWNED = {
  id: '01920000-0000-7000-8000-0000000000a1',
  name: '開発チーム',
  createdAt: '2026-09-13T00:00:00.000Z',
  role: 'OWNER',
};
const JOINED_AS_MEMBER = {
  id: '01920000-0000-7000-8000-0000000000a2',
  name: '読書会',
  createdAt: '2026-09-13T01:00:00.000Z',
  role: 'MEMBER',
};
const GENERAL = {
  id: '01920000-0000-7000-8000-0000000000c1',
  name: 'general',
  visibility: 'PUBLIC',
  joined: true,
  unread: 0,
  lastReadMessageId: null,
};
const RANDOM = {
  id: '01920000-0000-7000-8000-0000000000c2',
  name: 'random',
  visibility: 'PUBLIC',
  joined: false,
  unread: 0,
  lastReadMessageId: null,
};
const SECRET = {
  id: '01920000-0000-7000-8000-0000000000c3',
  name: 'secret',
  visibility: 'PRIVATE',
  joined: true,
  unread: 0,
  lastReadMessageId: null,
};

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

describe('ワークスペースの一覧の画面', () => {
  it('所属するワークスペースをトークンを付けて読み、参加した順のまま、それぞれの画面へのリンクで並べる', async () => {
    const { calls } = fakeFetch({
      ...session,
      'GET /api/workspaces': () => json(200, [OWNED, JOINED_AS_MEMBER]),
    });
    renderApp('/workspaces');

    const owned = await screen.findByRole('link', { name: '開発チーム' });
    expect(owned.getAttribute('href')).toBe(`/workspaces/${OWNED.id}`);
    const names = within(screen.getByRole('list', { name: '所属するワークスペース' }))
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names).toEqual(['開発チーム', '読書会']);
    const list = calls.find((c) => c.key === 'GET /api/workspaces')!;
    expect(headerOf(list.init, 'Authorization')).toBe('Bearer t1');
  });

  it('所属が無ければ、無いことを出す', async () => {
    fakeFetch({ ...session, 'GET /api/workspaces': () => json(200, []) });
    renderApp('/workspaces');

    expect(await screen.findByText('所属しているワークスペースはありません。')).toBeDefined();
  });

  it('一覧を読めなければ、理由を出す', async () => {
    fakeFetch({ ...session, 'GET /api/workspaces': () => error(500, 'internal_error') });
    renderApp('/workspaces');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'ワークスペースを読み込めませんでした',
    );
  });

  it('ワークスペースを作成すると、名前を送り、そのワークスペースの画面へ移る', async () => {
    const { calls } = fakeFetch({
      ...session,
      'GET /api/workspaces': () => json(200, []),
      'POST /api/workspaces': () => json(201, OWNED),
      [`GET /api/workspaces/${OWNED.id}`]: () => json(200, OWNED),
      [`GET /api/workspaces/${OWNED.id}/channels`]: () => json(200, []),
    });
    renderApp('/workspaces');
    await screen.findByText('所属しているワークスペースはありません。');

    type('ワークスペース名', '開発チーム');
    fireEvent.click(screen.getByRole('button', { name: 'ワークスペースを作成する' }));

    expect(await screen.findByRole('heading', { name: '開発チーム' })).toBeDefined();
    const create = calls.find((c) => c.key === 'POST /api/workspaces')!;
    expect(JSON.parse(String(create.init.body))).toEqual({ name: '開発チーム' });
    expect(headerOf(create.init, 'Authorization')).toBe('Bearer t1');
    expect(headerOf(create.init, 'Content-Type')).toBe('application/json');
  });

  it('作成に失敗したら理由を出し、入力を残す', async () => {
    fakeFetch({
      ...session,
      'GET /api/workspaces': () => json(200, []),
      'POST /api/workspaces': () => error(400, 'validation_failed'),
    });
    renderApp('/workspaces');
    await screen.findByText('所属しているワークスペースはありません。');

    type('ワークスペース名', '開発チーム');
    fireEvent.click(screen.getByRole('button', { name: 'ワークスペースを作成する' }));

    expect((await screen.findByRole('alert')).textContent).toContain('入力の形が正しくありません');
    expect((screen.getByLabelText('ワークスペース名') as HTMLInputElement).value).toBe(
      '開発チーム',
    );
  });
});

describe('ワークスペースの画面', () => {
  function routesFor(workspace: typeof OWNED, extra: Parameters<typeof fakeFetch>[0] = {}) {
    return {
      ...session,
      [`GET /api/workspaces/${workspace.id}`]: () => json(200, workspace),
      [`GET /api/workspaces/${workspace.id}/channels`]: () => json(200, [GENERAL, RANDOM, SECRET]),
      ...extra,
    };
  }

  it('チャンネルを返された順のまま並べる。参加しているものはリンク、プライベートは種別を出し、参加していないパブリックには参加のボタンを出す', async () => {
    fakeFetch(routesFor(OWNED));
    renderApp(`/workspaces/${OWNED.id}`);

    expect(await screen.findByRole('heading', { name: '開発チーム' })).toBeDefined();
    const items = within(await screen.findByRole('list', { name: 'チャンネル' })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('general'),
      expect.stringContaining('random'),
      expect.stringContaining('secret'),
    ]);
    expect(screen.getByRole('link', { name: '# general' }).getAttribute('href')).toBe(
      `/workspaces/${OWNED.id}/channels/${GENERAL.id}`,
    );
    expect(screen.getByRole('link', { name: '# secret（プライベート）' })).toBeDefined();
    expect(screen.queryByRole('link', { name: /random/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'random に参加する' })).toBeDefined();
  });

  it('参加するとトークンを付けて参加を送り、チャンネルの一覧を取り直してリンクにする', async () => {
    const { calls } = fakeFetch(
      routesFor(OWNED, {
        [`GET /api/workspaces/${OWNED.id}/channels`]: [
          () => json(200, [GENERAL, RANDOM, SECRET]),
          () => json(200, [GENERAL, { ...RANDOM, joined: true }, SECRET]),
        ],
        [`POST /api/workspaces/${OWNED.id}/channels/${RANDOM.id}/join`]: () =>
          new Response(null, { status: 204 }),
      }),
    );
    renderApp(`/workspaces/${OWNED.id}`);

    fireEvent.click(await screen.findByRole('button', { name: 'random に参加する' }));

    expect(await screen.findByRole('link', { name: '# random' })).toBeDefined();
    const join = calls.find((c) => c.key.endsWith('/join'))!;
    expect(headerOf(join.init, 'Authorization')).toBe('Bearer t1');
  });

  it('参加に失敗したら理由を出す', async () => {
    fakeFetch(
      routesFor(OWNED, {
        [`POST /api/workspaces/${OWNED.id}/channels/${RANDOM.id}/join`]: () =>
          error(409, 'channel_archived'),
      }),
    );
    renderApp(`/workspaces/${OWNED.id}`);

    fireEvent.click(await screen.findByRole('button', { name: 'random に参加する' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'アーカイブ済みのチャンネルです',
    );
  });

  it('チャンネルの作成のフォームは、オーナーにだけ出す（画面の出し分けであり、判定はサーバーが行う）', async () => {
    fakeFetch(routesFor(OWNED));
    const owner = renderApp(`/workspaces/${OWNED.id}`);
    expect(await screen.findByRole('button', { name: 'チャンネルを作成する' })).toBeDefined();
    owner.unmount();

    fakeFetch(routesFor(JOINED_AS_MEMBER));
    renderApp(`/workspaces/${JOINED_AS_MEMBER.id}`);
    await screen.findByRole('list', { name: 'チャンネル' });
    expect(screen.queryByRole('button', { name: 'チャンネルを作成する' })).toBeNull();
  });

  it('チャンネルを作成すると、名前と種別を送り、一覧を取り直す', async () => {
    const DESIGN = {
      id: '01920000-0000-7000-8000-0000000000c4',
      name: 'design',
      visibility: 'PRIVATE',
      joined: true,
    };
    const { calls } = fakeFetch(
      routesFor(OWNED, {
        [`GET /api/workspaces/${OWNED.id}/channels`]: [
          () => json(200, [GENERAL]),
          () => json(200, [DESIGN, GENERAL]),
        ],
        [`POST /api/workspaces/${OWNED.id}/channels`]: () => json(201, DESIGN),
      }),
    );
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('link', { name: '# general' });

    type('チャンネル名', 'design');
    fireEvent.click(screen.getByRole('radio', { name: 'プライベート' }));
    fireEvent.click(screen.getByRole('button', { name: 'チャンネルを作成する' }));

    expect(await screen.findByRole('link', { name: '# design（プライベート）' })).toBeDefined();
    const create = calls.find((c) => c.key === `POST /api/workspaces/${OWNED.id}/channels`)!;
    expect(JSON.parse(String(create.init.body))).toEqual({ name: 'design', visibility: 'PRIVATE' });
  });

  it('同じ名前のチャンネルがあれば、理由を出す', async () => {
    fakeFetch(
      routesFor(OWNED, {
        [`POST /api/workspaces/${OWNED.id}/channels`]: () => error(409, 'channel_name_taken'),
      }),
    );
    renderApp(`/workspaces/${OWNED.id}`);
    await screen.findByRole('link', { name: '# general' });

    type('チャンネル名', 'general');
    fireEvent.click(screen.getByRole('button', { name: 'チャンネルを作成する' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      '同じ名前のチャンネルがあります',
    );
  });

  it('所属していないワークスペースは、見つからないことを出し、一覧へのリンクを出す', async () => {
    fakeFetch({
      ...session,
      [`GET /api/workspaces/${OWNED.id}`]: () => error(404, 'not_found'),
      [`GET /api/workspaces/${OWNED.id}/channels`]: () => error(404, 'not_found'),
    });
    renderApp(`/workspaces/${OWNED.id}`);

    expect(await screen.findByText('ワークスペースが見つかりません。')).toBeDefined();
    expect(screen.getByRole('link', { name: 'ワークスペースの一覧へ' }).getAttribute('href')).toBe(
      '/workspaces',
    );
  });

  it('参加しているチャンネルを開くと、チャンネルの画面へ移る', async () => {
    fakeFetch(routesFor(OWNED));
    renderApp(`/workspaces/${OWNED.id}`);

    fireEvent.click(await screen.findByRole('link', { name: '# general' }));

    expect(await screen.findByRole('heading', { name: '# general' })).toBeDefined();
  });

  it('ログアウトしたら読み込みの記憶を捨て、同じタブで次にログインした別の利用者に、前の利用者のワークスペースを出さない', async () => {
    /** テストで使うもう1人の利用者（実在の人物ではない）。 */
    const BOB = { id: '01920000-0000-7000-8000-000000000002', userId: 'bob', displayName: 'ボブ' };
    fakeFetch({
      ...session,
      // 2回目（ボブの一覧）は返さない。記憶を捨てていなければ、その間に前の利用者の一覧が出る
      'GET /api/workspaces': [() => json(200, [OWNED]), () => new Promise<Response>(() => {})],
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
      'POST /api/auth/login': () =>
        json(200, { accessToken: 't2', tokenType: 'Bearer', expiresIn: 900, user: BOB }),
    });
    renderApp('/workspaces');
    await screen.findByRole('link', { name: '開発チーム' });

    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    await screen.findByRole('heading', { name: 'ログイン' });
    type('ユーザーID', 'bob');
    type('パスワード', 'password-2');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(await screen.findByText('ボブ')).toBeDefined();
    expect(screen.queryByRole('link', { name: '開発チーム' })).toBeNull();
  });

  it('URL のパラメータは符号化して api のパスに埋め、パスの区切りとして読ませない（利用者が書ける値のため）', async () => {
    // react-router の useParams は %2F を / に復号して返す。符号化しないと /api/auth/logout などへ要求が向く
    const encoded = encodeURIComponent('../../auth/logout');
    const { calls } = fakeFetch({
      ...session,
      [`GET /api/workspaces/${encoded}`]: () => error(404, 'not_found'),
      [`GET /api/workspaces/${encoded}/channels`]: () => error(404, 'not_found'),
    });
    renderApp(`/workspaces/${encoded}`);

    expect(await screen.findByText('ワークスペースが見つかりません。')).toBeDefined();
    expect(calls.map((c) => c.key).filter((key) => key.includes('../'))).toEqual([]);
  });

  it('参加していないチャンネルの URL を直接開いても、チャンネルの画面を出さない', async () => {
    fakeFetch(routesFor(OWNED));
    renderApp(`/workspaces/${OWNED.id}/channels/${RANDOM.id}`);

    expect(await screen.findByText('チャンネルが見つかりません。')).toBeDefined();
    expect(screen.queryByRole('heading', { name: '# random' })).toBeNull();
  });
});
