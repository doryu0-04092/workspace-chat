import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { REALTIME_REQUESTS } from '@workspace-chat/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, PROFILE, token, USER } from '../testing/fake-api';
import type { FakeSocket } from '../testing/fake-socket';
import { renderApp } from '../testing/render-app';

const WORKSPACE = {
  id: '01920000-0000-7000-8000-0000000000a1',
  name: '開発チーム',
  createdAt: '2026-09-13T00:00:00.000Z',
  role: 'MEMBER',
};
const GENERAL = {
  id: '01920000-0000-7000-8000-0000000000c1',
  name: 'general',
  visibility: 'PUBLIC',
  joined: true,
};
const OTHER_CHANNEL_ID = '01920000-0000-7000-8000-0000000000c9';
/** テストで使うもう1人の利用者（実在の人物ではない）。 */
const BOB = { id: '01920000-0000-7000-8000-000000000002', userId: 'bob', displayName: 'ボブ' };
const SENT_AT = '2026-09-14T00:00:00.000Z';

const CHANNEL_PATH = `/workspaces/${WORKSPACE.id}/channels/${GENERAL.id}`;
const MESSAGES = `/api/workspaces/${WORKSPACE.id}/channels/${GENERAL.id}/messages`;

function message(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    channelId: GENERAL.id,
    author: BOB,
    body: `メッセージ ${n}`,
    createdAt: SENT_AT,
    editedAt: null,
    deleted: false,
    parentId: null,
    replyCount: 0,
    replyParticipants: [],
    mentions: [],
    ...overrides,
  };
}

function page(messages: ReturnType<typeof message>[]) {
  return json(200, { messages, nextBefore: null });
}

function routes(extra: Parameters<typeof fakeFetch>[0] = {}) {
  return {
    'POST /api/auth/refresh': () => token('t1'),
    'GET /api/users/me': () => json(200, PROFILE),
    [`GET /api/workspaces/${WORKSPACE.id}`]: () => json(200, WORKSPACE),
    [`GET /api/workspaces/${WORKSPACE.id}/channels`]: () => json(200, [GENERAL]),
    [`GET ${MESSAGES}`]: () => page([message(1)]),
    ...extra,
  };
}

async function openChannel(extra: Parameters<typeof fakeFetch>[0] = {}) {
  const fetch = fakeFetch(routes(extra));
  const view = renderApp(CHANNEL_PATH);
  await screen.findByText('メッセージ 1');
  return { ...fetch, ...view, socket: view.sockets.at(-1)! };
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** 接続を受け入れ、入室の acknowledgement に続く一覧の読み直しが終わるまで待つ。 */
async function accept(socket: FakeSocket, count: (key: string) => number, gets: number) {
  act(() => socket.open());
  await waitFor(() => expect(count(`GET ${MESSAGES}`)).toBe(gets));
  await pause();
}

function rows(): string[] {
  return screen.getAllByRole('article').map((article) => article.textContent ?? '');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('リアルタイムの接続（F-16。機能一覧 5.2）', () => {
  it('ログインした画面を開くと接続を始め、auth にはいまのアクセストークンを載せる', async () => {
    const { sockets } = await openChannel();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.connects).toBe(1);
    expect(sockets[0]!.token()).toBe('t1');
  });

  it('ハンドシェイクが invalid_token で断られたら、リフレッシュでアクセストークンを取り直してから接続し直す', async () => {
    const { socket, count } = await openChannel({
      'POST /api/auth/refresh': [() => token('t1'), () => token('t2')],
    });

    act(() => socket.refuse('invalid_token'));

    await waitFor(() => expect(socket.connects).toBe(2));
    expect(count('POST /api/auth/refresh')).toBe(2);
    expect(socket.token()).toBe('t2');
  });

  it('取り直して接続できた後に、もう一度 invalid_token で断られたら、また取り直して接続し直す', async () => {
    const { socket, count } = await openChannel({
      'POST /api/auth/refresh': [() => token('t1'), () => token('t2'), () => token('t3')],
    });

    act(() => socket.refuse('invalid_token'));
    await waitFor(() => expect(socket.connects).toBe(2));
    await accept(socket, count, 2);
    act(() => socket.refuse('invalid_token'));

    await waitFor(() => expect(socket.connects).toBe(3));
    expect(count('POST /api/auth/refresh')).toBe(3);
    expect(socket.token()).toBe('t3');
  });

  it('取り直した後も続けて断られたら、それ以上は繋ぎ直さず、理由を出す', async () => {
    const { socket, count } = await openChannel({
      'POST /api/auth/refresh': [() => token('t1'), () => token('t2'), () => token('t3')],
    });

    act(() => socket.refuse('invalid_token'));
    await waitFor(() => expect(socket.connects).toBe(2));
    act(() => socket.refuse('invalid_token'));
    await pause();

    expect(socket.connects).toBe(2);
    expect(count('POST /api/auth/refresh')).toBe(2);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'リアルタイムの反映に接続できませんでした',
    );
  });

  it('リフレッシュも通らなければ、ログインしていない状態になり、接続を切る', async () => {
    const { socket, store } = await openChannel({
      'POST /api/auth/refresh': [
        () => token('t1'),
        () => json(401, { code: 'invalid_token', message: 'x' }),
      ],
    });

    act(() => socket.refuse('invalid_token'));

    await waitFor(() => expect(store.getState().status).toBe('signedOut'));
    await waitFor(() => expect(socket.disconnects).toBe(1));
    expect(socket.connects).toBe(1);
  });

  it('invalid_token 以外で断られたら、繋ぎ直さず理由を出す', async () => {
    const { socket } = await openChannel();

    act(() => socket.refuse('internal_error'));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'リアルタイムの反映に接続できませんでした',
    );
    expect(socket.connects).toBe(1);
  });

  it('ログアウトすると接続を切る', async () => {
    const { socket } = await openChannel({
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));

    await waitFor(() => expect(socket.disconnects).toBe(1));
  });

  it('リフレッシュを待つ間にログアウトして枠が外れたら、リフレッシュが後から通っても繋ぎ直さない', async () => {
    let finishRefresh: ((response: Response) => void) | undefined;
    const { socket } = await openChannel({
      'POST /api/auth/refresh': [
        () => token('t1'),
        () =>
          new Promise<Response>((resolve) => {
            finishRefresh = resolve;
          }),
      ],
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });

    act(() => socket.refuse('invalid_token'));
    await waitFor(() => expect(finishRefresh).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    await waitFor(() => expect(socket.disconnects).toBe(1));

    await act(async () => {
      finishRefresh!(token('t2'));
    });
    await pause();

    expect(socket.connects).toBe(1);
  });
});

