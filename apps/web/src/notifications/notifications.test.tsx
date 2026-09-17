import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, USER } from '../testing/fake-api';
import {
  BOB,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  SENT_AT,
  WORKSPACE,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

const NOTIFICATIONS = '/api/users/me/notifications';
const WORKSPACE_PATH = `/workspaces/${WORKSPACE_ID}`;
const CHANNEL_PATH = `${WORKSPACE_PATH}/channels/${GENERAL.id}`;

/** 偽の fetch の応答（`fakeFetch` の Handler と同じ形）。 */
type Handler = (init: RequestInit) => Response;

/** 自分（`USER`）へのメンションを含む `n` 番目のメッセージ。 */
function mentionMessage(n: number, overrides: Record<string, unknown> = {}) {
  return message(n, {
    body: `@${USER.userId} 見てください ${n}`,
    mentions: [{ userId: USER.userId, user: USER }],
    ...overrides,
  });
}

/** `n` 番目の通知（REST の Notification と同じ形）。 */
function notification(n: number, overrides: Record<string, unknown> = {}) {
  const mentioned = mentionMessage(n);
  return {
    id: `01920000-0000-7000-8000-${String(n).padStart(11, '0')}e`,
    kind: 'MENTION',
    createdAt: mentioned.createdAt,
    readAt: null as string | null,
    workspace: { id: WORKSPACE_ID, name: WORKSPACE.name },
    channel: { id: GENERAL.id, name: GENERAL.name },
    message: mentioned,
    ...overrides,
  };
}

function notificationPage(
  notifications: ReturnType<typeof notification>[],
  nextBefore: string | null = null,
) {
  return json(200, { notifications, nextBefore });
}

/**
 * ブラウザの Notification API の偽物（jsdom は持たない）。許可の状態と、許可を求めた回数と、出した通知を記録する。
 * `answer` は、許可を求められたときに利用者が選ぶ答え。
 */
function fakeNotificationApi(
  permission: NotificationPermission,
  answer: NotificationPermission = 'granted',
) {
  const shown: { title: string; options?: NotificationOptions; instance: FakeNotification }[] = [];
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = answer;
      return answer;
    });
    onclick: ((event: Event) => void) | null = null;
    close = vi.fn();
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, options, instance: this });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { shown, requestPermission: FakeNotification.requestPermission };
}

/** 設定の画面でブラウザ通知を有効にする（許可を求める操作は利用者の明示の操作だけ）。 */
async function enableBrowserNotifications() {
  const toggle = await screen.findByRole('checkbox', { name: 'メンションをブラウザで通知する' });
  fireEvent.click(toggle);
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
}

