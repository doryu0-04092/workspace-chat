import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, PROFILE, token } from '../testing/fake-api';
import { renderApp } from '../testing/render-app';

// 機能一覧 1.3（F-04 のアバター画像）: プロフィールの画面で選んで上げ（発行 → PUT → 確定）、プロフィールと画面の枠に表示する。

type Handler = (init: RequestInit) => Response | Promise<Response>;

const UPLOAD_ID = '01920000-0000-7000-8000-0000000000a1';
const UPLOAD_URL = `http://127.0.0.1:9000/bucket/quarantine/avatars/${PROFILE.id}/${UPLOAD_ID}/me.png?X-Amz-Signature=x`;
const AVATAR_URL = `/avatars/${PROFILE.id}/${UPLOAD_ID}/me.png`;
const TICKET = {
  uploadId: UPLOAD_ID,
  uploadUrl: UPLOAD_URL,
  uploadHeaders: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
  expiresAt: '2026-09-17T10:05:00.000Z',
};
const MB = 1024 * 1024;

function signedIn(extra: Record<string, Handler | Handler[]> = {}) {
  return {
    'POST /api/auth/refresh': () => token('t1'),
    'GET /api/users/me': () => json(200, PROFILE),
    'GET /api/workspaces': () => json(200, []),
    'GET /api/invitations': () => json(200, []),
    ...extra,
  };
}

