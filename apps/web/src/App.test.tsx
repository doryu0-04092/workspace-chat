import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, loggedIn, PROFILE, token } from './testing/fake-api';
import { hang, manualTimeouts } from './testing/manual-timeouts';
import { renderApp } from './testing/render-app';

const RECOVERY_CODE = '0123-4567-89AB-CDEF';

function renderAt(path: string, options: { strict?: boolean } = {}) {
  return renderApp(path, options).store;
}

const signedOut = { 'POST /api/auth/refresh': () => error(401, 'invalid_token') };
const signedIn = {
  'POST /api/auth/refresh': () => token('t1'),
  'GET /api/users/me': () => json(200, PROFILE),
  'GET /api/workspaces': () => json(200, []),
  // ログインした画面の枠が、未承諾の招待の件数を読む（F-38。#532）
  'GET /api/invitations': () => json(200, []),
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('起動時の復元と行き先', () => {
  it('復元の間は読み込み中を出し、リフレッシュが通ればワークスペースの画面に表示名を出す', async () => {
    fakeFetch(signedIn);
    renderAt('/workspaces');

    expect(screen.getByRole('status').textContent).toContain('読み込み中');
    expect(await screen.findByText('アリス')).toBeDefined();
  });

  it('ログインしていなければ、ワークスペースの画面からログインの画面へ移る', async () => {
    fakeFetch(signedOut);
    renderAt('/workspaces');

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeDefined();
  });

  it('ログインしている利用者がログインの画面・登録の画面・再設定の画面・知らない URL を開くと、ワークスペースの画面へ移る', async () => {
    for (const path of ['/login', '/register', '/recovery', '/', '/nope']) {
      fakeFetch(signedIn);
      const { unmount } = renderApp(path);
      expect(await screen.findByText('アリス'), path).toBeDefined();
      unmount();
    }
  });

  it('StrictMode で描画しても、リフレッシュの要求は1回だけ送る', async () => {
    const { count } = fakeFetch(signedIn);
    renderAt('/workspaces', { strict: true });

    await screen.findByText('アリス');
    expect(count('POST /api/auth/refresh')).toBe(1);
  });

  it('ログインの状態を確かめられなければ（429 で待つ秒数が長い）、ログインの画面に移さず、時間をおいて再読み込みする案内とボタンを出す', async () => {
    fakeFetch({
      'POST /api/auth/refresh': () => error(429, 'too_many_requests', { 'Retry-After': '600' }),
    });
    renderAt('/workspaces');

    expect((await screen.findByRole('alert')).textContent).toContain(
      '時間をおいて、再読み込みしてください',
    );
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'ログイン' })).toBeNull();
  });

  it('ログインの状態を確かめられなくても、利用者が自分で開いたログインの画面・登録の画面・再設定の画面は塞がない', async () => {
    for (const [path, heading] of [
      ['/login', 'ログイン'],
      ['/register', '新規登録'],
      ['/recovery', 'パスワードの再設定'],
    ] as const) {
      fakeFetch({
        'POST /api/auth/refresh': () => error(429, 'too_many_requests', { 'Retry-After': '600' }),
      });
      const { unmount } = renderApp(path);
      expect(await screen.findByRole('heading', { name: heading }), path).toBeDefined();
      expect(screen.queryByRole('button', { name: '再読み込み' }), path).toBeNull();
      unmount();
    }
  });

  it('復元の要求が返らなくても、時限で打ち切り、利用者が自分で開いたログインの画面・登録の画面を出す（#530）', async () => {
    for (const [path, heading] of [
      ['/login', 'ログイン'],
      ['/register', '新規登録'],
    ] as const) {
      const { count } = fakeFetch({ 'POST /api/auth/refresh': [hang, hang] });
      const timeouts = manualTimeouts();
      const { unmount } = renderApp(path, {
        session: { wait: () => Promise.resolve(), timeoutSignal: timeouts.timeoutSignal },
      });

      expect(screen.getByRole('status').textContent, path).toContain('読み込み中');
      await waitFor(() => expect(timeouts.requested, path).toHaveLength(1));
      timeouts.fire(0);
      await waitFor(() => expect(timeouts.requested, path).toHaveLength(2));
      timeouts.fire(1);

      expect(await screen.findByRole('heading', { name: heading }), path).toBeDefined();
      expect(count('POST /api/auth/refresh'), path).toBe(2);
      unmount();
    }
  });
});