describe('チャンネルの部屋（機能一覧 9.2）', () => {
  it('接続したら、開いているチャンネルの入室要求を送り、チャンネルを離れたら退室要求を送る', async () => {
    const { socket, count } = await openChannel();

    await accept(socket, count, 2);
    expect(socket.sent).toContainEqual({
      event: REALTIME_REQUESTS.channelEnter,
      body: { channelId: GENERAL.id },
    });

    fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));

    await waitFor(() =>
      expect(socket.sent).toContainEqual({
        event: REALTIME_REQUESTS.channelExit,
        body: { channelId: GENERAL.id },
      }),
    );
  });

  it('接続したままチャンネルを開き直したら、入室要求を送る', async () => {
    const { socket, count } = await openChannel();
    await accept(socket, count, 2);

    fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));
    fireEvent.click(await screen.findByRole('link', { name: '# general' }));

    await waitFor(() => expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(2));
  });

  it('入室できたら一覧を読み直す。切れて繋ぎ直したら入室し直して読み直し、切断中のメッセージを補完する', async () => {
    const { socket, count } = await openChannel({
      [`GET ${MESSAGES}`]: [
        () => page([message(1)]),
        () => page([message(1)]),
        () => page([message(2), message(1)]),
      ],
    });
    await accept(socket, count, 2);

    act(() => {
      socket.drop();
      socket.open();
    });

    expect(await screen.findByText('メッセージ 2')).toBeDefined();
    expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(2);
    expect(count(`GET ${MESSAGES}`)).toBe(3);
  });

  it('入室要求が断られたら、理由を出す', async () => {
    const { socket } = await openChannel();
    socket.acknowledge = () => ({
      ok: false,
      status: 404,
      error: { code: 'not_found', message: 'x' },
    });

    act(() => socket.open());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('リアルタイムの反映を始められませんでした');
    expect(alert.textContent).toContain('見つかりません');
  });

  describe('入室要求が上限（429）で断られたとき（機能一覧 9.2「画面は時間をおいてやり直す」）', () => {
    const TOO_MANY = { ok: false, status: 429, error: { code: 'too_many_requests', message: 'x' } };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('理由を出し、1分おいて入室要求を送り直す。入れたら一覧を読み直し、理由を消す', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { socket, count } = await openChannel();
      let enters = 0;
      socket.acknowledge = () => (++enters === 1 ? TOO_MANY : { ok: true, present: [] });

      act(() => socket.open());
      expect((await screen.findByRole('alert')).textContent).toContain('試行が多すぎます');

      act(() => vi.advanceTimersByTime(59_000));
      expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1);

      act(() => vi.advanceTimersByTime(1_000));
      await waitFor(() => expect(count(`GET ${MESSAGES}`)).toBe(2));
      expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(2);
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('送り直す前にチャンネルを離れたら、送り直さない', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { socket } = await openChannel();
      socket.acknowledge = () => TOO_MANY;
      act(() => socket.open());
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));
      await screen.findByRole('heading', { name: '開発チーム' });
      act(() => vi.advanceTimersByTime(60_000));
      await pause();

      expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1);
    });

    it('チャンネルを離れた後に 429 の acknowledgement が届いても、送り直さない', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { socket } = await openChannel();
      const pending: ((response: unknown) => void)[] = [];
      socket.emit = (event: string, body: unknown, ack?: (response: unknown) => void) => {
        socket.sent.push({ event, body });
        if (ack) pending.push(ack);
        return socket;
      };
      act(() => socket.open());
      expect(pending).toHaveLength(1);

      fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));
      await screen.findByRole('heading', { name: '開発チーム' });
      act(() => pending[0]!(TOO_MANY));
      act(() => vi.advanceTimersByTime(60_000));
      await pause();

      expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1);
    });

    it('送り直す時点で繋がっていなければ送らず、繋がり直したときに入室要求を送る', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { socket } = await openChannel();
      let enters = 0;
      socket.acknowledge = () => (++enters === 1 ? TOO_MANY : { ok: true, present: [] });
      act(() => socket.open());
      await screen.findByRole('alert');

      act(() => socket.drop());
      act(() => vi.advanceTimersByTime(60_000));
      await pause();
      expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1);

      act(() => socket.open());
      await pause();
      expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(2);
    });

    it('上限でない断り（404 など）は、時間をおいても送り直さない', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { socket } = await openChannel();
      socket.acknowledge = () => ({
        ok: false,
        status: 404,
        error: { code: 'not_found', message: 'x' },
      });
      act(() => socket.open());
      await screen.findByRole('alert');

      act(() => vi.advanceTimersByTime(60_000));
      await pause();

      expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1);
    });
  });
});

