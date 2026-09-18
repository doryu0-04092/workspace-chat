import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, USER } from '../testing/fake-api';
import {
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  SENT_AT,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

function articles(): HTMLElement[] {
  return screen.getAllByRole('article');
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 画面の更新（react-virtuoso の位置の計算を含む）を数フレーム進める。 */
async function pauseFrames() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('チャンネルのメッセージの表示', () => {
  it('メッセージをトークンを付けて読み、上が新しく下が古い順に並べる（#608）', async () => {
    const { calls } = fakeFetch(
      routes({ [`GET ${MESSAGES}`]: () => page([message(3), message(2), message(1)]) }),
    );
    renderApp(CHANNEL_PATH);

    await screen.findByText('メッセージ 3');
    expect(articles().map((a) => within(a).getByText(/^メッセージ \d$/).textContent)).toEqual([
      'メッセージ 3',
      'メッセージ 2',
      'メッセージ 1',
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

  it('投稿者のアバターを表示名の横に出し、無ければ画像を出さない（F-04。機能一覧 1.3）', async () => {
    const avatarUrl = '/avatars/01920000-0000-7000-8000-000000000002/u/b.png';
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([
            message(2, { author: { ...message(2).author!, avatarUrl } }),
            message(1, { author: { ...message(1).author!, avatarUrl: null } }),
          ]),
      }),
    );
    renderApp(CHANNEL_PATH);

    const withAvatar = (await screen.findByText('メッセージ 2')).closest('article')!;
    expect(withAvatar.querySelector('img')?.getAttribute('src')).toBe(avatarUrl);
    const without = screen.getByText('メッセージ 1').closest('article')!;
    expect(without.querySelector('img')).toBeNull();
  });

  it('退会した投稿者（author が null）は「削除済みの利用者」と出す', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1, { author: null })]) }));
    renderApp(CHANNEL_PATH);

    const article = (await screen.findByText('メッセージ 1')).closest('article')!;
    expect(within(article).getByText('削除済みの利用者')).toBeDefined();
  });

  it('本文のメンションは、応答の mentions の対象を「@表示名」で出す（F-20）', async () => {
    const carol = {
      id: '01920000-0000-7000-8000-000000000003',
      userId: 'carol',
      displayName: 'キャロル',
    };
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([
            message(1, { body: '@Carol に聞く', mentions: [{ userId: 'carol', user: carol }] }),
          ]),
      }),
    );
    renderApp(CHANNEL_PATH);

    expect(await screen.findByText('@キャロル')).toBeDefined();
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

  it('続きがあれば、古いメッセージを before を付けて読み、下に足す。既に出ていたメッセージの位置は動かさない', async () => {
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(4), message(3)], message(3).id),
        [`GET ${MESSAGES}?before=${message(3).id}`]: () => page([message(2), message(1)]),
      }),
    );
    renderApp(CHANNEL_PATH);

    // data-item-index は行の番号。古いものは下に足すため、既に出ていた行の番号は変わらない
    const indexOf = (text: string) =>
      screen.getByText(text).closest('[data-item-index]')!.getAttribute('data-item-index');
    await screen.findByText('メッセージ 4');
    const before = { three: indexOf('メッセージ 3'), four: indexOf('メッセージ 4') };

    fireEvent.click(screen.getByRole('button', { name: '古いメッセージを読み込む' }));

    await screen.findByText('メッセージ 1');
    expect(articles().map((a) => within(a).getByText(/^メッセージ \d$/).textContent)).toEqual([
      'メッセージ 4',
      'メッセージ 3',
      'メッセージ 2',
      'メッセージ 1',
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

  it('一覧のスクロールの枠は、高さをインラインの style で持つ（クラスの高さは react-virtuoso のインラインの height: 100% に負けて 0 になる。#606）', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1)]) }));
    renderApp(CHANNEL_PATH);

    await screen.findByText('メッセージ 1');
    const scroller = screen.getByTestId('virtuoso-scroller');
    expect(scroller.style.height).toBe('60vh');
  });

  it('入力欄は一覧の上に置く（最新を見るにも入力するにも下までスクロールしない。#608）', async () => {
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1)]) }));
    renderApp(CHANNEL_PATH);

    await screen.findByText('メッセージ 1');
    const input = screen.getByLabelText('メッセージ');
    const list = screen.getByRole('region', { name: 'メッセージの一覧' });
    expect(input.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  it('投稿すると本文を送り、応答のメッセージを一覧の先頭に足して、入力欄を空にする（一覧は読み直さない）', async () => {
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

    // 入力欄の textarea も本文の文字を持つため、文字で探さず、先頭の行に出るまで待つ
    await waitFor(() => expect(articles()[0]!.textContent).toContain('こんにちは'));
    const post = calls.find((c) => c.key === `POST ${MESSAGES}`)!;
    expect(JSON.parse(String(post.init.body))).toEqual({ body: 'こんにちは' });
    expect(headerOf(post.init, 'Authorization')).toBe('Bearer t1');
    expect(headerOf(post.init, 'Content-Type')).toBe('application/json');
    await waitFor(() =>
      expect((screen.getByLabelText('メッセージ') as HTMLTextAreaElement).value).toBe(''),
    );
    expect(count(`GET ${MESSAGES}`)).toBe(1);
  });

  it('自分の投稿が先頭に加わったら一覧をいちばん上（最新）へ戻し、他人の新しいメッセージでは戻さない（#663）', async () => {
    const mine = message(3, { author: USER, body: '自分の投稿' });
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(1)]),
        [`POST ${MESSAGES}`]: () => json(201, mine),
      }),
    );
    const view = renderApp(CHANNEL_PATH);
    await screen.findByText('メッセージ 1');
    const socket = view.sockets.at(-1)!;
    // 読み進めて下へスクロールしている（先頭の新しい投稿は枠の外）
    const scroller = screen.getByTestId('virtuoso-scroller');
    scroller.scrollTop = 400;
    fireEvent.scroll(scroller);
    await pauseFrames();

    act(() => socket.deliver('message:new', { message: message(2), sentAt: SENT_AT }));
    await pauseFrames();
    expect(scroller.scrollTop).toBe(400);

    type('自分の投稿');
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    // 一覧の先頭に足すことは「投稿すると本文を送り…」が確かめる。ここでは先頭へ戻すことだけを見る
    await waitFor(() => expect(scroller.scrollTop).toBe(0));
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

  // `MessageForm` の「Enter では送信しない」（投稿 F-11・返信 F-17・編集 F-13 が共有する。#537 の追記）。
  // **jsdom は Enter による暗黙の送信（1行の input）を再現しない**ため、入力欄が textarea であることは形で確かめる
  it('Enter では送信しない（補完の一覧が無いとき）', async () => {
    const { count } = fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([]) }));
    renderApp(CHANNEL_PATH);
    await screen.findByText('まだメッセージはありません。');
    const input = screen.getByLabelText('メッセージ');
    expect(input.tagName).toBe('TEXTAREA');

    type('こんにちは');
    fireEvent.keyDown(input, { key: 'Enter' });
    // **要求は非同期で出る**ので、送ってしまう実装でもキーの直後はまだ 0 である。出る分だけ待ってから数える
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(count(`POST ${MESSAGES}`)).toBe(0);
    expect((input as HTMLTextAreaElement).value).toBe('こんにちは');
  });
});
