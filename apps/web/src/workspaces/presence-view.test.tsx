import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { REALTIME_REQUESTS, type RealtimeEventName } from '@workspace-chat/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_REFRESH_MS } from '../realtime/use-channel-realtime';
import { fakeFetch, json, USER } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  page,
  routes,
  SENT_AT,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import type { FakeSocket } from '../testing/fake-socket';
import { renderApp } from '../testing/render-app';

const PRESENCE_CHANGED = 'presence:changed' satisfies RealtimeEventName;
const CHANNEL_MEMBERS = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/members`;
/** テストで使う3人目の参加者（実在の人物ではない）。 */
const CAROL = {
  id: '01920000-0000-7000-8000-000000000003',
  userId: 'carol',
  displayName: 'キャロル',
};
const OTHER_CHANNEL_ID = '01920000-0000-7000-8000-0000000000c9';

/** チャンネルを開き、参加者の一覧（アリス・ボブ・キャロル）を開く。入室の acknowledgement の在席は `present`。 */
async function openMembers(present: string[], extra: Parameters<typeof routes>[0] = {}) {
  const fetch = fakeFetch(
    routes({
      [`GET ${MESSAGES}`]: () => page([]),
      [`GET ${CHANNEL_MEMBERS}`]: () => json(200, [USER, BOB, CAROL]),
      ...extra,
    }),
  );
  const view = renderApp(CHANNEL_PATH);
  fireEvent.click(await screen.findByRole('button', { name: '参加者を見る' }));
  await screen.findByRole('list', { name: '参加者' });
  const socket = view.sockets.at(-1)!;
  socket.acknowledge = () => ({ ok: true, present });
  act(() => socket.open());
  await waitFor(() => expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1));
  await pause();
  return { ...fetch, ...view, socket };
}

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** 参加者の一覧で、在席と示されている人の表示名。 */
function presentNames(): string[] {
  const list = within(screen.getByRole('list', { name: '参加者' }));
  return list
    .getAllByRole('listitem')
    .filter((item) => within(item).queryByText('在席中') !== null)
    .map((item) => [USER, BOB, CAROL].find((u) => item.textContent?.includes(u.displayName))!)
    .map((user) => user.displayName);
}

function changed(socket: FakeSocket, userId: string, present: boolean, channelId = GENERAL.id) {
  act(() => socket.deliver(PRESENCE_CHANGED, { channelId, userId, present, sentAt: SENT_AT }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 機能一覧 9.2（F-22）: メンバー一覧に在席を表示する。在席を画面へ渡す経路は部屋の側だけ——入室の acknowledgement で置き換え、
// 以後の変化は presence:changed、5分ごとに取り直して置き換える。在席状態を色や記号だけで伝えない。
describe('参加者の在席の表示（F-22）', () => {
  it('入室の acknowledgement で返った参加者に「在席中」を文字で出す', async () => {
    await openMembers([USER.id, BOB.id]);

    await waitFor(() => expect(presentNames()).toEqual(['アリス', 'ボブ']));
  });

  it('presence:changed で在席を足し・外す。開いていないチャンネルの変化は当てない', async () => {
    const { socket } = await openMembers([USER.id, BOB.id]);

    changed(socket, BOB.id, false);
    changed(socket, CAROL.id, true);
    changed(socket, USER.id, false, OTHER_CHANNEL_ID);

    await waitFor(() => expect(presentNames()).toEqual(['アリス', 'キャロル']));
  });

  it('5分ごとに入室要求を送り直し、acknowledgement の在席で置き換える。メッセージの一覧は読み直さない', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { socket, count } = await openMembers([USER.id, BOB.id]);
    const reads = count(`GET ${MESSAGES}`);
    changed(socket, CAROL.id, true);
    socket.acknowledge = () => ({ ok: true, present: [USER.id, CAROL.id] });

    act(() => vi.advanceTimersByTime(PRESENCE_REFRESH_MS - 1_000));
    expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1);
    act(() => vi.advanceTimersByTime(1_000));

    await waitFor(() => expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(2));
    await waitFor(() => expect(presentNames()).toEqual(['アリス', 'キャロル']));
    expect(count(`GET ${MESSAGES}`)).toBe(reads);
  });

  it('取り直しの時点で繋がっていなければ送らず、繋がり直した後は続けて取り直す。離れたら送らない', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { socket } = await openMembers([USER.id]);

    act(() => socket.drop());
    act(() => vi.advanceTimersByTime(PRESENCE_REFRESH_MS));
    await pause();
    expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(1);

    act(() => socket.open());
    await waitFor(() => expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(2));
    act(() => vi.advanceTimersByTime(PRESENCE_REFRESH_MS));
    await waitFor(() => expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(3));

    fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));
    await screen.findByRole('heading', { name: '開発チーム' });
    act(() => vi.advanceTimersByTime(PRESENCE_REFRESH_MS));
    await pause();
    expect(socket.sentCount(REALTIME_REQUESTS.channelEnter)).toBe(3);
  });

  // 機能一覧 9.2「在席を受け取れるのは、そのチャンネルの部屋に入っている参加者だけである」。断られた接続は部屋に入っていない。
  it('取り直しの入室を断られたら、在席を出さない', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { socket } = await openMembers([USER.id, BOB.id]);
    await waitFor(() => expect(presentNames()).toEqual(['アリス', 'ボブ']));
    socket.acknowledge = () => ({
      ok: false,
      status: 404,
      error: { code: 'not_found', message: 'x' },
    });

    act(() => vi.advanceTimersByTime(PRESENCE_REFRESH_MS));

    await waitFor(() => expect(presentNames()).toEqual([]));
  });

  it('切れて繋ぎ直したら、繋ぎ直しの入室の acknowledgement で置き換える', async () => {
    const { socket } = await openMembers([USER.id, BOB.id]);
    socket.acknowledge = () => ({ ok: true, present: [USER.id, CAROL.id] });

    act(() => {
      socket.drop();
      socket.open();
    });

    await waitFor(() => expect(presentNames()).toEqual(['アリス', 'キャロル']));
  });
});
