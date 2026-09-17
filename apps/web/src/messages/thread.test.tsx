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
  type TestMessage,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 6（F-17）: スレッドの画面。親に「N件の返信」と返信した人を出し、スレッドを開いて返信を読み書きする。

/** テストで使う3人目の利用者（実在の人物ではない）。 */
const CAROL = {
  id: '01920000-0000-7000-8000-000000000003',
  userId: 'carol',
  displayName: 'キャロル',
};

function reply(n: number, parent: TestMessage, overrides: Record<string, unknown> = {}) {
  return message(n, { parentId: parent.id, body: `返信 ${n}`, ...overrides });
}

function repliesPath(parent: { id: string }): string {
  return `${MESSAGES}/${parent.id}/replies`;
}

async function openThread() {
  return within(await screen.findByRole('region', { name: 'スレッド' }));
}

function texts(scope: ReturnType<typeof within>): string[] {
  return scope.getAllByRole('article').map((article: HTMLElement) => article.textContent ?? '');
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('チャンネルの一覧の返信の表示', () => {
  it('返信のあるメッセージには「N件の返信」と返信した人の表示名を出し、返信の無いメッセージには「返信する」を出す。削除済みで返信の無いメッセージには出さない', async () => {
    const parent = message(2, { replyCount: 2, replyParticipants: [BOB, CAROL] });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([message(3, { body: null, deleted: true }), parent, message(1)]),
      }),
    );
    renderApp(CHANNEL_PATH);

    const withReplies = (await screen.findByText('メッセージ 2')).closest('article')!;
    expect(within(withReplies).getByRole('button', { name: '2件の返信' })).toBeDefined();
    expect(within(withReplies).getByText('ボブ、キャロル')).toBeDefined();
    const noReplies = screen.getByText('メッセージ 1').closest('article')!;
    expect(within(noReplies).getByRole('button', { name: '返信する' })).toBeDefined();
    const deleted = screen.getByText('このメッセージは削除されました').closest('article')!;
    expect(within(deleted).queryByRole('button')).toBeNull();
  });
});