function deliverNew(sockets: { deliver(event: string, payload: unknown): void }[], body: unknown) {
  act(() => {
    sockets[0]?.deliver('message:new', { message: body, sentAt: SENT_AT });
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// 機能一覧 10.2（F-25）: メンションを Notification API で通知する。許可を求めるのは利用者が明示的に有効化したときだけ。#580。
describe('ブラウザ通知（F-25）', () => {
  it('ログインした画面や設定の画面を開いただけでは、通知の許可を求めない', async () => {
    const { requestPermission } = fakeNotificationApi('default');
    fakeFetch(routes());

    renderApp('/settings');

    expect(
      await screen.findByRole('checkbox', { name: 'メンションをブラウザで通知する' }),
    ).toBeDefined();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('有効にすると許可を求め、許可されたら、自分へのメンションが届いたときに通知を出す', async () => {
    const { shown, requestPermission } = fakeNotificationApi('default', 'granted');
    fakeFetch(routes());
    const { sockets } = renderApp('/settings');

    await enableBrowserNotifications();
    expect(requestPermission).toHaveBeenCalledTimes(1);

    deliverNew(sockets, mentionMessage(1));

    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('ボブ さんからのメンション');
    expect(shown[0]?.options?.body).toBe(`@${USER.userId} 見てください 1`);
  });

  it('許可が拒否されたら有効にならず、通知は出さず、画面内の件数で分かることを伝える', async () => {
    const { shown } = fakeNotificationApi('default', 'denied');
    fakeFetch(routes());
    const { sockets } = renderApp('/settings');

    const toggle = (await screen.findByRole('checkbox', {
      name: 'メンションをブラウザで通知する',
    })) as HTMLInputElement;
    fireEvent.click(toggle);

    expect((await screen.findByRole('alert')).textContent).toMatch(/画面内/);
    expect(toggle.checked).toBe(false);
    deliverNew(sockets, mentionMessage(1));
    expect(shown).toHaveLength(0);
  });

  it('有効にした設定は残り、開き直しても許可を求め直さずに通知を出す', async () => {
    const { shown, requestPermission } = fakeNotificationApi('default', 'granted');
    fakeFetch(routes());
    const first = renderApp('/settings');
    await enableBrowserNotifications();
    first.unmount();
    requestPermission.mockClear();

    const { sockets } = renderApp(WORKSPACE_PATH);
    await screen.findAllByRole('listitem');
    deliverNew(sockets, mentionMessage(1));

    expect(requestPermission).not.toHaveBeenCalled();
    expect(shown).toHaveLength(1);
  });

  // DM（F-19）の `message:new` は同じイベント名で届き、`mentions` を持たない。チャンネルのメンションとして扱って落ちてはならない。
  it('DM の message:new は、メンションの通知として扱わない（落ちない）', async () => {
    const { shown } = fakeNotificationApi('default', 'granted');
    fakeFetch(routes());
    const { sockets } = renderApp('/settings');
    await enableBrowserNotifications();

    const { channelId: _channelId, mentions: _mentions, ...rest } = mentionMessage(1);
    deliverNew(sockets, { ...rest, dmId: '01920000-0000-7000-8000-0000000000d1' });
    deliverNew(sockets, mentionMessage(2));

    expect(shown).toHaveLength(1);
    expect(shown[0]?.options?.body).toBe(`@${USER.userId} 見てください 2`);
  });

  it('許可されていても、有効にしていなければ通知を出さない', async () => {
    const { shown } = fakeNotificationApi('granted');
    fakeFetch(routes());
    const { sockets } = renderApp(WORKSPACE_PATH);
    await screen.findAllByRole('listitem');

    deliverNew(sockets, mentionMessage(1));

    expect(shown).toHaveLength(0);
  });

  it('無効に戻したら通知を出さない', async () => {
    const { shown } = fakeNotificationApi('default', 'granted');
    fakeFetch(routes());
    const { sockets } = renderApp('/settings');
    await enableBrowserNotifications();

    fireEvent.click(screen.getByRole('checkbox', { name: 'メンションをブラウザで通知する' }));
    deliverNew(sockets, mentionMessage(1));

    expect(shown).toHaveLength(0);
  });

  it.each([
    ['メンションの無い通常のメッセージ', message(1)],
    [
      '他の利用者へのメンション',
      message(1, { body: '@bob へ', mentions: [{ userId: BOB.userId, user: BOB }] }),
    ],
    ['自分が書いた、自分へのメンション', mentionMessage(1, { author: USER })],
  ])('%sでは通知を出さない', async (_name, body) => {
    const { shown } = fakeNotificationApi('default', 'granted');
    fakeFetch(routes());
    const { sockets } = renderApp('/settings');
    await enableBrowserNotifications();

    deliverNew(sockets, body);

    expect(shown).toHaveLength(0);
  });

  it('いま開いて見ているチャンネルのメッセージには通知を出さず、ほかのチャンネルなら出す', async () => {
    const { shown } = fakeNotificationApi('default', 'granted');
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([]) }));
    const first = renderApp('/settings');
    await enableBrowserNotifications();
    first.unmount();

    const { sockets } = renderApp(CHANNEL_PATH);
    await screen.findByRole('heading', { name: `# ${GENERAL.name}` });
    deliverNew(sockets, mentionMessage(1));
    expect(shown).toHaveLength(0);

    deliverNew(sockets, mentionMessage(2, { channelId: '01920000-0000-7000-8000-0000000000c2' }));
    expect(shown).toHaveLength(1);
  });

  it('通知を押すと、通知の一覧へ移る', async () => {
    const { shown } = fakeNotificationApi('default', 'granted');
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    fakeFetch(routes({ [`GET ${NOTIFICATIONS}`]: () => notificationPage([notification(1)]) }));
    const { sockets } = renderApp('/settings');
    await enableBrowserNotifications();
    deliverNew(sockets, mentionMessage(1));

    act(() => {
      shown[0]?.instance.onclick?.(new Event('click'));
    });

    expect(await screen.findByRole('heading', { name: '通知' })).toBeDefined();
    expect(shown[0]?.instance.close).toHaveBeenCalled();
  });

  it('このブラウザが通知に対応していなければ、その旨を出す（切り替えは出さない）', async () => {
    fakeFetch(routes());

    renderApp('/settings');

    expect(await screen.findByText(/このブラウザは通知に対応していません/)).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: 'メンションをブラウザで通知する' })).toBeNull();
  });
});