describe('ログインの画面', () => {
  async function openLogin(routes: Parameters<typeof fakeFetch>[0]) {
    const fetch = fakeFetch({ ...signedOut, ...routes });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'ログイン' });
    type('ユーザーID', 'alice');
    type('パスワード', 'password-1');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    return fetch;
  }

  it('ログインするとワークスペースの画面へ移り、トークンをブラウザの保存領域に書かない', async () => {
    const { calls } = await openLogin({
      'POST /api/auth/login': () => loggedIn('t1'),
      'GET /api/workspaces': () => json(200, []),
      'GET /api/invitations': () => json(200, []),
    });

    expect(await screen.findByText('アリス')).toBeDefined();
    const login = calls.find((c) => c.key === 'POST /api/auth/login')!;
    expect(JSON.parse(String(login.init.body))).toEqual({
      userId: 'alice',
      password: 'password-1',
    });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  // 機能一覧 1.2: ログインしていない利用者が保護された画面を開くとログインの画面へ移し、ログインしたら元の行き先へ戻す（#414）。
  it('ワークスペースの一覧以外の保護された画面から入ってログインすると、その画面へ戻る', async () => {
    const workspace = {
      id: '01920000-0000-7000-8000-0000000000a1',
      name: '開発チーム',
      createdAt: '2026-09-13T00:00:00.000Z',
      role: 'OWNER',
    };
    fakeFetch({
      ...signedOut,
      'POST /api/auth/login': () => loggedIn('t1'),
      'GET /api/users/me': () => json(200, PROFILE),
      'GET /api/invitations': () => json(200, []),
      [`GET /api/workspaces/${workspace.id}`]: () => json(200, workspace),
      [`GET /api/workspaces/${workspace.id}/channels`]: () => json(200, []),
      [`GET /api/workspaces/${workspace.id}/dms`]: () => json(200, []),
    });
    renderAt(`/workspaces/${workspace.id}`);
    await screen.findByRole('heading', { name: 'ログイン' });

    type('ユーザーID', 'alice');
    type('パスワード', 'password-1');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(await screen.findByRole('heading', { name: '開発チーム' })).toBeDefined();
  });

  it('ユーザーID かパスワードが違えば理由を出し、ログインの画面に留まる', async () => {
    await openLogin({ 'POST /api/auth/login': () => error(401, 'invalid_credentials') });

    expect((await screen.findByRole('alert')).textContent).toContain(
      'ユーザーID かパスワードが違います',
    );
    expect(screen.getByRole('heading', { name: 'ログイン' })).toBeDefined();
  });

  it('試行が多すぎれば、待つ秒数を出す', async () => {
    await openLogin({
      'POST /api/auth/login': () => error(429, 'too_many_requests', { 'Retry-After': '32' }),
    });

    expect((await screen.findByRole('alert')).textContent).toContain('32 秒');
  });

  it('登録の画面へのリンクがある', async () => {
    fakeFetch(signedOut);
    renderAt('/login');

    fireEvent.click(await screen.findByRole('link', { name: '新規登録' }));
    expect(await screen.findByRole('heading', { name: '新規登録' })).toBeDefined();
  });
});