describe('スレッド', () => {
  it('「N件の返信」を押すとスレッドを開き、親と返信を上が古い順に並べる。返信はトークンを付けて読む', async () => {
    const parent = message(2, { replyCount: 2, replyParticipants: [BOB] });
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () => page([reply(4, parent), reply(3, parent)]),
      }),
    );
    renderApp(CHANNEL_PATH);

    fireEvent.click(await screen.findByRole('button', { name: '2件の返信' }));

    const thread = await openThread();
    await thread.findByText('返信 4');
    const shown = texts(thread);
    expect(shown[0]).toContain('メッセージ 2');
    expect(shown.slice(1).map((text) => text.match(/返信 \d/)?.[0])).toEqual(['返信 3', '返信 4']);
    const read = calls.find((c) => c.key === `GET ${repliesPath(parent)}`)!;
    expect(headerOf(read.init, 'Authorization')).toBe('Bearer t1');
  });

  it('URL の thread でスレッドを開いたまま画面を開き直せる。親が一覧に読み込まれていなくても返信は読める', async () => {
    const parent = message(9, { replyCount: 1 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(1)]),
        [`GET ${repliesPath(parent)}`]: () => page([reply(10, parent)]),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);

    const thread = await openThread();
    expect(await thread.findByText('返信 10')).toBeDefined();
  });

  // #538: 削除済みの親には api が返信を断る。**削除済みと分かったときだけ**入力欄を消し、返信の一覧は残す（機能一覧 4.2）
  it('親が削除済みなら、返信は読むが返信のフォームは出さない', async () => {
    const parent = message(2, { body: null, deleted: true, replyCount: 1 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () => page([reply(3, parent)]),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);

    const thread = await openThread();
    expect(await thread.findByText('返信 3')).toBeDefined();
    // 親はチャンネルの一覧が読み込まれてから出る。出る前は削除済みと分からない
    expect(await thread.findByText('このメッセージは削除されました')).toBeDefined();
    expect(thread.queryByLabelText('返信')).toBeNull();
    expect(thread.queryByRole('button', { name: '返信を送信する' })).toBeNull();
  });

  // 親が一覧に読み込まれていなければ、削除済みかは分からない。分からないときは消さない——消すと、読み込んだページより古い親に返信できなくなる
  it('親が一覧に読み込まれていなければ、返信のフォームを出す', async () => {
    const parent = message(9, { replyCount: 1 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(1)]),
        [`GET ${repliesPath(parent)}`]: () => page([reply(10, parent)]),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);

    const thread = await openThread();
    await thread.findByText('返信 10');
    await screen.findByText('メッセージ 1');
    expect(thread.getByLabelText('返信')).toBeDefined();
    expect(thread.getByRole('button', { name: '返信を送信する' })).toBeDefined();
  });

  it('「スレッドを閉じる」でスレッドを閉じる', async () => {
    const parent = message(2, { replyCount: 1 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () => page([reply(3, parent)]),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = await openThread();
    await thread.findByText('返信 3');

    fireEvent.click(thread.getByRole('button', { name: 'スレッドを閉じる' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'スレッド' })).toBeNull());
  });

  it('返信を送ると本文を送り、応答を返信の最後に足して入力欄を空にする（返信は読み直さない）', async () => {
    const parent = message(2, { replyCount: 1 });
    const mine = reply(5, parent, { author: USER, body: 'わかった' });
    const { calls, count } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () => page([reply(3, parent)]),
        [`POST ${repliesPath(parent)}`]: () => json(201, mine),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = await openThread();
    await thread.findByText('返信 3');

    fireEvent.change(thread.getByLabelText('返信'), { target: { value: 'わかった' } });
    fireEvent.click(thread.getByRole('button', { name: '返信を送信する' }));

    await waitFor(() => expect(texts(thread).at(-1)).toContain('わかった'));
    const post = calls.find((c) => c.key === `POST ${repliesPath(parent)}`)!;
    expect(JSON.parse(String(post.init.body))).toEqual({ body: 'わかった' });
    expect(headerOf(post.init, 'Authorization')).toBe('Bearer t1');
    await waitFor(() =>
      expect((thread.getByLabelText('返信') as HTMLTextAreaElement).value).toBe(''),
    );
    expect(count(`GET ${repliesPath(parent)}`)).toBe(1);
  });

  it('返信を送れなければ理由を出し、入力を残す。空・空白だけでは送信のボタンを押せない', async () => {
    const parent = message(2, { replyCount: 0 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () => page([]),
        [`POST ${repliesPath(parent)}`]: () => error(409, 'channel_archived'),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = await openThread();
    await thread.findByText('まだ返信はありません。');

    const send = thread.getByRole('button', { name: '返信を送信する' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(thread.getByLabelText('返信'), { target: { value: ' \n ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(thread.getByLabelText('返信'), { target: { value: 'わかった' } });
    fireEvent.click(send);

    expect((await thread.findByRole('alert')).textContent).toContain(
      'アーカイブ済みのチャンネルです',
    );
    expect((thread.getByLabelText('返信') as HTMLTextAreaElement).value).toBe('わかった');
  });

  it('返信を読み込めなければ理由を出す', async () => {
    const parent = message(2, { replyCount: 1 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () => error(404, 'not_found'),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = await openThread();

    const alert = await thread.findByRole('alert');
    expect(alert.textContent).toContain('返信を読み込めませんでした');
    expect(alert.textContent).toContain('見つかりません');
  });

  it('続きがあれば、古い返信を before を付けて読み、上に足す', async () => {
    const parent = message(2, { replyCount: 3 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () =>
          page([reply(5, parent), reply(4, parent)], reply(4, parent).id),
        [`GET ${repliesPath(parent)}?before=${reply(4, parent).id}`]: () =>
          page([reply(3, parent)]),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = await openThread();
    await thread.findByText('返信 5');

    fireEvent.click(thread.getByRole('button', { name: '古い返信を読み込む' }));

    await thread.findByText('返信 3');
    expect(
      texts(thread)
        .slice(1)
        .map((text) => text.match(/返信 \d/)?.[0]),
    ).toEqual(['返信 3', '返信 4', '返信 5']);
    expect(thread.queryByRole('button', { name: '古い返信を読み込む' })).toBeNull();
  });
});

describe('スレッドの配信の反映', () => {
  async function openWithSocket(parent: TestMessage, replies: TestMessage[]) {
    const fetch = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${repliesPath(parent)}`]: () => page(replies),
      }),
    );
    const view = renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = await openThread();
    await thread.findByText(replies[0]?.body ?? 'まだ返信はありません。');
    const socket = view.sockets.at(-1)!;
    act(() => socket.open());
    // 入室できたら一覧を読み直す（開いているスレッドの返信も読み直す）
    await waitFor(() => expect(fetch.count(`GET ${repliesPath(parent)}`)).toBe(2));
    await pause();
    return { ...fetch, socket, thread };
  }

  it('開いているスレッドの返信の message:new を返信の最後に足し、同じ id は2行にしない。ほかのスレッドの返信は足さない', async () => {
    const parent = message(2, { replyCount: 1 });
    const other = message(7);
    const { socket, thread } = await openWithSocket(parent, [reply(3, parent)]);

    act(() => socket.deliver('message:new', { message: reply(4, parent), sentAt: SENT_AT }));
    await waitFor(() => expect(texts(thread).at(-1)).toContain('返信 4'));
    act(() => socket.deliver('message:new', { message: reply(4, parent), sentAt: SENT_AT }));
    act(() => socket.deliver('message:new', { message: reply(8, other), sentAt: SENT_AT }));
    await pause();

    expect(thread.getAllByText('返信 4')).toHaveLength(1);
    expect(thread.queryByText('返信 8')).toBeNull();
  });

  it('返信の message:updated で本文を置き換え、message:deleted で「このメッセージは削除されました」に置き換える', async () => {
    const parent = message(2, { replyCount: 2 });
    const { socket, thread } = await openWithSocket(parent, [reply(4, parent), reply(3, parent)]);

    act(() =>
      socket.deliver('message:updated', {
        message: reply(3, parent, { body: '直した返信', editedAt: SENT_AT }),
        sentAt: SENT_AT,
      }),
    );
    await thread.findByText('直した返信');
    act(() =>
      socket.deliver('message:deleted', {
        channelId: GENERAL.id,
        messageId: reply(4, parent).id,
        sentAt: SENT_AT,
      }),
    );

    await thread.findByText('このメッセージは削除されました');
    expect(thread.queryByText('返信 4')).toBeNull();
  });

  it('開いているスレッドの親の message:deleted で、返信のフォームを消し、返信は残す', async () => {
    const parent = message(2, { replyCount: 1 });
    const { socket, thread } = await openWithSocket(parent, [reply(3, parent)]);
    expect(thread.getByLabelText('返信')).toBeDefined();

    act(() =>
      socket.deliver('message:deleted', {
        channelId: GENERAL.id,
        messageId: parent.id,
        sentAt: SENT_AT,
      }),
    );

    await thread.findByText('このメッセージは削除されました');
    await waitFor(() => expect(thread.queryByLabelText('返信')).toBeNull());
    expect(thread.queryByRole('button', { name: '返信を送信する' })).toBeNull();
    expect(thread.getByText('返信 3')).toBeDefined();
  });

  it('件数が変わった親の message:updated で、一覧の「N件の返信」と返信した人を置き換える', async () => {
    const parent = message(2, { replyCount: 1, replyParticipants: [BOB] });
    const { socket } = await openWithSocket(parent, [reply(3, parent)]);
    const list = screen.getByRole('region', { name: 'メッセージの一覧' });
    expect(within(list).getByRole('button', { name: '1件の返信' })).toBeDefined();

    act(() =>
      socket.deliver('message:updated', {
        message: { ...parent, replyCount: 2, replyParticipants: [CAROL, BOB] },
        sentAt: SENT_AT,
      }),
    );

    expect(await within(list).findByRole('button', { name: '2件の返信' })).toBeDefined();
    expect(within(list).getByText('キャロル、ボブ')).toBeDefined();
  });
});