describe('配信の反映（機能一覧 5.2）', () => {
  it('message:new を、開いているチャンネルの一覧の最後に足す。同じ id がもう一度届いても1行だけにする', async () => {
    const { socket, count } = await openChannel();
    await accept(socket, count, 2);

    act(() => socket.deliver('message:new', { message: message(2), sentAt: SENT_AT }));
    await waitFor(() => expect(rows().at(-1)).toContain('メッセージ 2'));
    act(() => socket.deliver('message:new', { message: message(2), sentAt: SENT_AT }));
    await pause();

    expect(screen.getAllByText('メッセージ 2')).toHaveLength(1);
  });

  it('ほかのチャンネルの message:new は足さない', async () => {
    const { socket, count } = await openChannel();
    await accept(socket, count, 2);

    act(() =>
      socket.deliver('message:new', {
        message: message(3, { channelId: OTHER_CHANNEL_ID }),
        sentAt: SENT_AT,
      }),
    );
    await pause();

    expect(screen.queryByText('メッセージ 3')).toBeNull();
  });

  // 機能一覧 6「スレッドの返信は、チャンネル本体の一覧に混ざって表示されない」。返信もチャンネルの部屋へ message:new で届く。
  it('スレッドの返信（parentId を持つ）の message:new は、開いているチャンネルの一覧に足さない', async () => {
    const { socket, count } = await openChannel();
    await accept(socket, count, 2);

    act(() =>
      socket.deliver('message:new', {
        message: message(3, { parentId: message(1).id }),
        sentAt: SENT_AT,
      }),
    );
    await pause();

    expect(screen.queryByText('メッセージ 3')).toBeNull();
  });

  it('message:updated で本文を置き換え、「（編集済み）」を出す', async () => {
    const { socket, count } = await openChannel();
    await accept(socket, count, 2);

    act(() =>
      socket.deliver('message:updated', {
        message: message(1, { body: '直した本文', editedAt: SENT_AT }),
        sentAt: SENT_AT,
      }),
    );

    const article = (await screen.findByText('直した本文')).closest('article')!;
    expect(within(article).getByText('（編集済み）')).toBeDefined();
    expect(screen.queryByText('メッセージ 1')).toBeNull();
  });

  it('message:deleted で本文を「このメッセージは削除されました」に置き換える', async () => {
    const { socket, count } = await openChannel();
    await accept(socket, count, 2);

    act(() =>
      socket.deliver('message:deleted', {
        channelId: GENERAL.id,
        messageId: message(1).id,
        sentAt: SENT_AT,
      }),
    );

    expect(await screen.findByText('このメッセージは削除されました')).toBeDefined();
    expect(screen.queryByText('メッセージ 1')).toBeNull();
  });

  it('自分の投稿は、配信が先に届いても、投稿の応答と合わせて1行だけにする', async () => {
    const mine = message(2, { author: USER, body: 'こんにちは' });
    const { socket, count } = await openChannel({ [`POST ${MESSAGES}`]: () => json(201, mine) });
    await accept(socket, count, 2);

    act(() => socket.deliver('message:new', { message: mine, sentAt: SENT_AT }));
    await waitFor(() => expect(rows().at(-1)).toContain('こんにちは'));
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await waitFor(() =>
      expect((screen.getByLabelText('メッセージ') as HTMLTextAreaElement).value).toBe(''),
    );
    await pause();

    expect(rows().filter((row) => row.includes('こんにちは'))).toHaveLength(1);
  });
});
