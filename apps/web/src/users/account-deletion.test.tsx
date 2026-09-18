import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, PROFILE, token } from '../testing/fake-api';
import { renderApp } from '../testing/render-app';

// 機能一覧 1.5（F-36）: 設定の画面からアカウントを削除する。送る前に確かめ、戻せないことを伝える。削除したらログインしていない状態にする。#575。

const DELETE = 'POST /api/users/me/delete';

type Handler = (init: RequestInit) => Response | Promise<Response>;

function signedIn(extra: Record<string, Handler> = {}) {
  return {
    'POST /api/auth/refresh': () => token('t1'),
    'GET /api/users/me': () => json(200, PROFILE),
    'GET /api/users/me/settings': () => json(200, { threadUnreadIncluded: true }),
    'GET /api/workspaces': () => json(200, []),
    'GET /api/invitations': () => json(200, []),
    ...extra,
  };
}

async function openSettings() {
  await screen.findByRole('heading', { name: '設定' });
  await screen.findByRole('checkbox');
}

function typePassword(value: string) {
  fireEvent.change(screen.getByLabelText('今のパスワード'), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'アカウントを削除する' }));
}

/** 要求は非同期で出るので、出る分だけ待つ（クリックの直後に数えると、送ってしまう実装でもまだ 0 である）。 */
async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('アカウントの削除（F-36）', () => {
  it('設定の画面に、元に戻せないことと、オーナーは削除できないことを出す', async () => {
    fakeFetch(signedIn());
    renderApp('/settings');
    await openSettings();

    const section = screen.getByRole('region', { name: 'アカウントの削除' });
    expect(section.textContent).toContain('元に戻せません');
    expect(section.textContent).toContain('オーナー');
  });

  it('確かめを取り消したら、api に送らない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { count } = fakeFetch(signedIn({ [DELETE]: () => new Response(null, { status: 204 }) }));
    const { store } = renderApp('/settings');
    await openSettings();

    typePassword('current-password');
    submit();
    await pause();

    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toContain('元に戻せません');
    expect(count(DELETE)).toBe(0);
    expect(store.getState().status).toBe('signedIn');
  });

  it('パスワードを入れずには送らない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { count } = fakeFetch(signedIn({ [DELETE]: () => new Response(null, { status: 204 }) }));
    renderApp('/settings');
    await openSettings();

    submit();
    await pause();

    expect(confirm).not.toHaveBeenCalled();
    expect(count(DELETE)).toBe(0);
  });

  it('確かめたらパスワードを送り、削除できたらログインしていない状態にしてログインの画面へ移る', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const remove = vi.fn<Handler>(() => new Response(null, { status: 204 }));
    const { calls } = fakeFetch(signedIn({ [DELETE]: remove }));
    const { store } = renderApp('/settings');
    await openSettings();

    typePassword('current-password');
    submit();

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeDefined();
    expect(store.getState().status).toBe('signedOut');
    expect(remove).toHaveBeenCalledOnce();
    expect(JSON.parse(String(remove.mock.calls[0]?.[0]?.body))).toEqual({
      password: 'current-password',
    });
    // ログアウトの api は呼ばない（削除の応答が Cookie を消し、トークンは api が失効させてある）
    expect(calls.some((c) => c.key === 'POST /api/auth/logout')).toBe(false);
  });

  it.each([
    ['パスワードが違う', 403, 'password_mismatch', 'パスワードが違います'],
    [
      'ワークスペースのオーナーである',
      403,
      'owner_cannot_delete_account',
      'オーナーは、アカウントを削除できません',
    ],
  ])(
    '%sと断られたら、理由を出してログインしたまま画面に留まる',
    async (_label, status, code, text) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      fakeFetch(signedIn({ [DELETE]: () => error(status, code) }));
      const { store } = renderApp('/settings');
      await openSettings();

      typePassword('current-password');
      submit();

      expect((await screen.findByRole('alert')).textContent).toContain(text);
      expect(store.getState().status).toBe('signedIn');
      expect(screen.getByRole('heading', { name: '設定' })).toBeDefined();
    },
  );

  // **踏むと壊れる: 応答を待つ間にログインが替わったら、次の利用者をログアウトさせない**（プロフィールの保存と同じ理由。#558 第0巡の 🔴1）。
  it('削除の応答を待つ間に別の利用者がログインしたら、その利用者はログインしたままにする', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let resolveDelete: (response: Response) => void = () => {};
    fakeFetch(
      signedIn({
        [DELETE]: () =>
          new Promise<Response>((resolve) => {
            resolveDelete = resolve;
          }),
        'POST /api/auth/logout': () => new Response(null, { status: 204 }),
        'POST /api/auth/login': () =>
          json(200, {
            accessToken: 't2',
            tokenType: 'Bearer',
            expiresIn: 900,
            user: {
              id: '01920000-0000-7000-8000-000000000002',
              userId: 'bob',
              displayName: 'ボブ',
            },
          }),
      }),
    );
    const { store } = renderApp('/settings');
    await openSettings();
    typePassword('current-password');
    submit();
    await pause();

    await act(async () => {
      await store.logout();
    });
    await act(async () => {
      await store.login('bob', 'password-1');
    });
    await act(async () => {
      resolveDelete(new Response(null, { status: 204 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const state = store.getState();
    expect(state.status === 'signedIn' && state.user.userId).toBe('bob');
  });
});
