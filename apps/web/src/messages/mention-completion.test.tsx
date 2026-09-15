import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, headerOf, json } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 9.1（F-20）: 入力欄で `@` を打つと候補が補完される。
// 要件定義書のアクセシビリティ: メンション補完でフォーカスを閉じ込め、キーボードだけで操作できる。#494。

const CANDIDATES = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/mention-candidates`;
/** テストで使うもう1人の利用者（実在の人物ではない）。 */
const BOBBY = {
  id: '01920000-0000-7000-8000-000000000004',
  userId: 'bobby',
  displayName: 'ボビー',
};

function candidatesPath(prefix: string): string {
  return `${CANDIDATES}?${new URLSearchParams({ prefix })}`;
}

async function openChannel(extra: Parameters<typeof fakeFetch>[0] = {}, path = CHANNEL_PATH) {
  const fetch = fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1)]), ...extra }));
  renderApp(path);
  // スレッドを開いていると、親のメッセージ 1 は一覧とスレッドの2箇所に出る
  await screen.findAllByText('メッセージ 1');
  return fetch;
}

function input(name = 'メッセージ'): HTMLTextAreaElement {
  return screen.getByRole('combobox', { name }) as HTMLTextAreaElement;
}

/** 入力欄に書く（jsdom は値を入れるとカーソルを末尾に置く）。 */
function type(value: string, name = 'メッセージ') {
  fireEvent.change(input(name), { target: { value } });
}

function optionTexts(listbox: HTMLElement): string[] {
  return within(listbox)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('メンションの補完', () => {
  it('カーソルの前の `@` に続く文字で候補をトークンを付けて読み、表示名とユーザーID の一覧を出して先頭を選ぶ', async () => {
    const { calls } = await openChannel({
      [`GET ${candidatesPath('bo')}`]: () => json(200, [BOB, BOBBY]),
    });

    type('こんにちは @bo');

    const listbox = await screen.findByRole('listbox', { name: 'メンションの候補' });
    expect(optionTexts(listbox)).toEqual(['ボブ @bob', 'ボビー @bobby']);
    const [first] = within(listbox).getAllByRole('option');
    expect(first!.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(first!.id);
    const read = calls.find((c) => c.key === `GET ${candidatesPath('bo')}`)!;
    expect(headerOf(read.init, 'Authorization')).toBe('Bearer t1');
  });

  it('下矢印で次の候補を選び、Enter で `@ユーザーID ` に置き換えて一覧を閉じる。上矢印で戻る', async () => {
    const { count } = await openChannel({
      [`GET ${candidatesPath('bo')}`]: () => json(200, [BOB, BOBBY]),
    });
    type('こんにちは @bo');
    const listbox = await screen.findByRole('listbox', { name: 'メンションの候補' });

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const selected = within(listbox)
      .getAllByRole('option')
      .map((option) => option.getAttribute('aria-selected'));
    expect(selected).toEqual(['false', 'true']);

    // Enter の既定の動作（改行）はさせない
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(false);

    expect(input().value).toBe('こんにちは @bobby ');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(count(`POST ${MESSAGES}`)).toBe(0);
  });

  it('一覧を開いている間の Tab は候補を差し込み、フォーカスを入力欄の外へ出さない', async () => {
    await openChannel({ [`GET ${candidatesPath('bo')}`]: () => json(200, [BOB, BOBBY]) });
    type('@bo');
    await screen.findByRole('listbox', { name: 'メンションの候補' });

    expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(false);

    expect(input().value).toBe('@bob ');
  });

  it('Escape で一覧を閉じ、入力は変えない。一覧が無いときの Tab・Enter は妨げない', async () => {
    await openChannel({ [`GET ${candidatesPath('bo')}`]: () => json(200, [BOB]) });
    type('こんにちは @bo');
    await screen.findByRole('listbox', { name: 'メンションの候補' });

    expect(fireEvent.keyDown(input(), { key: 'Escape' })).toBe(false);

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(input().value).toBe('こんにちは @bo');
    expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(true);
  });

  it('候補を押すと差し込む', async () => {
    await openChannel({ [`GET ${candidatesPath('b')}`]: () => json(200, [BOB, BOBBY]) });
    type('@b');
    const listbox = await screen.findByRole('listbox', { name: 'メンションの候補' });

    fireEvent.click(within(listbox).getByRole('option', { name: 'ボビー @bobby' }));

    expect(input().value).toBe('@bobby ');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('`@` の無い入力と、英数字に続く `@` では候補を読まず、一覧を出さない', async () => {
    const { calls } = await openChannel();

    type('こんにちは');
    type('mail@bo');
    await pause();

    expect(calls.filter((c) => c.key.includes('mention-candidates'))).toEqual([]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('候補が0人なら一覧を出さない', async () => {
    const { count } = await openChannel({ [`GET ${candidatesPath('zz')}`]: () => json(200, []) });

    type('@zz');

    await waitFor(() => expect(count(`GET ${candidatesPath('zz')}`)).toBe(1));
    await pause();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('スレッドの返信の入力欄でも補完できる', async () => {
    const parent = message(1);
    await openChannel(
      {
        [`GET ${MESSAGES}/${parent.id}/replies`]: () => page([]),
        [`GET ${candidatesPath('bo')}`]: () => json(200, [BOB]),
      },
      `${CHANNEL_PATH}?thread=${parent.id}`,
    );
    const thread = within(await screen.findByRole('region', { name: 'スレッド' }));
    await thread.findByText('まだ返信はありません。');

    type('@bo', '返信');
    const listbox = await thread.findByRole('listbox', { name: 'メンションの候補' });
    fireEvent.keyDown(input('返信'), { key: 'Enter' });

    expect(optionTexts(listbox)).toEqual(['ボブ @bob']);
    expect(input('返信').value).toBe('@bob ');
  });
});
