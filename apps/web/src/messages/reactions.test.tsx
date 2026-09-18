import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, USER } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  SENT_AT,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 7（F-18）: 絵文字リアクションの web。メッセージにリアクションを出し、付け外しし、reaction:changed を反映する。#583。

const THUMBS = '👍';
const PARTY = '🎉';

function reactionPath(messageId: string, emoji: string): string {
  return `${MESSAGES}/${messageId}/reactions/${encodeURIComponent(emoji)}`;
}

async function articleOf(text: string): Promise<HTMLElement> {
  return (await screen.findByText(text)).closest('article')!;
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('リアクションの表示（F-18）', () => {
  it('メッセージに絵文字と人数を出し、付けた人の表示名を読めるようにする。自分が付けたものは押されている状態にする', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([
            message(1, {
              reactions: [
                { emoji: THUMBS, count: 2, users: [BOB, USER] },
                // 退会した利用者は users に載らず、人数には残る
                { emoji: PARTY, count: 2, users: [BOB] },
              ],
            }),
          ]),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    const thumbs = within(article).getByRole('button', { name: /^👍 2人/ });
    expect(thumbs.getAttribute('aria-pressed')).toBe('true');
    expect(thumbs.textContent).toContain('2');
    expect(thumbs.getAttribute('title')).toBe('ボブ、アリス');
    const party = within(article).getByRole('button', { name: /^🎉 2人/ });
    expect(party.getAttribute('aria-pressed')).toBe('false');
    expect(party.getAttribute('title')).toBe('ボブ、削除済みの利用者 1人');
  });

  it('削除済みのメッセージにはリアクションも付ける操作も出さない', async () => {
    fakeFetch(
      routes({ [`GET ${MESSAGES}`]: () => page([message(1, { body: null, deleted: true })]) }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('このメッセージは削除されました');

    expect(within(article).queryByRole('button', { name: 'リアクションを付ける' })).toBeNull();
  });

  it('アーカイブ済みのチャンネルでは、リアクションは読めるが、付け外しの操作は出さない', async () => {
    fakeFetch(
      routes({
        [`GET /api/workspaces/${WORKSPACE_ID}/channels`]: () => json(200, []),
        [`GET /api/workspaces/${WORKSPACE_ID}/archived-channels`]: () =>
          json(200, [{ ...GENERAL, name: 'general-1' }]),
        [`GET ${MESSAGES}`]: () =>
          page([message(1, { reactions: [{ emoji: THUMBS, count: 1, users: [BOB] }] })]),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    expect(within(article).getByText(/👍/).getAttribute('title')).toBe('ボブ');
    expect(within(article).queryByRole('button', { name: /👍/ })).toBeNull();
    expect(within(article).queryByRole('button', { name: 'リアクションを付ける' })).toBeNull();
  });
});

describe('リアクションの付け外し（F-18）', () => {
  it('付けていない絵文字を押すと付け（PUT）、応答のリアクションで置き換える', async () => {
    const target = message(1, { reactions: [{ emoji: THUMBS, count: 1, users: [BOB] }] });
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`PUT ${reactionPath(target.id, THUMBS)}`]: () =>
          json(200, {
            channelId: GENERAL.id,
            messageId: target.id,
            reactions: [{ emoji: THUMBS, count: 2, users: [BOB, USER] }],
          }),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    fireEvent.click(within(article).getByRole('button', { name: /^👍 1人/ }));

    const after = await within(article).findByRole('button', { name: /^👍 2人/ });
    expect(after.getAttribute('aria-pressed')).toBe('true');
    const put = calls.find((c) => c.key === `PUT ${reactionPath(target.id, THUMBS)}`)!;
    expect(headerOf(put.init, 'Authorization')).toBe('Bearer t1');
  });

  it('自分が付けている絵文字を押すと外し（DELETE）、0 人になった絵文字は出さない', async () => {
    const target = message(1, { reactions: [{ emoji: THUMBS, count: 1, users: [USER] }] });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`DELETE ${reactionPath(target.id, THUMBS)}`]: () =>
          json(200, { channelId: GENERAL.id, messageId: target.id, reactions: [] }),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    fireEvent.click(within(article).getByRole('button', { name: /^👍 1人/ }));

    await waitFor(() => expect(within(article).queryByRole('button', { name: /^👍/ })).toBeNull());
  });

  it('「リアクションを付ける」から絵文字を選ぶと付け、選ぶ欄を閉じる', async () => {
    const target = message(1);
    const { count } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`PUT ${reactionPath(target.id, PARTY)}`]: () =>
          json(200, {
            channelId: GENERAL.id,
            messageId: target.id,
            reactions: [{ emoji: PARTY, count: 1, users: [USER] }],
          }),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    fireEvent.click(within(article).getByRole('button', { name: 'リアクションを付ける' }));
    fireEvent.click(within(article).getByRole('button', { name: `${PARTY} を付ける` }));

    expect(await within(article).findByRole('button', { name: /^🎉 1人/ })).toBeDefined();
    expect(within(article).queryByRole('button', { name: `${PARTY} を付ける` })).toBeNull();
    expect(count(`PUT ${reactionPath(target.id, PARTY)}`)).toBe(1);
  });

  it.each([
    { code: 'channel_archived', status: 409, text: 'アーカイブ済みのチャンネルです。' },
    {
      code: 'reaction_limit_reached',
      status: 409,
      text: 'このメッセージに付けられる絵文字の種類の上限に達しています。',
    },
  ])('付けるのが $code で断られたら理由を出す', async ({ code, status, text }) => {
    const target = message(1, { reactions: [{ emoji: THUMBS, count: 1, users: [BOB] }] });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`PUT ${reactionPath(target.id, THUMBS)}`]: () => error(status, code),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    fireEvent.click(within(article).getByRole('button', { name: /^👍 1人/ }));

    expect((await within(article).findByRole('alert')).textContent).toBe(text);
  });
});

describe('リアクションのリアルタイムの反映（reaction:changed）', () => {
  async function openWithSocket(messages: ReturnType<typeof message>[], thread?: string) {
    const parent = messages[0]!;
    const fetch = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page(messages),
        [`GET ${MESSAGES}/${parent.id}/replies`]: () =>
          page([message(3, { parentId: parent.id, body: '返信 3' })]),
      }),
    );
    const view = renderApp(thread ? `${CHANNEL_PATH}?thread=${thread}` : CHANNEL_PATH);
    await screen.findAllByText('メッセージ 2');
    const socket = view.sockets.at(-1)!;
    act(() => socket.open());
    await waitFor(() => expect(fetch.count(`GET ${MESSAGES}`)).toBe(2));
    await pause();
    return { ...fetch, socket };
  }

  it('開いているチャンネルのメッセージのリアクションを置き換え、ほかのチャンネルの配信は当てない', async () => {
    const target = message(2, { replyCount: 1 });
    const { socket } = await openWithSocket([target]);
    const list = screen.getByRole('region', { name: 'メッセージの一覧' });

    act(() =>
      socket.deliver('reaction:changed', {
        channelId: GENERAL.id,
        messageId: target.id,
        reactions: [{ emoji: THUMBS, count: 1, users: [BOB] }],
        sentAt: SENT_AT,
      }),
    );
    const thumbs = await within(list).findByRole('button', { name: /^👍 1人/ });
    // 配信は閲覧者によらない値であり、自分が付けたかは users から決める
    expect(thumbs.getAttribute('aria-pressed')).toBe('false');

    // **ほかのチャンネルの配信は、同じ id のメッセージがあっても当てない**（後から届いても置き換えない）
    act(() =>
      socket.deliver('reaction:changed', {
        channelId: '01920000-0000-7000-8000-0000000000c9',
        messageId: target.id,
        reactions: [{ emoji: PARTY, count: 9, users: [BOB] }],
        sentAt: SENT_AT,
      }),
    );
    await pause();
    expect(within(list).getByRole('button', { name: /^👍 1人/ })).toBeDefined();
    expect(within(list).queryByRole('button', { name: /^🎉/ })).toBeNull();
  });

  it('開いているスレッドの返信のリアクションにも反映する', async () => {
    const target = message(2, { replyCount: 1 });
    const { socket } = await openWithSocket([target], target.id);
    const thread = within(await screen.findByRole('region', { name: 'スレッド' }));
    const reply = (await thread.findByText('返信 3')).closest('article')!;

    act(() =>
      socket.deliver('reaction:changed', {
        channelId: GENERAL.id,
        messageId: message(3).id,
        reactions: [{ emoji: THUMBS, count: 1, users: [USER] }],
        sentAt: SENT_AT,
      }),
    );

    const thumbs = await within(reply).findByRole('button', { name: /^👍 1人/ });
    expect(thumbs.getAttribute('aria-pressed')).toBe('true');
  });
});
