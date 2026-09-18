import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { RealtimeEventName } from '@workspace-chat/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, USER } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  SENT_AT,
} from '../testing/fake-messages';
import type { FakeSocket } from '../testing/fake-socket';
import { renderApp } from '../testing/render-app';
import { TYPING_DISPLAY_MS, TYPING_IDLE_MS, TYPING_SEND_INTERVAL_MS } from '../realtime/use-typing';

const TYPING_START = 'typing:start' satisfies RealtimeEventName;
const TYPING_STOP = 'typing:stop' satisfies RealtimeEventName;
const CAROL = {
  id: '01920000-0000-7000-8000-000000000003',
  userId: 'carol',
  displayName: 'キャロル',
  avatarUrl: null,
};

async function openChannel(extra: Parameters<typeof fakeFetch>[0] = {}) {
  const fetch = fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1)]), ...extra }));
  const view = renderApp(CHANNEL_PATH);
  await screen.findByText('メッセージ 1');
  const socket = view.sockets.at(-1)!;
  act(() => socket.open());
  return { ...fetch, ...view, socket };
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value } });
}

function typingSent(socket: FakeSocket) {
  return socket.sent.filter(({ event }) => event === TYPING_START || event === TYPING_STOP);
}

function indicator(): string {
  return screen.getByRole('status', { name: '入力中の利用者' }).textContent ?? '';
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 機能一覧 13.3（F-34）: 入力欄の上に「○○さんが入力中…」を出す。一定時間入力が止まったら消える。
// `typing` イベントが過剰に送信されない（キー入力ごとに送らない）。自分の入力中インジケータは自分には表示されない。
describe('入力中の知らせを送る（F-34）', () => {
  it('打ち始めに typing:start を1回送り、打ち続けても間隔の間は送らず、間隔を過ぎて打てばもう1回送る', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { socket } = await openChannel();

    type('こ');
    type('こん');
    act(() => vi.advanceTimersByTime(TYPING_SEND_INTERVAL_MS - 1_000));
    type('こんに');

    expect(typingSent(socket)).toEqual([{ event: TYPING_START, body: { channelId: GENERAL.id } }]);

    act(() => vi.advanceTimersByTime(1_000));
    type('こんにち');

    expect(typingSent(socket).map(({ event }) => event)).toEqual([TYPING_START, TYPING_START]);
  });

  it('入力が止まって一定時間たったら typing:stop を送る。止まる前に打てば送らない', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { socket } = await openChannel();

    type('こ');
    act(() => vi.advanceTimersByTime(TYPING_IDLE_MS - 200));
    type('こん');
    act(() => vi.advanceTimersByTime(TYPING_IDLE_MS - 200));
    expect(typingSent(socket).map(({ event }) => event)).toEqual([TYPING_START]);

    act(() => vi.advanceTimersByTime(200));
    expect(typingSent(socket)).toEqual([
      { event: TYPING_START, body: { channelId: GENERAL.id } },
      { event: TYPING_STOP, body: { channelId: GENERAL.id } },
    ]);

    type('こんに');
    expect(typingSent(socket).map(({ event }) => event)).toEqual([
      TYPING_START,
      TYPING_STOP,
      TYPING_START,
    ]);
  });

  it('入力を消したら、送信して欄が空になったら、すぐに typing:stop を送る', async () => {
    const { socket } = await openChannel({
      [`POST ${MESSAGES}`]: () => json(201, message(2, { author: USER, body: 'やあ' })),
    });

    type('やあ');
    type('');
    expect(typingSent(socket).map(({ event }) => event)).toEqual([TYPING_START, TYPING_STOP]);

    type('やあ');
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await waitFor(() =>
      expect(typingSent(socket).map(({ event }) => event)).toEqual([
        TYPING_START,
        TYPING_STOP,
        TYPING_START,
        TYPING_STOP,
      ]),
    );
  });

  it('入力中のままチャンネルを離れたら typing:stop を送る', async () => {
    const { socket } = await openChannel();

    type('やあ');
    fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));

    await waitFor(() =>
      expect(typingSent(socket).map(({ event }) => event)).toEqual([TYPING_START, TYPING_STOP]),
    );
  });

  it('繋がっていなければ送らず、繋がり直した後に打てば typing:start を送る', async () => {
    const { socket } = await openChannel();
    act(() => socket.drop());

    type('やあ');
    expect(typingSent(socket)).toEqual([]);

    act(() => socket.open());
    type('やあ！');
    expect(typingSent(socket).map(({ event }) => event)).toEqual([TYPING_START]);
  });
});

describe('入力中の表示（F-34）', () => {
  function deliver(socket: FakeSocket, event: string, user = BOB, channelId = GENERAL.id) {
    act(() => socket.deliver(event, { channelId, user, sentAt: SENT_AT }));
  }

  it('typing:start が届いたら「○○さんが入力中…」を出し、typing:stop で消す。複数人なら並べる', async () => {
    const { socket } = await openChannel();

    deliver(socket, TYPING_START);
    expect(indicator()).toBe('ボブさんが入力中…');
    deliver(socket, TYPING_START, CAROL);
    expect(indicator()).toBe('ボブさん、キャロルさんが入力中…');

    deliver(socket, TYPING_STOP);
    expect(indicator()).toBe('キャロルさんが入力中…');
    deliver(socket, TYPING_STOP, CAROL);
    expect(indicator()).toBe('');
  });

  it('typing:stop が届かなくても、最後の typing:start から一定時間たったら消す。その前に届き直せば残す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { socket } = await openChannel();

    deliver(socket, TYPING_START);
    act(() => vi.advanceTimersByTime(TYPING_DISPLAY_MS - 1_000));
    deliver(socket, TYPING_START);
    act(() => vi.advanceTimersByTime(TYPING_DISPLAY_MS - 200));
    expect(indicator()).toBe('ボブさんが入力中…');

    act(() => vi.advanceTimersByTime(200));
    expect(indicator()).toBe('');
  });

  it('自分（別のタブを含む）の typing:start と、開いていないチャンネルの typing:start は出さない', async () => {
    const { socket } = await openChannel();

    deliver(socket, TYPING_START, USER);
    deliver(socket, TYPING_START, BOB, '01920000-0000-7000-8000-0000000000c9');

    expect(indicator()).toBe('');
  });
});
