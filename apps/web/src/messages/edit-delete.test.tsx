import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, USER } from '../testing/fake-api';
import { CHANNEL_PATH, MESSAGES, message, page, routes } from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

/** 自分（ログインしている利用者）のメッセージ。 */
function mine(n: number, overrides: Record<string, unknown> = {}) {
  return message(n, { author: USER, ...overrides });
}

async function articleOf(text: string): Promise<HTMLElement> {
  return (await screen.findByText(text)).closest('article')!;
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

// 機能一覧 4.2（F-13）: 自分のメッセージの編集・削除の web。#535。
describe('編集・削除の操作を出す相手', () => {
  it('自分のメッセージには編集と削除を出し、他人のメッセージと削除済みのメッセージには出さない', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([mine(3, { body: null, deleted: true }), message(2), mine(1)]),
      }),
    );
    renderApp(CHANNEL_PATH);

    const own = await articleOf('メッセージ 1');
    expect(within(own).getByRole('button', { name: '編集する' })).toBeDefined();
    expect(within(own).getByRole('button', { name: '削除する' })).toBeDefined();
    const others = await articleOf('メッセージ 2');
    expect(within(others).queryByRole('button', { name: '編集する' })).toBeNull();
    expect(within(others).queryByRole('button', { name: '削除する' })).toBeNull();
    const deleted = await articleOf('このメッセージは削除されました');
    expect(within(deleted).queryByRole('button', { name: '編集する' })).toBeNull();
    expect(within(deleted).queryByRole('button', { name: '削除する' })).toBeNull();
  });

  // 機能一覧 4.2 は、操作を出す場所を「チャンネルの一覧・スレッドの親・スレッドの返信」の3つに挙げる。
  // **スレッドの親は `PagedMessages` を通らず、`ThreadPanel` が直接描く別の経路である**（#537）
  it('スレッドの親が自分のメッセージなら、スレッドの中の親にも編集と削除を出す', async () => {
    const parent = mine(2, { replyCount: 1 });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${MESSAGES}/${parent.id}/replies`]: () => page([message(3, { parentId: parent.id })]),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = within(await screen.findByRole('region', { name: 'スレッド' }));

    // 親はチャンネルの一覧が読み込まれてから出る。編集していないので、本文の文字は入力欄には無い
    const own = (await thread.findByText('メッセージ 2')).closest('article')!;
    expect(within(own).getByRole('button', { name: '編集する' })).toBeDefined();
    expect(within(own).getByRole('button', { name: '削除する' })).toBeDefined();
    // 返信は他人のメッセージで、出さない（取り違えていないことの確認）
    const others = (await thread.findByText('メッセージ 3')).closest('article')!;
    expect(within(others).queryByRole('button', { name: '編集する' })).toBeNull();
  });
});

describe('編集（F-13）', () => {
  it('編集すると本文を api に送り、その場で置き換えて「（編集済み）」を付ける', async () => {
    const edited = mine(1, { body: '直した本文', editedAt: '2026-09-16T00:00:00.000Z' });
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([mine(1)]),
        [`PATCH ${MESSAGES}/${edited.id}`]: () => json(200, edited),
      }),
    );
    renderApp(CHANNEL_PATH);
    const own = await articleOf('メッセージ 1');

    fireEvent.click(within(own).getByRole('button', { name: '編集する' }));
    const input = within(own).getByLabelText('メッセージを編集');
    expect((input as HTMLTextAreaElement).value).toBe('メッセージ 1');
    fireEvent.change(input, { target: { value: '直した本文' } });
    fireEvent.click(within(own).getByRole('button', { name: '保存する' }));

    // **本文の文字で待たない**——保存が通るまで、その文字は編集中の入力欄にもあり、そちらを掴むと入力欄が外れた後にたどれない
    const after = (await screen.findByText('（編集済み）')).closest('article')!;
    expect(within(after).getByText('直した本文')).toBeDefined();
    expect(within(after).queryByLabelText('メッセージを編集')).toBeNull();
    const patch = calls.find((c) => c.key === `PATCH ${MESSAGES}/${edited.id}`)!;
    expect(JSON.parse(String(patch.init.body))).toEqual({ body: '直した本文' });
    expect(headerOf(patch.init, 'Authorization')).toBe('Bearer t1');
  });

  it('取り消すと送らず、元の本文のまま戻る', async () => {
    const { count } = fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([mine(1)]) }));
    renderApp(CHANNEL_PATH);
    const own = await articleOf('メッセージ 1');

    fireEvent.click(within(own).getByRole('button', { name: '編集する' }));
    fireEvent.change(within(own).getByLabelText('メッセージを編集'), {
      target: { value: '書きかけ' },
    });
    fireEvent.click(within(own).getByRole('button', { name: '取り消す' }));
    await pause();

    expect(await screen.findByText('メッセージ 1')).toBeDefined();
    expect(screen.queryByLabelText('メッセージを編集')).toBeNull();
    expect(count(`PATCH ${MESSAGES}/${mine(1).id}`)).toBe(0);
  });

  it('空・空白だけでは保存できない', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([mine(1)]) }));
    renderApp(CHANNEL_PATH);
    const own = await articleOf('メッセージ 1');

    fireEvent.click(within(own).getByRole('button', { name: '編集する' }));
    fireEvent.change(within(own).getByLabelText('メッセージを編集'), {
      target: { value: '  \n ' },
    });

    expect(
      (within(own).getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it.each([
    { code: 'not_message_author', status: 403, text: '自分のメッセージだけを編集・削除できます' },
    { code: 'channel_archived', status: 409, text: 'アーカイブ済みのチャンネルです' },
  ])('編集が $code で断られたら理由を出し、入力を残す', async ({ code, status, text }) => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([mine(1)]),
        [`PATCH ${MESSAGES}/${mine(1).id}`]: () => error(status, code),
      }),
    );
    renderApp(CHANNEL_PATH);
    const own = await articleOf('メッセージ 1');

    fireEvent.click(within(own).getByRole('button', { name: '編集する' }));
    fireEvent.change(within(own).getByLabelText('メッセージを編集'), {
      target: { value: '直したい' },
    });
    fireEvent.click(within(own).getByRole('button', { name: '保存する' }));

    expect((await within(own).findByRole('alert')).textContent).toContain(text);
    expect((within(own).getByLabelText('メッセージを編集') as HTMLTextAreaElement).value).toBe(
      '直したい',
    );
  });

  // **スレッドの返信の鍵は、チャンネルの一覧の鍵の下にある**（messages/queries.ts）。反映がチャンネルの一覧にしか届かないと、
  // スレッドで直した返信が、スレッドの中では古い本文のまま残る。
  it('スレッドの返信を編集すると、スレッドの中で置き換える', async () => {
    const parent = message(2, { replyCount: 1 });
    const reply = mine(3, { parentId: parent.id });
    const edited = { ...reply, body: '返信を直した', editedAt: '2026-09-16T00:00:00.000Z' };
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${MESSAGES}/${parent.id}/replies`]: () => page([reply]),
        [`PATCH ${MESSAGES}/${reply.id}`]: () => json(200, edited),
      }),
    );
    renderApp(`${CHANNEL_PATH}?thread=${parent.id}`);
    const thread = within(await screen.findByRole('region', { name: 'スレッド' }));
    const own = (await thread.findByText('メッセージ 3')).closest('article')!;

    fireEvent.click(within(own).getByRole('button', { name: '編集する' }));
    fireEvent.change(within(own).getByLabelText('メッセージを編集'), {
      target: { value: '返信を直した' },
    });
    fireEvent.click(within(own).getByRole('button', { name: '保存する' }));

    // 本文の文字では待たない（入力欄の文字も当たり、置き換わらない実装でも通る）。「（編集済み）」の付いた行の本文を見る
    const after = (await thread.findByText('（編集済み）')).closest('article')!;
    expect(within(after).getByText('返信を直した')).toBeDefined();
    expect(within(after).queryByLabelText('メッセージを編集')).toBeNull();
  });
});