// 機能一覧 10.3（F-26）: 受け取ったメンション・DM を時系列で一覧表示し、既読化でき、該当メッセージへ移動できる。#580。
describe('通知の一覧（F-26）', () => {
  it('ヘッダーから通知の一覧を開ける', async () => {
    fakeFetch(routes({ [`GET ${NOTIFICATIONS}`]: () => notificationPage([]) }));
    renderApp(WORKSPACE_PATH);

    fireEvent.click(await screen.findByRole('link', { name: '通知' }));

    expect(await screen.findByRole('heading', { name: '通知' })).toBeDefined();
    expect(await screen.findByText('通知はありません。')).toBeDefined();
  });

  it('通知を新しい順に、ワークスペース・チャンネル・書いた人・本文・未読か既読かと一緒に出す', async () => {
    fakeFetch(
      routes({
        [`GET ${NOTIFICATIONS}`]: () =>
          notificationPage([notification(2), notification(1, { readAt: SENT_AT })]),
      }),
    );

    renderApp('/notifications');

    const items = await screen.findAllByRole('article');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText(/未読/)).toBeDefined();
    expect(within(items[0]!).getByText(new RegExp(WORKSPACE.name))).toBeDefined();
    expect(within(items[0]!).getByText(new RegExp(`# ${GENERAL.name}`))).toBeDefined();
    expect(within(items[0]!).getByText(/ボブ さんからのメンション/)).toBeDefined();
    expect(within(items[0]!).getByText('@アリス')).toBeDefined();
    expect(within(items[0]!).getByText(/見てください 2/)).toBeDefined();
    expect(within(items[1]!).getByText(/既読/)).toBeDefined();
    expect(within(items[1]!).queryByRole('button', { name: '既読にする' })).toBeNull();
  });

  // CLAUDE.md「必ずテストを書く箇所」: Markdown が HTML として解釈されないこと（通知の本文も同じ部品で描く）。
  it('通知の本文の HTML は要素にならず、書いた文字のまま出す', async () => {
    const body = '<img src=x onerror="alert(1)">';
    fakeFetch(
      routes({
        [`GET ${NOTIFICATIONS}`]: () =>
          notificationPage([notification(1, { message: mentionMessage(1, { body }) })]),
      }),
    );

    renderApp('/notifications');

    const [item] = await screen.findAllByRole('article');
    expect(item?.querySelector('img')).toBeNull();
    expect(item?.textContent).toContain(body);
  });

  it('「既読にする」で api に送り、一覧を読み直して既読の表示にする', async () => {
    const target = notification(1);
    const list = vi.fn<Handler>(() => notificationPage([target]));
    const read = vi.fn<Handler>(() => {
      list.mockImplementation(() => notificationPage([{ ...target, readAt: SENT_AT }]));
      return new Response(null, { status: 204 });
    });
    fakeFetch(
      routes({
        [`GET ${NOTIFICATIONS}`]: list,
        [`PUT ${NOTIFICATIONS}/${target.id}/read`]: read,
      }),
    );
    renderApp('/notifications');

    fireEvent.click(await screen.findByRole('button', { name: '既読にする' }));

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const [item] = await screen.findAllByRole('article');
    await waitFor(() =>
      expect(within(item!).queryByRole('button', { name: '既読にする' })).toBeNull(),
    );
    expect(within(item!).getByText(/既読/)).toBeDefined();
  });

  it('既読にできなければ理由を出す', async () => {
    const target = notification(1);
    fakeFetch(
      routes({
        [`GET ${NOTIFICATIONS}`]: () => notificationPage([target]),
        [`PUT ${NOTIFICATIONS}/${target.id}/read`]: () => error(404, 'not_found'),
      }),
    );
    renderApp('/notifications');

    fireEvent.click(await screen.findByRole('button', { name: '既読にする' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/既読にできませんでした/);
  });

  it('「メッセージへ移動」で未読の通知を既読にし、そのチャンネルへ移る', async () => {
    const target = notification(1);
    const read = vi.fn<Handler>(() => new Response(null, { status: 204 }));
    fakeFetch(
      routes({
        [`GET ${NOTIFICATIONS}`]: () => notificationPage([target]),
        [`PUT ${NOTIFICATIONS}/${target.id}/read`]: read,
        [`GET ${MESSAGES}`]: () => page([target.message]),
      }),
    );
    renderApp('/notifications');

    fireEvent.click(await screen.findByRole('link', { name: 'メッセージへ移動' }));

    expect(await screen.findByRole('heading', { name: `# ${GENERAL.name}` })).toBeDefined();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  });

  it('返信の通知から移ると、そのスレッドを開く', async () => {
    const parent = message(1, { replyCount: 1 });
    const reply = mentionMessage(2, { parentId: parent.id });
    const target = notification(2, { message: reply, readAt: SENT_AT });
    fakeFetch(
      routes({
        [`GET ${NOTIFICATIONS}`]: () => notificationPage([target]),
        [`GET ${MESSAGES}`]: () => page([parent]),
        [`GET ${MESSAGES}/${parent.id}/replies`]: () => page([reply]),
        [`PUT ${MESSAGES}/${parent.id}/read`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp('/notifications');

    const link = await screen.findByRole('link', { name: 'メッセージへ移動' });
    expect(link.getAttribute('href')).toBe(`${CHANNEL_PATH}?thread=${parent.id}`);
    fireEvent.click(link);

    expect(await screen.findByRole('region', { name: 'スレッド' })).toBeDefined();
  });

  it('続きがあれば「さらに読み込む」で古い通知を読む', async () => {
    const list = vi.fn<Handler>((init) => {
      void init;
      return notificationPage([notification(2)], notification(2).id);
    });
    fakeFetch(
      routes({
        [`GET ${NOTIFICATIONS}`]: list,
        [`GET ${NOTIFICATIONS}?before=${notification(2).id}`]: () =>
          notificationPage([notification(1)]),
      }),
    );
    renderApp('/notifications');

    fireEvent.click(await screen.findByRole('button', { name: 'さらに読み込む' }));

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'さらに読み込む' })).toBeNull();
  });

  it('自分へのメンションが届いたら、一覧を読み直す（ブラウザ通知の設定によらない）', async () => {
    const list = vi.fn<Handler>(() => notificationPage([]));
    fakeFetch(routes({ [`GET ${NOTIFICATIONS}`]: list }));
    const { sockets } = renderApp('/notifications');
    await screen.findByText('通知はありません。');
    list.mockImplementation(() => notificationPage([notification(1)]));

    deliverNew(sockets, mentionMessage(1));

    expect(await screen.findAllByRole('article')).toHaveLength(1);
  });

  it('読み込めなければ理由を出す', async () => {
    fakeFetch(routes({ [`GET ${NOTIFICATIONS}`]: () => error(500, 'internal_error') }));

    renderApp('/notifications');

    expect((await screen.findByRole('alert')).textContent).toMatch(/通知を読み込めませんでした/);
  });
});