describe('登録の画面', () => {
  async function submitRegister(routes: Parameters<typeof fakeFetch>[0]) {
    const fetch = fakeFetch({ ...signedOut, ...routes });
    renderAt('/register');
    await screen.findByRole('heading', { name: '新規登録' });
    type('ユーザーID', 'alice');
    type('パスワード', 'password-1');
    type('表示名', 'アリス');
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    return fetch;
  }

  it('パスワードと表示名の入力欄は、文字数で入力を切らない（文字数はコードポイントで数えるため、長さはサーバーが判定する）', async () => {
    fakeFetch(signedOut);
    renderAt('/register');
    await screen.findByRole('heading', { name: '新規登録' });

    for (const label of ['パスワード', '表示名']) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.maxLength).toBe(-1);
      expect(input.minLength).toBe(-1);
    }
  });

  it('リカバリーコードを失うと復旧できないことを、登録の前に出す（機能一覧 1.1）', async () => {
    fakeFetch(signedOut);
    renderAt('/register');

    await screen.findByRole('heading', { name: '新規登録' });
    expect(document.body.textContent).toContain(
      'リカバリーコードを失うと、アカウントを復旧できません',
    );
  });

  it('登録するとリカバリーコードを表示し、控えたことを選ぶまで先へ進めない。進むとログインの画面へ移り、コードは画面にも保存領域にも残らない', async () => {
    const { calls } = await submitRegister({
      'POST /api/auth/register': () =>
        json(201, {
          user: { id: PROFILE.id, userId: 'alice', displayName: 'アリス' },
          recoveryCode: RECOVERY_CODE,
        }),
    });

    expect(await screen.findByText(RECOVERY_CODE)).toBeDefined();
    const register = calls.find((c) => c.key === 'POST /api/auth/register')!;
    expect(JSON.parse(String(register.init.body))).toEqual({
      userId: 'alice',
      password: 'password-1',
      displayName: 'アリス',
    });

    const proceed = screen.getByRole('button', {
      name: 'ログインの画面へ進む',
    }) as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);
    fireEvent.click(proceed);
    expect(screen.queryByRole('heading', { name: 'ログイン' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'リカバリーコードを控えました' }));
    expect(proceed.disabled).toBe(false);
    fireEvent.click(proceed);

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeDefined();
    expect(screen.queryByText(RECOVERY_CODE)).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('登録の応答の本体が読めなければ（JSON でない）、理由を出し、もう一度押せる状態に戻す', async () => {
    await submitRegister({
      'POST /api/auth/register': () =>
        new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    });

    expect((await screen.findByRole('alert')).textContent).toContain('うまくいきませんでした');
    expect((screen.getByRole('button', { name: '登録する' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('ユーザーID が使われていれば理由を出し、入力を残す', async () => {
    await submitRegister({ 'POST /api/auth/register': () => error(409, 'user_id_taken') });

    expect((await screen.findByRole('alert')).textContent).toContain(
      'このユーザーID は既に使われています',
    );
    expect((screen.getByLabelText('表示名') as HTMLInputElement).value).toBe('アリス');
  });

  it('新規登録を止めていれば理由を出す', async () => {
    await submitRegister({ 'POST /api/auth/register': () => error(403, 'registration_disabled') });

    expect((await screen.findByRole('alert')).textContent).toContain(
      '新規登録を受け付けていません',
    );
  });
});

// 機能一覧 1.1（F-37）: リカバリーコードによるパスワードの再設定の画面。#550。
describe('パスワードの再設定の画面', () => {
  const NEW_CODE = 'ZYXW-VTSR-QPNM-KJHG';

  async function submitRecovery(routes: Parameters<typeof fakeFetch>[0]) {
    const fetch = fakeFetch({ ...signedOut, ...routes });
    renderAt('/recovery');
    await screen.findByRole('heading', { name: 'パスワードの再設定' });
    type('ユーザーID', 'alice');
    type('リカバリーコード', RECOVERY_CODE);
    type('新しいパスワード', 'password-2');
    fireEvent.click(screen.getByRole('button', { name: '再設定する' }));
    return fetch;
  }

  it('ログインの画面から開ける', async () => {
    fakeFetch(signedOut);
    renderAt('/login');

    fireEvent.click(await screen.findByRole('link', { name: 'パスワードを忘れた' }));
    expect(await screen.findByRole('heading', { name: 'パスワードの再設定' })).toBeDefined();
  });

  it('再設定すると新しいリカバリーコードを表示し、控えたことを選ぶまで先へ進めない。進むとログインの画面へ移り、コードは画面にも保存領域にも残らない', async () => {
    const { calls } = await submitRecovery({
      'POST /api/auth/recovery': () => json(200, { recoveryCode: NEW_CODE }),
    });

    expect(await screen.findByText(NEW_CODE)).toBeDefined();
    const recovery = calls.find((c) => c.key === 'POST /api/auth/recovery')!;
    expect(JSON.parse(String(recovery.init.body))).toEqual({
      userId: 'alice',
      recoveryCode: RECOVERY_CODE,
      newPassword: 'password-2',
    });
    // 使ったコードは無効になったことを伝える
    expect(screen.getByText(/使ったリカバリーコードは、もう使えません/)).toBeDefined();

    const proceed = screen.getByRole('button', {
      name: 'ログインの画面へ進む',
    }) as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'リカバリーコードを控えました' }));
    fireEvent.click(proceed);

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeDefined();
    expect(screen.queryByText(NEW_CODE)).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('ユーザーID かリカバリーコードが違えば、パスワードではなくリカバリーコードが違うと出し、入力を残す', async () => {
    await submitRecovery({ 'POST /api/auth/recovery': () => error(401, 'invalid_credentials') });

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('ユーザーID かリカバリーコードが違います');
    expect(alert).not.toContain('パスワードが違います');
    expect((screen.getByLabelText('ユーザーID') as HTMLInputElement).value).toBe('alice');
  });

  it('試行が多すぎれば、待つ秒数を出す', async () => {
    await submitRecovery({
      'POST /api/auth/recovery': () => error(429, 'too_many_requests', { 'Retry-After': '16' }),
    });

    expect((await screen.findByRole('alert')).textContent).toContain('16 秒');
  });

  it('応答の本体が読めなければ（JSON でない）、理由を出し、もう一度押せる状態に戻す', async () => {
    await submitRecovery({
      'POST /api/auth/recovery': () =>
        new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    });

    expect((await screen.findByRole('alert')).textContent).toContain('うまくいきませんでした');
    expect((screen.getByRole('button', { name: '再設定する' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('ログアウト', () => {
  it('ログアウトするとログインの画面へ移る', async () => {
    fakeFetch({ ...signedIn, 'POST /api/auth/logout': () => new Response(null, { status: 204 }) });
    renderAt('/workspaces');

    fireEvent.click(await screen.findByRole('button', { name: 'ログアウト' }));

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeDefined();
  });

  it('ログアウトに失敗したら理由を出し、ログインしたまま留まる', async () => {
    fakeFetch({ ...signedIn, 'POST /api/auth/logout': () => error(500, 'internal_error') });
    renderAt('/workspaces');
    await screen.findByText('所属しているワークスペースはありません。');

    fireEvent.click(await screen.findByRole('button', { name: 'ログアウト' }));

    expect((await screen.findByRole('alert')).textContent).toContain('ログアウトできませんでした');
    await waitFor(() => expect(screen.getByText('アリス')).toBeDefined());
  });
});