describe('削除（F-13）', () => {
  it('確かめてから api に送り、「このメッセージは削除されました」に置き換える', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([mine(1)]),
        [`DELETE ${MESSAGES}/${mine(1).id}`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(CHANNEL_PATH);
    const own = await articleOf('メッセージ 1');

    fireEvent.click(within(own).getByRole('button', { name: '削除する' }));

    expect(await screen.findByText('このメッセージは削除されました')).toBeDefined();
    expect(screen.queryByText('メッセージ 1')).toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
    const remove = calls.find((c) => c.key === `DELETE ${MESSAGES}/${mine(1).id}`)!;
    expect(headerOf(remove.init, 'Authorization')).toBe('Bearer t1');
  });

  it('確かめを取り消したら送らない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { count } = fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([mine(1)]) }));
    renderApp(CHANNEL_PATH);
    const own = await articleOf('メッセージ 1');

    fireEvent.click(within(own).getByRole('button', { name: '削除する' }));
    // **要求は非同期で出る**ので、送ってしまう実装でもクリックの直後はまだ 0 である。出る分だけ待ってから数える
    await pause();

    expect(count(`DELETE ${MESSAGES}/${mine(1).id}`)).toBe(0);
    expect(screen.getByText('メッセージ 1')).toBeDefined();
  });

  it('削除が断られたら理由を出し、本文は残す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([mine(1)]),
        [`DELETE ${MESSAGES}/${mine(1).id}`]: () => error(409, 'channel_archived'),
      }),
    );
    renderApp(CHANNEL_PATH);
    const own = await articleOf('メッセージ 1');

    fireEvent.click(within(own).getByRole('button', { name: '削除する' }));

    expect((await within(own).findByRole('alert')).textContent).toContain(
      'アーカイブ済みのチャンネルです',
    );
    await waitFor(() => expect(screen.getByText('メッセージ 1')).toBeDefined());
  });
});