function choose(file: File) {
  fireEvent.change(screen.getByLabelText('アバター画像'), { target: { files: [file] } });
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('アバター画像（F-04）', () => {
  it('画像を選ぶと、発行・PUT・確定の順に送り、プロフィールと画面の枠の画像を読み直さずに変える', async () => {
    const issue = vi.fn<Handler>(() => json(201, TICKET));
    const put = vi.fn<Handler>(() => new Response(null, { status: 200 }));
    const complete = vi.fn<Handler>(() => json(200, { ...PROFILE, avatarUrl: AVATAR_URL }));
    const { calls, count } = fakeFetch(
      signedIn({
        'POST /api/users/me/avatar/uploads': issue,
        [`PUT ${UPLOAD_URL}`]: put,
        [`POST /api/users/me/avatar/uploads/${UPLOAD_ID}/complete`]: complete,
      }),
    );
    renderApp('/profile');
    await screen.findByLabelText('アバター画像');
    expect(screen.getByRole('banner').querySelector('img')).toBeNull();
    const reads = count('GET /api/users/me');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'me.png', {
      type: 'image/png',
    });

    choose(file);

    expect(
      (await screen.findByRole('img', { name: '現在のアバター画像' })).getAttribute('src'),
    ).toBe(AVATAR_URL);
    expect(JSON.parse(String(issue.mock.calls[0]?.[0]?.body))).toEqual({
      fileName: 'me.png',
      contentType: 'image/png',
      size: 4,
    });
    const sent = calls.find((c) => c.key === `PUT ${UPLOAD_URL}`)!;
    expect(headerOf(sent.init, 'Content-Type')).toBe('image/png');
    expect(headerOf(sent.init, 'If-None-Match')).toBe('*');
    // S3 へはアクセストークンを送らない
    expect(headerOf(sent.init, 'Authorization')).toBeNull();
    expect(sent.init.body).toBe(file);
    expect(calls.map((c) => c.key).filter((key) => /avatar|PUT/.test(key))).toEqual([
      'POST /api/users/me/avatar/uploads',
      `PUT ${UPLOAD_URL}`,
      `POST /api/users/me/avatar/uploads/${UPLOAD_ID}/complete`,
    ]);
    expect(screen.getByRole('banner').querySelector('img')?.getAttribute('src')).toBe(AVATAR_URL);
    expect(count('GET /api/users/me')).toBe(reads);
  });

  it('ブラウザの File.type が許可リストに無くても、拡張子で申告する形式を選ぶ', async () => {
    const issue = vi.fn<Handler>(() =>
      json(201, {
        ...TICKET,
        uploadHeaders: { 'Content-Type': 'image/jpeg', 'If-None-Match': '*' },
      }),
    );
    fakeFetch(
      signedIn({
        'POST /api/users/me/avatar/uploads': issue,
        [`PUT ${UPLOAD_URL}`]: () => new Response(null, { status: 200 }),
        [`POST /api/users/me/avatar/uploads/${UPLOAD_ID}/complete`]: () =>
          json(200, { ...PROFILE, avatarUrl: AVATAR_URL }),
      }),
    );
    renderApp('/profile');
    await screen.findByLabelText('アバター画像');

    choose(new File([new Uint8Array([0xff, 0xd8, 0xff])], 'Photo.JPEG', { type: '' }));

    await screen.findByRole('img', { name: '現在のアバター画像' });
    expect(JSON.parse(String(issue.mock.calls[0]?.[0]?.body))).toMatchObject({
      contentType: 'image/jpeg',
    });
  });

  it.each([
    ['SVG', new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }), '形式'],
    ['画像でないもの（pdf）', new File(['%PDF-'], 'a.pdf', { type: 'application/pdf' }), '形式'],
    [
      '10 MB を超える画像',
      new File([new Uint8Array(10 * MB + 1)], 'a.png', { type: 'image/png' }),
      '大きすぎます',
    ],
  ])('%s は送らずに理由を出す', async (_, file, message) => {
    const issue = vi.fn<Handler>(() => json(201, TICKET));
    fakeFetch(signedIn({ 'POST /api/users/me/avatar/uploads': issue }));
    renderApp('/profile');
    await screen.findByLabelText('アバター画像');

    choose(file);

    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(issue).not.toHaveBeenCalled();
  });

  it('確定で断られたら理由を出し、画像を変えない', async () => {
    fakeFetch(
      signedIn({
        'POST /api/users/me/avatar/uploads': () => json(201, TICKET),
        [`PUT ${UPLOAD_URL}`]: () => new Response(null, { status: 200 }),
        [`POST /api/users/me/avatar/uploads/${UPLOAD_ID}/complete`]: () =>
          error(422, 'unsupported_file_type'),
      }),
    );
    renderApp('/profile');
    await screen.findByLabelText('アバター画像');

    choose(new File(['<svg/>'], 'a.png', { type: 'image/png' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'この形式のファイルは上げられません',
    );
    expect(screen.queryByRole('img', { name: '現在のアバター画像' })).toBeNull();
  });

  it('PUT が断られたら確定を求めずに理由を出す', async () => {
    const complete = vi.fn<Handler>(() => json(200, PROFILE));
    fakeFetch(
      signedIn({
        'POST /api/users/me/avatar/uploads': () => json(201, TICKET),
        [`PUT ${UPLOAD_URL}`]: () => new Response('<Error/>', { status: 403 }),
        [`POST /api/users/me/avatar/uploads/${UPLOAD_ID}/complete`]: complete,
      }),
    );
    renderApp('/profile');
    await screen.findByLabelText('アバター画像');

    choose(new File([new Uint8Array([0x89])], 'a.png', { type: 'image/png' }));

    expect((await screen.findByRole('alert')).textContent).toContain('変えられませんでした');
    await pause();
    expect(complete).not.toHaveBeenCalled();
  });

  it('アバター画像があれば、どの画面でも画面の枠に出す（表示名の横の飾りとして、代わりの文を持たない）', async () => {
    fakeFetch(
      signedIn({ 'GET /api/users/me': () => json(200, { ...PROFILE, avatarUrl: AVATAR_URL }) }),
    );
    renderApp('/workspaces');

    const header = within(await screen.findByRole('banner'));
    await header.findByText('アリス');
    await vi.waitFor(() => {
      const img = screen.getByRole('banner').querySelector('img');
      expect(img?.getAttribute('src')).toBe(AVATAR_URL);
      expect(img?.getAttribute('alt')).toBe('');
    });
  });
});
