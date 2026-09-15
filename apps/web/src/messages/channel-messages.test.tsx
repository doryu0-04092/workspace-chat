import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, PROFILE, token, USER } from '../testing/fake-api';
import { renderApp } from '../testing/render-app';

const WORKSPACE_ID = '01920000-0000-7000-8000-0000000000a1';
const GENERAL = {
  id: '01920000-0000-7000-8000-0000000000c1',
  name: 'general',
  visibility: 'PUBLIC',
  joined: true,
};
/** テストで使うもう1人の利用者（実在の人物ではない）。 */
const BOB = { id: '01920000-0000-7000-8000-000000000002', userId: 'bob', displayName: 'ボブ' };

const CHANNEL_PATH = `/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}`;
const MESSAGES = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/messages`;

function message(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    channelId: GENERAL.id,
    author: BOB,
    body: `メッセージ ${n}`,
    createdAt: `2026-09-14T00:0${n}:00.000Z`,
    editedAt: null,
    deleted: false,
    parentId: null,
    replyCount: 0,
    replyParticipants: [],
    mentions: [],
    ...overrides,
  };
}

function page(messages: ReturnType<typeof message>[], nextBefore: string | null = null) {
  return json(200, { messages, nextBefore });
}

function routes(extra: Parameters<typeof fakeFetch>[0] = {}) {
  return {
    'POST /api/auth/refresh': () => token('t1'),
    'GET /api/users/me': () => json(200, PROFILE),
    [`GET /api/workspaces/${WORKSPACE_ID}/channels`]: () => json(200, [GENERAL]),
    ...extra,
  };
}

function articles(): HTMLElement[] {
  return screen.getAllByRole('article');
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('チャンネルのメッセージの表示', () => {
  it('メッセージをトークンを付けて読み、上が古く下が新しい順に並べる', async () => {
    const { calls } = fakeFetch(
      routes({ [`GET ${MESSAGES}`]: () => page([message(3), message(2), message(1)]) }),
    );
    renderApp(CHANNEL_PATH);

    await screen.findByText('メッセージ 3');
    expect(articles().map((a) => within(a).getByText(/^メッセージ \d$/).textContent)).toEqual([
      'メッセージ 1',
      'メッセージ 2',
      'メッセージ 3',
    ]);
    const list = calls.find((c) => c.key === `GET ${MESSAGES}`)!;
    expect(headerOf(list.init, 'Authorization')).toBe('Bearer t1');
  });

  it('投稿者の表示名を出し、本文を Markdown として描画する', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1, { body: '**太字**' })]) }));
    renderApp(CHANNEL_PATH);

    const strong = await screen.findByText('太字');
    expect(strong.tagName).toBe('STRONG');
    const article = strong.closest('article')!;
    expect(within(article).getByText('ボブ')).toBeDefined();
  });

  it('退会した投稿者（author が null）は「削除済みの利用者」と出す', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1, { author: null })]) }));
    renderApp(CHANNEL_PATH);

    const article = (await screen.findByText('メッセージ 1')).closest('article')!;
    expect(within(article).getByText('削除済みの利用者')).toBeDefined();
  });

  it('編集したメッセージには「編集済み」を出し、編集していなければ出さない', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([message(2, { editedAt: '2026-09-14T01:00:00.000Z' }), message(1)]),
      }),
    );
    renderApp(CHANNEL_PATH);

    const edited = (await screen.findByText('メッセージ 2')).closest('article')!;
    expect(within(edited).getByText('（編集済み）')).toBeDefined();
    const plain = screen.getByText('メッセージ 1').closest('article')!;
    expect(within(plain).queryByText('（編集済み）')).toBeNull();
  });

  it('削除したメッセージは「このメッセージは削除されました」に置き換え、編集していても「編集済み」を出さない', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([message(1, { body: null, deleted: true, editedAt: '2026-09-14T01:00:00.000Z' })]),
      }),
    );
    renderApp(CHANNEL_PATH);

    const article = (await screen.findByText('このメッセージは削除されました')).closest('article')!;
    expect(within(article).queryByText('（編集済み）')).toBeNull();
  });

  it('続きがあれば、古いメッセージを before を付けて読み、上に足す。既に出ていたメッセージの位置は動かさない', async () => {
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(4), message(3)], message(3).id),
        [`GET ${MESSAGES}?before=${message(3).id}`]: () => page([message(2), message(1)]),
      }),
    );
    renderApp(CHANNEL_PATH);

    // data-item-index は firstItemIndex を足した行の番号（data-index は描いている行の中の順番で、先頭に足すと変わる）
    const indexOf = (text: string) =>
      screen.getByText(text).closest('[data-item-index]')!.getAttribute('data-item-index');
    await screen.findByText('メッセージ 4');
    const before = { three: indexOf('メッセージ 3'), four: indexOf('メッセージ 4') };

    fireEvent.click(screen.getByRole('button', { name: '古いメッセージを読み込む' }));

    await screen.findByText('メッセージ 1');
    expect(articles().map((a) => within(a).getByText(/^メッセージ \d$/).textContent)).toEqual([
      'メッセージ 1',
      'メッセージ 2',
      'メッセージ 3',
      'メッセージ 4',
    ]);
    expect({ three: indexOf('メッセージ 3'), four: indexOf('メッセージ 4') }).toEqual(before);
    const older = calls.find((c) => c.key.includes('?before='))!;
    expect(headerOf(older.init, 'Authorization')).toBe('Bearer t1');
    expect(screen.queryByRole('button', { name: '古いメッセージを読み込む' })).toBeNull();
  });

  it('古いメッセージを読み込めなければ理由を出し、出ていたメッセージは残す', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(2)], message(2).id),
        [`GET ${MESSAGES}?before=${message(2).id}`]: () => error(500, 'internal_error'),
      }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByText('メッセージ 2');

    fireEvent.click(screen.getByRole('button', { name: '古いメッセージを読み込む' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      '古いメッセージを読み込めませんでした',
    );
    expect(screen.getByText('メッセージ 2')).toBeDefined();
  });

  it('メッセージが無ければ、無いことを出す', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([]) }));
    renderApp(CHANNEL_PATH);

    expect(await screen.findByText('まだメッセージはありません。')).toBeDefined();
  });

  it('URL のパラメータは符号化してメッセージの api のパスに埋め、パスの区切りとして読ませない（利用者が書ける値のため）', async () => {
    // react-router の useParams は %2F を / に復号して返す。符号化しないと /api/auth/logout などへ要求が向く
    const encoded = encodeURIComponent('../../auth/logout');
    const { calls } = fakeFetch(
      routes({
        [`GET /api/workspaces/${encoded}/channels`]: () => json(200, [GENERAL]),
        [`GET /api/workspaces/${encoded}/channels/${GENERAL.id}/messages`]: () =>
          page([message(1)]),
      }),
    );
    renderApp(`/workspaces/${encoded}/channels/${GENERAL.id}`);

    expect(await screen.findByText('メッセージ 1')).toBeDefined();
    expect(calls.map((c) => c.key).filter((key) => key.includes('../'))).toEqual([]);
  });

  it('読み込めなければ理由を出す。参加していなければ（403）、参加していないことを出す', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => error(403, 'not_a_channel_member') }));
    renderApp(CHANNEL_PATH);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('メッセージを読み込めませんでした');
    expect(alert.textContent).toContain('このチャンネルに参加していません');
  });
});

describe('チャンネルへの投稿', () => {
  it('投稿すると本文を送り、応答のメッセージを一覧の最後に足して、入力欄を空にする（一覧は読み直さない）', async () => {
    const mine = message(2, { author: USER, body: 'こんにちは' });
    const { calls, count } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(1)]),
        [`POST ${MESSAGES}`]: () => json(201, mine),
      }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByText('メッセージ 1');

    type('こんにちは');
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));

    // 入力欄の textarea も本文の文字を持つため、文字で探さず、最後の行に出るまで待つ
    await waitFor(() => expect(articles().at(-1)!.textContent).toContain('こんにちは'));
    const post = calls.find((c) => c.key === `POST ${MESSAGES}`)!;
    expect(JSON.parse(String(post.init.body))).toEqual({ body: 'こんにちは' });
    expect(headerOf(post.init, 'Authorization')).toBe('Bearer t1');
    expect(headerOf(post.init, 'Content-Type')).toBe('application/json');
    await waitFor(() =>
      expect((screen.getByLabelText('メッセージ') as HTMLTextAreaElement).value).toBe(''),
    );
    expect(count(`GET ${MESSAGES}`)).toBe(1);
  });

  it('投稿に失敗したら理由を出し、入力を残す', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([]),
        [`POST ${MESSAGES}`]: () => error(409, 'channel_archived'),
      }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByText('まだメッセージはありません。');

    type('こんにちは');
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'アーカイブ済みのチャンネルです',
    );
    expect((screen.getByLabelText('メッセージ') as HTMLTextAreaElement).value).toBe('こんにちは');
  });

  it('空・空白だけの本文では送信のボタンを押せない', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([]) }));
    renderApp(CHANNEL_PATH);
    await screen.findByText('まだメッセージはありません。');

    const send = screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type(' \n ');
    expect(send.disabled).toBe(true);
    type('a');
    expect(send.disabled).toBe(false);
  });
});
