import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json } from '../testing/fake-api';
import {
  BOB,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 12.1（F-30）: 検索の入力と結果の画面。ワークスペースの画面から開け、結果からチャンネル・メッセージへ移れる。#582。

const WORKSPACE_PATH = `/workspaces/${WORKSPACE_ID}`;
const SEARCH = (q: string) =>
  `GET /api/workspaces/${WORKSPACE_ID}/search?q=${encodeURIComponent(q)}`;
const SEARCH_PATH = (q: string) => `${WORKSPACE_PATH}/search?q=${encodeURIComponent(q)}`;
const GENERAL_REF = {
  id: GENERAL.id,
  name: 'general',
  visibility: 'PUBLIC',
  archived: false,
  joined: true,
};
const RANDOM = {
  id: '01920000-0000-7000-8000-0000000000c2',
  name: 'random',
  visibility: 'PUBLIC',
  archived: false,
  joined: false,
};

function hit(n: number, overrides: Record<string, unknown> = {}) {
  const { id, author, body, createdAt, editedAt, parentId } = message(n);
  return { id, channel: GENERAL_REF, parentId, author, body, createdAt, editedAt, ...overrides };
}

function result(overrides: Record<string, unknown> = {}) {
  return json(200, { messages: [], channels: [], users: [], ...overrides });
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('検索の画面（F-30）', () => {
  it('ワークスペースの画面で検索すると、結果の画面に移り、種別ごとのセクションに分けて出す', async () => {
    fakeFetch(
      routes({
        [`GET /api/workspaces/${WORKSPACE_ID}/members`]: () => json(200, []),
        [SEARCH('議事録')]: () =>
          result({
            messages: [hit(1, { body: '今日の議事録です' })],
            channels: [{ ...GENERAL_REF, name: 'giji' }],
            users: [BOB],
          }),
      }),
    );
    renderApp(WORKSPACE_PATH);

    fireEvent.change(await screen.findByRole('searchbox', { name: '検索' }), {
      target: { value: '議事録' },
    });
    fireEvent.click(screen.getByRole('button', { name: '検索する' }));

    const messages = within(await screen.findByRole('region', { name: 'メッセージ' }));
    expect(await messages.findByText('今日の議事録です')).toBeDefined();
    expect(messages.getByText('ボブ')).toBeDefined();
    const channels = within(screen.getByRole('region', { name: 'チャンネル' }));
    expect(channels.getByRole('link', { name: '# giji' })).toBeDefined();
    const users = within(screen.getByRole('region', { name: 'ユーザー' }));
    expect(users.getByText('ボブ（@bob）')).toBeDefined();
    // 入力欄は検索した文字列のまま
    expect((screen.getByRole('searchbox', { name: '検索' }) as HTMLInputElement).value).toBe(
      '議事録',
    );
  });

  it('メッセージの結果からチャンネルへ移れる。返信はスレッドを開いた状態で移る', async () => {
    const parent = message(1, { replyCount: 1 });
    const reply = message(2, { parentId: parent.id, body: '返信の議事録' });
    fakeFetch(
      routes({
        [SEARCH('議事録')]: () =>
          result({ messages: [hit(2, { parentId: parent.id, body: '返信の議事録' }), hit(1)] }),
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${MESSAGES}/${parent.id}/replies`]: () => page([reply]),
        [`PUT ${MESSAGES}/${parent.id}/read`]: () => new Response(null, { status: 204 }),
      }),
    );
    const { unmount } = renderApp(SEARCH_PATH('議事録'));

    const messages = within(await screen.findByRole('region', { name: 'メッセージ' }));
    fireEvent.click(await messages.findByRole('link', { name: '# general のスレッドで開く' }));
    const thread = within(await screen.findByRole('region', { name: 'スレッド' }));
    expect(await thread.findByText('返信の議事録')).toBeDefined();
    expect(screen.getByRole('heading', { name: '# general' })).toBeDefined();
    unmount();

    renderApp(SEARCH_PATH('議事録'));
    const again = within(await screen.findByRole('region', { name: 'メッセージ' }));
    fireEvent.click(await again.findByRole('link', { name: '# general で開く' }));
    expect(await screen.findByRole('heading', { name: '# general' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'スレッド' })).toBeNull();
  });

  it('参加しているチャンネルはチャンネルの画面へ、参加していないチャンネルはワークスペースの画面（参加の操作がある）へ移る', async () => {
    fakeFetch(
      routes({
        [`GET /api/workspaces/${WORKSPACE_ID}/members`]: () => json(200, []),
        [SEARCH('ran')]: () => result({ channels: [GENERAL_REF, RANDOM] }),
        [`GET ${MESSAGES}`]: () => page([]),
      }),
    );
    const { unmount } = renderApp(SEARCH_PATH('ran'));
    const channels = within(await screen.findByRole('region', { name: 'チャンネル' }));
    expect(channels.getByText('（未参加）')).toBeDefined();
    fireEvent.click(channels.getByRole('link', { name: '# random' }));
    expect(await screen.findByRole('list', { name: 'チャンネル' })).toBeDefined();
    unmount();

    renderApp(SEARCH_PATH('ran'));
    const again = within(await screen.findByRole('region', { name: 'チャンネル' }));
    fireEvent.click(again.getByRole('link', { name: '# general' }));
    expect(await screen.findByRole('heading', { name: '# general' })).toBeDefined();
  });

  it('退会した投稿者は「削除済みの利用者」、アーカイブ済みのチャンネルはそうと分かるように出し、当たらない種別は無いと出す', async () => {
    fakeFetch(
      routes({
        [SEARCH('昔')]: () =>
          result({
            messages: [
              hit(1, {
                author: null,
                body: '昔の話',
                channel: { ...GENERAL_REF, name: 'general-1', archived: true },
              }),
            ],
          }),
      }),
    );
    renderApp(SEARCH_PATH('昔'));

    const messages = within(await screen.findByRole('region', { name: 'メッセージ' }));
    expect(await messages.findByText('削除済みの利用者')).toBeDefined();
    expect(messages.getByText('（アーカイブ済み）')).toBeDefined();
    expect(screen.getByText('当たるチャンネルはありません。')).toBeDefined();
    expect(screen.getByText('当たるユーザーはありません。')).toBeDefined();
  });

  // CLAUDE.md「必ずテストを書く箇所」: Markdown が HTML として解釈されないこと（XSS）。
  it('本文は文字として出し、HTML として解釈しない', async () => {
    fakeFetch(
      routes({
        [SEARCH('img')]: () =>
          result({ messages: [hit(1, { body: '<img src=x onerror="alert(1)"> **太字**' })] }),
      }),
    );
    const { container } = renderApp(SEARCH_PATH('img'));

    const messages = within(await screen.findByRole('region', { name: 'メッセージ' }));
    expect(await messages.findByText('<img src=x onerror="alert(1)"> **太字**')).toBeDefined();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
  });

  it('断られたら理由を出す（in:# のチャンネルに参加していない・見つからない）', async () => {
    fakeFetch(
      routes({
        [SEARCH('in:#random a')]: () => error(403, 'not_a_channel_member'),
        [SEARCH('in:#nothing a')]: () => error(404, 'not_found'),
      }),
    );
    const { unmount } = renderApp(SEARCH_PATH('in:#random a'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'このチャンネルに参加していません。',
    );
    unmount();

    renderApp(SEARCH_PATH('in:#nothing a'));
    expect((await screen.findByRole('alert')).textContent).toContain('見つかりません');
  });

  it('空白だけの検索は送らない', async () => {
    const { count } = fakeFetch(routes({}));
    renderApp(SEARCH_PATH('  '));

    const input = await screen.findByRole('searchbox', { name: '検索' });
    fireEvent.change(input, { target: { value: '　' } });
    fireEvent.click(screen.getByRole('button', { name: '検索する' }));
    await pause();
    expect(count(SEARCH('  '))).toBe(0);
    expect(count(SEARCH('　'))).toBe(0);
    expect(screen.queryByRole('region', { name: 'メッセージ' })).toBeNull();
  });
});
