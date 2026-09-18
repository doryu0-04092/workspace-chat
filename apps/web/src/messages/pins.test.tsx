import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, USER } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  message,
  page,
  PINS,
  routes,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 13.2（F-33）: ピン留めの web。メッセージのピン留めの付け外しと、チャンネルのピン留めの一覧。#584。

const PINNED_AT = '2026-09-17T00:00:00.000Z';

function pinPath(messageId: string): string {
  return `${MESSAGES}/${messageId}/pin`;
}

function pinOf(target: ReturnType<typeof message>, pinnedBy: typeof BOB | null = BOB) {
  return { message: target, pinnedBy, pinnedAt: PINNED_AT };
}

async function articleOf(text: string): Promise<HTMLElement> {
  return (await screen.findByText(text)).closest('article')!;
}

async function openPins() {
  fireEvent.click(await screen.findByRole('button', { name: 'ピン留めの一覧' }));
  return within(await screen.findByRole('region', { name: 'ピン留め' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('メッセージのピン留め（F-33）', () => {
  it('ピン留めしたメッセージには「ピン留め済み」と外す操作を出し、していないメッセージにはピン留めする操作を出す', async () => {
    const pinnedMessage = message(1);
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(2), pinnedMessage]),
        [`GET ${PINS}`]: () => json(200, { pins: [pinOf(pinnedMessage)] }),
      }),
    );
    renderApp(CHANNEL_PATH);

    const pinned = await articleOf('メッセージ 1');
    expect(await within(pinned).findByText('ピン留め済み')).toBeDefined();
    expect(within(pinned).getByRole('button', { name: 'ピン留めを外す' })).toBeDefined();
    const other = await articleOf('メッセージ 2');
    expect(within(other).queryByText('ピン留め済み')).toBeNull();
    expect(within(other).getByRole('button', { name: 'ピン留めする' })).toBeDefined();
  });

  it('ピン留めすると api に送り、応答で「ピン留め済み」にする（一覧を読み直さない）', async () => {
    const target = message(1);
    const { calls, count } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`PUT ${pinPath(target.id)}`]: () => json(200, pinOf(target, USER)),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    fireEvent.click(await within(article).findByRole('button', { name: 'ピン留めする' }));

    expect(await within(article).findByText('ピン留め済み')).toBeDefined();
    const put = calls.find((c) => c.key === `PUT ${pinPath(target.id)}`)!;
    expect(headerOf(put.init, 'Authorization')).toBe('Bearer t1');
    expect(count(`GET ${PINS}`)).toBe(1);
  });

  it('ピン留めを外すと api に送り、「ピン留め済み」を消す', async () => {
    const target = message(1);
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`GET ${PINS}`]: () => json(200, { pins: [pinOf(target)] }),
        [`DELETE ${pinPath(target.id)}`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    fireEvent.click(await within(article).findByRole('button', { name: 'ピン留めを外す' }));

    await waitFor(() => expect(within(article).queryByText('ピン留め済み')).toBeNull());
    expect(within(article).getByRole('button', { name: 'ピン留めする' })).toBeDefined();
  });

  it.each([
    {
      code: 'pin_limit_reached',
      status: 409,
      text: 'このチャンネルにピン留めできる件数の上限に達しています。',
    },
    { code: 'channel_archived', status: 409, text: 'アーカイブ済みのチャンネルです。' },
  ])('ピン留めが $code で断られたら理由を出す', async ({ code, status, text }) => {
    const target = message(1);
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`PUT ${pinPath(target.id)}`]: () => error(status, code),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');

    fireEvent.click(await within(article).findByRole('button', { name: 'ピン留めする' }));

    expect((await within(article).findByRole('alert')).textContent).toBe(text);
  });

  it('削除済みのメッセージには、ピン留めの操作を出さない', async () => {
    fakeFetch(
      routes({ [`GET ${MESSAGES}`]: () => page([message(1, { body: null, deleted: true })]) }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('このメッセージは削除されました');

    await screen.findByRole('button', { name: 'ピン留めの一覧' });
    expect(within(article).queryByRole('button', { name: /ピン留め/ })).toBeNull();
  });
});

describe('チャンネルのピン留めの一覧（F-33）', () => {
  it('押したときに一覧を出し、ピン留めしたメッセージの投稿者・本文・ピン留めした人を並べる。退会したピン留めした人は削除済みの利用者と出す', async () => {
    const first = message(1);
    const second = message(2, { author: USER });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([second, first]),
        [`GET ${PINS}`]: () => json(200, { pins: [pinOf(second), pinOf(first, null)] }),
      }),
    );
    renderApp(CHANNEL_PATH);

    const pins = await openPins();
    const items = await pins.findAllByRole('article');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('アリス');
    expect(items[0]!.textContent).toContain('メッセージ 2');
    expect(items[0]!.textContent).toContain('ピン留めした人: ボブ');
    expect(items[1]!.textContent).toContain('ピン留めした人: 削除済みの利用者');
  });

  it('ピン留めが無ければ無いと出す', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1)]) }));
    renderApp(CHANNEL_PATH);
    await articleOf('メッセージ 1');

    const pins = await openPins();
    expect(await pins.findByText('ピン留めしたメッセージはありません。')).toBeDefined();
  });

  it('一覧を読み込めなければ理由を出す', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(1)]),
        [`GET ${PINS}`]: () => error(500, 'internal_error'),
      }),
    );
    renderApp(CHANNEL_PATH);
    await articleOf('メッセージ 1');

    const pins = await openPins();
    expect((await pins.findByRole('alert')).textContent).toContain(
      'ピン留めを読み込めませんでした。',
    );
  });

  it('一覧から外すと api に送り、一覧から消す', async () => {
    const target = message(1);
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([target]),
        [`GET ${PINS}`]: () => json(200, { pins: [pinOf(target)] }),
        [`DELETE ${pinPath(target.id)}`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(CHANNEL_PATH);

    const pins = await openPins();
    fireEvent.click(await pins.findByRole('button', { name: 'ピン留めを外す' }));

    expect(await pins.findByText('ピン留めしたメッセージはありません。')).toBeDefined();
  });

  it('アーカイブ済みのチャンネルでは、一覧とピン留め済みは読めるが、付け外しの操作は出さない', async () => {
    const target = message(1);
    fakeFetch(
      routes({
        [`GET /api/workspaces/${WORKSPACE_ID}/channels`]: () => json(200, []),
        [`GET /api/workspaces/${WORKSPACE_ID}/archived-channels`]: () =>
          json(200, [{ ...GENERAL, name: 'general-1' }]),
        [`GET ${MESSAGES}`]: () => page([target]),
        [`GET ${PINS}`]: () => json(200, { pins: [pinOf(target)] }),
      }),
    );
    renderApp(CHANNEL_PATH);
    const article = await articleOf('メッセージ 1');
    expect(await within(article).findByText('ピン留め済み')).toBeDefined();

    const pins = await openPins();
    expect(await pins.findByText('ピン留めした人: ボブ')).toBeDefined();
    expect(screen.queryByRole('button', { name: /ピン留めする|ピン留めを外す/ })).toBeNull();
  });
});
