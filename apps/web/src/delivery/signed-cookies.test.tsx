import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../testing/fake-api';
import {
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  page,
  routes,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 1.3（F-04）・11.2（F-29）: CloudFront の署名付き Cookie を、期限より前に取り直す。
// アバターの Cookie はログインしている間ずっと、添付の Cookie はそのチャンネルを開いている間だけ。
// Cookie そのものはブラウザが Set-Cookie で持つ（HttpOnly）。画面は api に発行を求める回数と相手だけを持つ。

const AVATARS = 'POST /api/avatars/cookies';
const RANDOM = { ...GENERAL, id: '01920000-0000-7000-8000-0000000000c2', name: 'random' };
const filesOf = (channelId: string) =>
  `POST /api/workspaces/${WORKSPACE_ID}/channels/${channelId}/files/cookies`;
const messagesOf = (channelId: string) =>
  `GET /api/workspaces/${WORKSPACE_ID}/channels/${channelId}/messages`;
const readOf = (channelId: string) =>
  `PUT /api/workspaces/${WORKSPACE_ID}/channels/${channelId}/read`;

/** 発行した応答（有効期間 `expiresIn` 秒）。 */
const issued = (expiresIn: number) => () => json(200, { expiresIn });
/** 署名鍵を設定していない api の応答。 */
const notConfigured = () => new Response(null, { status: 204 });

async function pause(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 2つのチャンネルに参加している状態の応答。 */
function twoChannels(extra: Parameters<typeof routes>[0] = {}) {
  return routes({
    [`GET /api/workspaces/${WORKSPACE_ID}/channels`]: () => json(200, [GENERAL, RANDOM]),
    [`GET ${MESSAGES}`]: () => page([]),
    [messagesOf(RANDOM.id)]: () => page([]),
    [readOf(RANDOM.id)]: () => new Response(null, { status: 204 }),
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('配信の署名付き Cookie の取り直し（F-04・F-29）', () => {
  it('ログインした画面を開くと、アバターの Cookie の発行を1回求める', async () => {
    const { count } = fakeFetch(routes({ [AVATARS]: issued(900) }));
    renderApp('/workspaces');

    await waitFor(() => expect(count(AVATARS)).toBe(1));
    await pause(50);
    expect(count(AVATARS)).toBe(1);
  });

  // 期限の 2/3 で取り直す（有効期間 1 秒なら、1 秒の下限で取り直す）。
  it('アバターの Cookie は、期限より前に取り直す', async () => {
    const { count } = fakeFetch(routes({ [AVATARS]: issued(1) }));
    renderApp('/workspaces');

    await waitFor(() => expect(count(AVATARS)).toBe(1));
    await waitFor(() => expect(count(AVATARS)).toBeGreaterThanOrEqual(2), { timeout: 2500 });
  });

  // 失敗のまま置くと、次に画面を開き直すまで Cookie が無い（画像が出ない）。
  it('発行に失敗したら、画面に戻ったときに取り直す', async () => {
    const { count } = fakeFetch(
      routes({ [AVATARS]: [() => json(500, { code: 'internal', message: 'x' }), issued(900)] }),
    );
    renderApp('/workspaces');
    await waitFor(() => expect(count(AVATARS)).toBe(1));
    await pause(50);

    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(count(AVATARS)).toBe(2));
  });

  it('発行できていれば、期限の前に画面に戻っても取り直さない', async () => {
    const { count } = fakeFetch(routes({ [AVATARS]: issued(900) }));
    renderApp('/workspaces');
    await waitFor(() => expect(count(AVATARS)).toBe(1));
    await pause(50);

    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await pause(100);

    expect(count(AVATARS)).toBe(1);
  });

  it('署名鍵を設定していない api（204）なら、取り直さない', async () => {
    const { count } = fakeFetch(routes({ [AVATARS]: notConfigured }));
    renderApp('/workspaces');

    await waitFor(() => expect(count(AVATARS)).toBe(1));
    await pause(1300);
    expect(count(AVATARS)).toBe(1);
  });

  it('チャンネルを開くと、そのチャンネルの添付の Cookie の発行を求め、期限より前に取り直す', async () => {
    const { count } = fakeFetch(
      twoChannels({ [AVATARS]: issued(900), [filesOf(GENERAL.id)]: issued(1) }),
    );
    renderApp(CHANNEL_PATH);

    await waitFor(() => expect(count(filesOf(GENERAL.id))).toBe(1));
    await waitFor(() => expect(count(filesOf(GENERAL.id))).toBeGreaterThanOrEqual(2), {
      timeout: 2500,
    });
    expect(count(filesOf(RANDOM.id))).toBe(0);
  });

  it('チャンネルの画面を離れたら、そのチャンネルの添付の Cookie を取り直さない', async () => {
    const { count } = fakeFetch(
      twoChannels({ [AVATARS]: issued(900), [filesOf(GENERAL.id)]: issued(1) }),
    );
    renderApp(CHANNEL_PATH);
    await waitFor(() => expect(count(filesOf(GENERAL.id))).toBe(1));

    fireEvent.click(await screen.findByRole('link', { name: 'チャンネルの一覧へ' }));
    await screen.findByRole('list', { name: 'チャンネル' });
    await pause(1300);

    expect(count(filesOf(GENERAL.id))).toBe(1);
  });

  // 添付の Cookie は名前と Path が同じため、別のチャンネルで発行すると上書きされる（REST の仕様の issueChannelFileCookies）。
  it('別のチャンネルへ移ってから戻ると、戻ったチャンネルの Cookie を発行し直す', async () => {
    const { count } = fakeFetch(
      twoChannels({
        [AVATARS]: issued(900),
        [filesOf(GENERAL.id)]: issued(900),
        [filesOf(RANDOM.id)]: issued(900),
      }),
    );
    renderApp(CHANNEL_PATH);
    await waitFor(() => expect(count(filesOf(GENERAL.id))).toBe(1));

    fireEvent.click(await screen.findByRole('link', { name: 'チャンネルの一覧へ' }));
    fireEvent.click(await screen.findByRole('link', { name: '# random' }));
    await waitFor(() => expect(count(filesOf(RANDOM.id))).toBe(1));
    fireEvent.click(await screen.findByRole('link', { name: 'チャンネルの一覧へ' }));
    fireEvent.click(await screen.findByRole('link', { name: '# general' }));

    await waitFor(() => expect(count(filesOf(GENERAL.id))).toBe(2));
  });

  // 前のチャンネルの発行が、移った先の発行より後に返ると、前のチャンネルの Cookie が残る（上書きされる）。
  it('前のチャンネルの発行が後から返ったら、いま開いているチャンネルの Cookie を発行し直す', async () => {
    let releaseGeneral: () => void = () => {};
    const { count } = fakeFetch(
      twoChannels({
        [AVATARS]: issued(900),
        [filesOf(GENERAL.id)]: () =>
          new Promise<Response>((resolve) => {
            releaseGeneral = () => resolve(json(200, { expiresIn: 900 }));
          }),
        [filesOf(RANDOM.id)]: issued(900),
      }),
    );
    renderApp(CHANNEL_PATH);
    await waitFor(() => expect(count(filesOf(GENERAL.id))).toBe(1));

    fireEvent.click(await screen.findByRole('link', { name: 'チャンネルの一覧へ' }));
    fireEvent.click(await screen.findByRole('link', { name: '# random' }));
    await waitFor(() => expect(count(filesOf(RANDOM.id))).toBe(1));
    await pause(50);
    await act(async () => {
      releaseGeneral();
    });

    await waitFor(() => expect(count(filesOf(RANDOM.id))).toBe(2));
    await pause(50);
    expect(count(filesOf(RANDOM.id))).toBe(2);
    expect(count(filesOf(GENERAL.id))).toBe(1);
  });
});
