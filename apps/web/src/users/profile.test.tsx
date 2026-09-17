import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, PROFILE, token } from '../testing/fake-api';
import { renderApp } from '../testing/render-app';

// 機能一覧 1.3（F-04）: 自分のプロフィールの編集の画面。#551。

type Handler = (init: RequestInit) => Response;

const WITH_STATUS = { ...PROFILE, status: { emoji: '🍵', text: '休憩中' } };

function signedIn(extra: Record<string, Handler> = {}) {
  return {
    'POST /api/auth/refresh': () => token('t1'),
    'GET /api/users/me': () => json(200, WITH_STATUS),
    'GET /api/workspaces': () => json(200, []),
    'GET /api/invitations': () => json(200, []),
    ...extra,
  };
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function valueOf(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

async function openProfile() {
  await screen.findByRole('heading', { name: 'プロフィール' });
  // 今の値を読み込み終えるまで待つ（入力欄は読み込んだ値で埋まる）
  await screen.findByDisplayValue('休憩中');
}

function sentBody(handler: ReturnType<typeof vi.fn<Handler>>): unknown {
  return JSON.parse(String(handler.mock.calls[0]?.[0]?.body));
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('プロフィールの編集（F-04）', () => {
  it('画面の枠の「プロフィール」から開き、今の表示名とステータスを入れた状態で出す。ユーザーID は変えられない', async () => {
    fakeFetch(signedIn());
    renderApp('/workspaces');

    fireEvent.click(await screen.findByRole('link', { name: 'プロフィール' }));
    await openProfile();

    expect(valueOf('表示名')).toBe('アリス');
    expect(valueOf('ステータスの絵文字')).toBe('🍵');
    expect(valueOf('ステータスのテキスト')).toBe('休憩中');
    expect(screen.getByText('@alice')).toBeDefined();
    expect(screen.queryByLabelText('ユーザーID')).toBeNull();
  });

  it('保存すると表示名とステータスを送り、画面の枠の表示名を読み直さずに変える', async () => {
    const update = vi.fn<Handler>(() =>
      json(200, { ...PROFILE, displayName: 'ありす', status: { emoji: '🏠', text: '在宅' } }),
    );
    const { count } = fakeFetch(signedIn({ 'PATCH /api/users/me': update }));
    renderApp('/profile');
    await openProfile();
    const header = within(screen.getByRole('banner'));
    expect(header.getByText('アリス')).toBeDefined();
    const reads = count('GET /api/users/me');

    type('表示名', 'ありす');
    type('ステータスの絵文字', '🏠');
    type('ステータスのテキスト', '在宅');
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByRole('status')).toBeDefined();
    expect(sentBody(update)).toEqual({
      displayName: 'ありす',
      status: { emoji: '🏠', text: '在宅' },
    });
    expect(header.getByText('ありす')).toBeDefined();
    expect(count('GET /api/users/me')).toBe(reads);
  });

  it('絵文字とテキストの両方を空にして保存すると、ステータスを消す（null を送る）', async () => {
    const update = vi.fn<Handler>(() => json(200, PROFILE));
    fakeFetch(signedIn({ 'PATCH /api/users/me': update }));
    renderApp('/profile');
    await openProfile();

    type('ステータスの絵文字', '');
    type('ステータスのテキスト', '');
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await screen.findByRole('status');
    expect(sentBody(update)).toEqual({ displayName: 'アリス', status: null });
  });

  it('絵文字とテキストの片方だけなら、送らずに理由を出す（ステータスは1セット）', async () => {
    const update = vi.fn<Handler>(() => json(200, PROFILE));
    fakeFetch(signedIn({ 'PATCH /api/users/me': update }));
    renderApp('/profile');
    await openProfile();

    type('ステータスのテキスト', '');
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await pause();

    expect((await screen.findByRole('alert')).textContent).toContain('両方');
    expect(update).not.toHaveBeenCalled();
  });

  it('断られたら理由を出し、入力を残す。画面の枠の表示名は変えない', async () => {
    fakeFetch(signedIn({ 'PATCH /api/users/me': () => error(400, 'validation_failed') }));
    renderApp('/profile');
    await openProfile();

    type('表示名', 'ありす');
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect((await screen.findByRole('alert')).textContent).toContain('入力の形が正しくありません');
    expect(valueOf('表示名')).toBe('ありす');
    expect(within(screen.getByRole('banner')).getByText('アリス')).toBeDefined();
  });

  it('プロフィールを読み込めなければ理由を出す', async () => {
    fakeFetch(
      signedIn({
        'GET /api/users/me': [
          () => json(200, WITH_STATUS),
          () => error(500, 'internal_error'),
        ] as unknown as Handler,
      }),
    );
    renderApp('/profile');

    expect((await screen.findByRole('alert')).textContent).toContain('読み込めませんでした');
  });
});
