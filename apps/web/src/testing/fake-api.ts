import { vi } from 'vitest';

/** テストで使う利用者（実在の人物ではない）。 */
export const PROFILE = {
  id: '01920000-0000-7000-8000-000000000001',
  userId: 'alice',
  displayName: 'アリス',
  avatarUrl: null,
  status: null,
};
export const USER = { id: PROFILE.id, userId: PROFILE.userId, displayName: PROFILE.displayName };

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function error(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { code, message: 'x' }, headers);
}

export function token(accessToken: string): Response {
  return json(200, { accessToken, tokenType: 'Bearer', expiresIn: 900 });
}

export function loggedIn(accessToken: string): Response {
  return json(200, { accessToken, tokenType: 'Bearer', expiresIn: 900, user: USER });
}

type Handler = (init: RequestInit) => Response | Promise<Response>;

/**
 * `POST /api/auth/refresh` の形の鍵で応答を返す偽の fetch をグローバルに差し込む。呼ばれた順に記録する。
 * 配列を渡すと、呼ばれるたびに先頭から1つずつ使う。鍵に無い要求は例外にする（黙って通さない）。
 */
export function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: { key: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${String(input)}`;
    calls.push({ key, init });
    const route = routes[key];
    if (!route) throw new Error(`想定していない要求: ${key}`);
    const handler = Array.isArray(route) ? route.shift() : route;
    if (!handler) throw new Error(`応答を使い切った: ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetch);
  const count = (key: string) => calls.filter((c) => c.key === key).length;
  return { calls, count };
}

export function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}
