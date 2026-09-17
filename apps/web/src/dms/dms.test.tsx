import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, USER } from '../testing/fake-api';
import { BOB, GENERAL, routes, SENT_AT, WORKSPACE_ID } from '../testing/fake-messages';
import type { FakeSocket } from '../testing/fake-socket';
import { renderApp } from '../testing/render-app';

/** テストで使う3人目の利用者（実在の人物ではない）。 */
const CAROL = {
  id: '01920000-0000-7000-8000-000000000003',
  userId: 'carol',
  displayName: 'キャロル',
};

const DM = {
  id: '01920000-0000-7000-8000-0000000000d1',
  counterpart: BOB,
  writable: true,
  joinedAt: '2026-09-14T00:00:00.000Z',
  unread: 0,
  lastReadMessageId: null as string | null,
};
const OTHER_DM_ID = '01920000-0000-7000-8000-0000000000d9';
const WORKSPACE_PATH = `/workspaces/${WORKSPACE_ID}`;
const DM_PATH = `${WORKSPACE_PATH}/dms/${DM.id}`;
const DMS = `/api/workspaces/${WORKSPACE_ID}/dms`;
const DM_MESSAGES = `${DMS}/${DM.id}/messages`;
const DM_READ = `${DMS}/${DM.id}/read`;
const MEMBERS = `/api/workspaces/${WORKSPACE_ID}/members`;

/** `n` 番目の DM のメッセージ（REST の DmMessage と同じ形）。id は `n` から作り、作った時刻は `n` 分目にする。 */
function dmMessage(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    dmId: DM.id,
    author: BOB as typeof BOB | null,
    body: `DM ${n}` as string | null,
    createdAt: new Date(Date.UTC(2026, 8, 14, 0, n)).toISOString(),
    editedAt: null as string | null,
    deleted: false,
    ...overrides,
  };
}

function dmPage(messages: ReturnType<typeof dmMessage>[], nextBefore: string | null = null) {
  return json(200, { messages, nextBefore });
}

function dmRoutes(extra: Parameters<typeof fakeFetch>[0] = {}) {
  return routes({
    [`GET ${DMS}`]: () => json(200, [DM]),
    [`GET ${DM_MESSAGES}`]: () => dmPage([dmMessage(1)]),
    [`PUT ${DM_READ}`]: () => new Response(null, { status: 204 }),
    ...extra,
  });
}

async function openDm(extra: Parameters<typeof fakeFetch>[0] = {}) {
  const fetch = fakeFetch(dmRoutes(extra));
  const view = renderApp(DM_PATH);
  await screen.findByRole('heading', { name: 'ボブ との DM' });
  return { ...fetch, ...view, socket: view.sockets.at(-1)! };
}

async function pause(ms = 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 接続を受け入れ、接続したときの一覧の読み直しが終わるまで待つ（待たずに配ると、読み直しの応答で配った行が上書きされる）。 */
async function accept(socket: FakeSocket, count: (key: string) => number) {
  act(() => socket.open());
  await waitFor(() => expect(count(`GET ${DM_MESSAGES}`)).toBe(2));
  await pause();
}

function rows(): string[] {
  return screen.getAllByRole('article').map((article) => article.textContent ?? '');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 機能一覧 8（F-19）: ダイレクトメッセージの web。10.1: DM の未読をサイドバーで太字にし、件数を文字でも出す。#574。
describe('DM の一覧（F-19）', () => {
  it('ワークスペースの画面に自分の DM を並べ、未読のある DM は太字で件数を文字でも出し、退会した相手は「削除済みの利用者」と出す', async () => {
    const withCarol = { ...DM, id: OTHER_DM_ID, counterpart: null, unread: 0 };
    fakeFetch(routes({ [`GET ${DMS}`]: () => json(200, [{ ...DM, unread: 2 }, withCarol]) }));

    renderApp(WORKSPACE_PATH);

    const list = await screen.findByRole('list', { name: 'DM' });
    const [bob, deleted] = within(list).getAllByRole('listitem');
    const bobLink = within(bob!).getByRole('link', { name: 'ボブ' });
    expect(bobLink.getAttribute('href')).toBe(DM_PATH);
    expect(bobLink.className).toContain('font-bold');
    expect(within(bob!).getByText('未読 2 件')).toBeDefined();
    const deletedLink = within(deleted!).getByRole('link', { name: '削除済みの利用者' });
    expect(deletedLink.className).not.toContain('font-bold');
    expect(within(deleted!).queryByText(/未読/)).toBeNull();
  });

  it('DM が無ければ、無いことを出す', async () => {
    fakeFetch(routes({ [`GET ${DMS}`]: () => json(200, []) }));

    renderApp(WORKSPACE_PATH);

    expect(await screen.findByText('DM はまだありません。')).toBeDefined();
  });

  it('相手を選んで始めると、相手の User.id を送り、その DM の画面へ移る。相手の候補に自分は出さない', async () => {
    const started = { ...DM, id: OTHER_DM_ID, counterpart: CAROL };
    const { calls } = fakeFetch(
      dmRoutes({
        [`GET ${DMS}`]: () => json(200, []),
        [`GET ${MEMBERS}`]: () =>
          json(200, [
            { ...USER, role: 'MEMBER' },
            { ...CAROL, role: 'OWNER' },
          ]),
        [`POST ${DMS}`]: () => json(200, started),
        [`GET ${DMS}/${OTHER_DM_ID}/messages`]: () => dmPage([]),
      }),
    );
    renderApp(WORKSPACE_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'DM を始める' }));
    const select = await screen.findByLabelText('DM の相手');
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['キャロル @carol']);
    fireEvent.change(select, { target: { value: CAROL.id } });
    fireEvent.click(screen.getByRole('button', { name: 'DM を開く' }));

    expect(await screen.findByRole('heading', { name: 'キャロル との DM' })).toBeDefined();
    const post = calls.find((c) => c.key === `POST ${DMS}`)!;
    expect(JSON.parse(String(post.init.body))).toEqual({ userId: CAROL.id });
    expect(headerOf(post.init, 'Authorization')).toBe('Bearer t1');
  });

  it('始めるのを断られたら、理由を出して画面に留まる', async () => {
    fakeFetch(
      dmRoutes({
        [`GET ${DMS}`]: () => json(200, []),
        [`GET ${MEMBERS}`]: () => json(200, [{ ...CAROL, role: 'MEMBER' }]),
        [`POST ${DMS}`]: () => error(422, 'dm_counterpart_not_found'),
      }),
    );
    renderApp(WORKSPACE_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'DM を始める' }));
    fireEvent.change(await screen.findByLabelText('DM の相手'), { target: { value: CAROL.id } });
    fireEvent.click(screen.getByRole('button', { name: 'DM を開く' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'その利用者はこのワークスペースのメンバーではありません',
    );
    expect(screen.queryByRole('heading', { name: /との DM/ })).toBeNull();
  });
});

describe('DM の画面（F-19）', () => {
  it('メッセージを上が古い順に並べ、送信した応答を最後に足す（一覧は読み直さない）', async () => {
    const sent = dmMessage(3, { author: USER, body: '送った本文' });
    const { calls, count } = await openDm({
      [`GET ${DM_MESSAGES}`]: () => dmPage([dmMessage(2), dmMessage(1)]),
      [`POST ${DM_MESSAGES}`]: () => json(201, sent),
    });
    await screen.findByText('DM 2');
    expect(rows().map((row) => row.includes('DM 1'))).toEqual([true, false]);

    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: '送った本文' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));

    await screen.findByText('送った本文');
    expect(rows().at(-1)).toContain('送った本文');
    const post = calls.find((c) => c.key === `POST ${DM_MESSAGES}`)!;
    expect(JSON.parse(String(post.init.body))).toEqual({ body: '送った本文' });
    expect(count(`GET ${DM_MESSAGES}`)).toBe(1);
  });

  it('DM の入力欄はメンションの補完をしない（補完の候補を読まない）', async () => {
    await openDm();

    const input = await screen.findByLabelText('メッセージ');
    fireEvent.change(input, { target: { value: '@bo', selectionStart: 3 } });
    await pause();

    expect(input.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('開くと、読み込んだ最新の削除されていないメッセージまで既読を進める', async () => {
    const { calls } = await openDm({
      [`GET ${DM_MESSAGES}`]: () =>
        dmPage([dmMessage(3, { body: null, deleted: true }), dmMessage(2), dmMessage(1)]),
    });

    await waitFor(() => expect(calls.some((c) => c.key === `PUT ${DM_READ}`)).toBe(true));
    const put = calls.find((c) => c.key === `PUT ${DM_READ}`)!;
    expect(JSON.parse(String(put.init.body))).toEqual({ lastReadMessageId: dmMessage(2).id });
  });

  it('「ここから未読」の線を、開いた時点の既読位置の次のメッセージの上に出す', async () => {
    await openDm({
      [`GET ${DMS}`]: () => json(200, [{ ...DM, unread: 1, lastReadMessageId: dmMessage(1).id }]),
      [`GET ${DM_MESSAGES}`]: () => dmPage([dmMessage(2), dmMessage(1)]),
    });
    await screen.findByText('DM 2');

    const divider = screen.getByRole('separator', { name: 'ここから未読' });
    const next = screen.getByText('DM 2').closest('article')!;
    expect(divider.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      divider.compareDocumentPosition(screen.getByText('DM 1').closest('article')!) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  // CLAUDE.md「必ずテストを書く箇所」5: Markdown が HTML として解釈されないこと。DM も同じ描画の部品を通す。
  it('本文の HTML は要素にならず、javascript: のリンクは無効になる', async () => {
    await openDm({
      [`GET ${DM_MESSAGES}`]: () =>
        dmPage([
          dmMessage(1, { body: '<img src=x onerror=alert(1)> [押す](javascript:alert(1))' }),
        ]),
    });

    const link = await screen.findByText('押す');
    const article = link.closest('article')!;
    expect(article.querySelector('img')).toBeNull();
    expect(article.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(link.closest('a')?.getAttribute('href') ?? '').not.toContain('javascript:');
  });

  it('自分のメッセージにだけ編集・削除を出し、編集は DM の api に送ってその場で置き換え、削除は確かめてから送る', async () => {
    const mine = dmMessage(2, { author: USER, body: '自分の本文' });
    const edited = { ...mine, body: '直した本文', editedAt: '2026-09-16T00:00:00.000Z' };
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { calls } = await openDm({
      [`GET ${DM_MESSAGES}`]: () => dmPage([mine, dmMessage(1)]),
      [`PATCH ${DM_MESSAGES}/${mine.id}`]: () => json(200, edited),
      [`DELETE ${DM_MESSAGES}/${mine.id}`]: () => new Response(null, { status: 204 }),
    });
    const others = (await screen.findByText('DM 1')).closest('article')!;
    expect(within(others).queryByRole('button', { name: '編集する' })).toBeNull();
    const own = screen.getByText('自分の本文').closest('article')!;

    fireEvent.click(within(own).getByRole('button', { name: '編集する' }));
    fireEvent.change(within(own).getByLabelText('メッセージを編集'), {
      target: { value: '直した本文' },
    });
    fireEvent.click(within(own).getByRole('button', { name: '保存する' }));
    const after = (await screen.findByText('（編集済み）')).closest('article')!;
    expect(within(after).getByText('直した本文')).toBeDefined();
    const patch = calls.find((c) => c.key === `PATCH ${DM_MESSAGES}/${mine.id}`)!;
    expect(JSON.parse(String(patch.init.body))).toEqual({ body: '直した本文' });

    fireEvent.click(within(after).getByRole('button', { name: '削除する' }));
    expect(await screen.findByText('このメッセージは削除されました')).toBeDefined();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.key === `DELETE ${DM_MESSAGES}/${mine.id}`)).toBe(true);
  });

  it('相手がメンバーでなくなった DM は、送信のフォームを出さず理由を出す（過去のメッセージは読める）', async () => {
    await openDm({ [`GET ${DMS}`]: () => json(200, [{ ...DM, writable: false }]) });

    expect(await screen.findByText('DM 1')).toBeDefined();
    expect(
      screen.getByText('相手がこのワークスペースのメンバーではなくなったため、送信できません。'),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: '送信する' })).toBeNull();
  });

  it('送信を 409 dm_counterpart_unavailable で断られたら、理由を出して入力を残す', async () => {
    await openDm({ [`POST ${DM_MESSAGES}`]: () => error(409, 'dm_counterpart_unavailable') });

    const input = await screen.findByLabelText('メッセージ');
    fireEvent.change(input, { target: { value: '届かない' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      '相手がこのワークスペースのメンバーではなくなったため、送信できません',
    );
    expect((input as HTMLTextAreaElement).value).toBe('届かない');
  });

  it('当事者でない DM・無い DM の URL では、見つからないことを出す', async () => {
    fakeFetch(dmRoutes({ [`GET ${DMS}`]: () => json(200, []) }));

    renderApp(DM_PATH);

    expect(await screen.findByText('DM が見つかりません。')).toBeDefined();
  });
});

// 機能一覧 5.2 の DM の箇条: DM で起きるイベントは、チャンネルと同じイベント名で、dmId を持って届く。
describe('DM のリアルタイムの反映（F-19）', () => {
  it('開いている DM の message:new は足し、別の DM とチャンネルのメッセージは足さない。同じ id は2行にしない', async () => {
    const { socket, count } = await openDm();
    await screen.findByText('DM 1');
    await accept(socket, count);

    act(() => {
      socket.deliver('message:new', { message: dmMessage(2), sentAt: SENT_AT });
      socket.deliver('message:new', { message: dmMessage(2), sentAt: SENT_AT });
      socket.deliver('message:new', {
        message: dmMessage(3, { dmId: OTHER_DM_ID, body: '別の DM' }),
        sentAt: SENT_AT,
      });
      socket.deliver('message:new', {
        message: {
          ...dmMessage(4, { body: 'チャンネルの' }),
          dmId: undefined,
          channelId: GENERAL.id,
          parentId: null,
          replyCount: 0,
          replyParticipants: [],
          mentions: [],
        },
        sentAt: SENT_AT,
      });
    });

    await screen.findByText('DM 2');
    await pause();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText('別の DM')).toBeNull();
    expect(screen.queryByText('チャンネルの')).toBeNull();
  });

  it('message:updated で置き換え、message:deleted で削除済みにする（別の DM の削除は当てない）', async () => {
    const { socket, count } = await openDm({
      [`GET ${DM_MESSAGES}`]: () => dmPage([dmMessage(2), dmMessage(1)]),
    });
    await screen.findByText('DM 2');
    await accept(socket, count);

    act(() => {
      socket.deliver('message:updated', {
        message: dmMessage(1, { body: '直された', editedAt: SENT_AT }),
        sentAt: SENT_AT,
      });
      socket.deliver('message:deleted', {
        dmId: OTHER_DM_ID,
        messageId: dmMessage(2).id,
        sentAt: SENT_AT,
      });
    });
    expect(await screen.findByText('直された')).toBeDefined();
    expect(screen.getByText('DM 2')).toBeDefined();

    act(() => {
      socket.deliver('message:deleted', {
        dmId: DM.id,
        messageId: dmMessage(2).id,
        sentAt: SENT_AT,
      });
    });
    expect(await screen.findByText('このメッセージは削除されました')).toBeDefined();
  });

  // 接続したとき（初回も）にも読み直す——読み込みから接続までの間に届いたメッセージは、配信では届かない（チャンネルの入室の読み直しと同じ）
  it('接続したとき・繋ぎ直したときに、切れていた間のメッセージを補うため一覧を読み直す', async () => {
    const { socket, count } = await openDm({
      [`GET ${DM_MESSAGES}`]: [
        () => dmPage([dmMessage(1)]),
        () => dmPage([dmMessage(1)]),
        () => dmPage([dmMessage(2), dmMessage(1)]),
      ],
    });
    await screen.findByText('DM 1');
    act(() => socket.open());
    await waitFor(() => expect(count(`GET ${DM_MESSAGES}`)).toBe(2));
    act(() => socket.drop());

    act(() => socket.open());

    expect(await screen.findByText('DM 2')).toBeDefined();
    expect(count(`GET ${DM_MESSAGES}`)).toBe(3);
  });
});

describe('DM の未読のリアルタイムの反映（F-23）', () => {
  it('unread:updated（dmId）を、一覧のその DM の未読数に当て、一覧は読み直さない', async () => {
    const { count, sockets } = (() => {
      const fetch = fakeFetch(routes({ [`GET ${DMS}`]: () => json(200, [DM]) }));
      return { ...fetch, ...renderApp(WORKSPACE_PATH) };
    })();
    const link = await screen.findByRole('link', { name: 'ボブ' });
    expect(link.className).not.toContain('font-bold');

    act(() => {
      sockets.at(-1)!.deliver('unread:updated', {
        workspaceId: WORKSPACE_ID,
        dmId: DM.id,
        unread: 4,
        sentAt: SENT_AT,
      });
    });

    expect(await screen.findByText('未読 4 件')).toBeDefined();
    expect(screen.getByRole('link', { name: 'ボブ' }).className).toContain('font-bold');
    expect(count(`GET ${DMS}`)).toBe(1);
  });

  it('一覧に無い DM の未読が届いたら一覧を取り直し、別のワークスペースの DM なら取り直さない', async () => {
    const withCarol = { ...DM, id: OTHER_DM_ID, counterpart: CAROL, unread: 1 };
    const { count, sockets } = (() => {
      const fetch = fakeFetch(
        routes({ [`GET ${DMS}`]: [() => json(200, []), () => json(200, [withCarol])] }),
      );
      return { ...fetch, ...renderApp(WORKSPACE_PATH) };
    })();
    await screen.findByText('DM はまだありません。');
    const socket = sockets.at(-1)!;

    act(() => {
      socket.deliver('unread:updated', {
        workspaceId: '01920000-0000-7000-8000-0000000000a9',
        dmId: '01920000-0000-7000-8000-0000000000e1',
        unread: 1,
        sentAt: SENT_AT,
      });
    });
    await pause();
    expect(count(`GET ${DMS}`)).toBe(1);

    act(() => {
      socket.deliver('unread:updated', {
        workspaceId: WORKSPACE_ID,
        dmId: OTHER_DM_ID,
        unread: 1,
        sentAt: SENT_AT,
      });
    });

    expect(await screen.findByRole('link', { name: 'キャロル' })).toBeDefined();
    expect(count(`GET ${DMS}`)).toBe(2);
  });

  it('チャンネルの未読の配信は、DM の一覧に当てない（DM の未読の配信も、チャンネルの一覧に当てない）', async () => {
    const { sockets } = (() => {
      const fetch = fakeFetch(
        routes({
          [`GET ${DMS}`]: () => json(200, [{ ...DM, id: GENERAL.id }]),
        }),
      );
      return { ...fetch, ...renderApp(WORKSPACE_PATH) };
    })();
    await screen.findByRole('link', { name: 'ボブ' });

    act(() => {
      sockets.at(-1)!.deliver('unread:updated', {
        channelId: GENERAL.id,
        unread: 5,
        mentions: 0,
        sentAt: SENT_AT,
      });
    });

    // チャンネルの一覧には当たる（同じ id の DM には当たらない）
    const channels = await screen.findByRole('list', { name: 'チャンネル' });
    expect(await within(channels).findByText('未読 5 件')).toBeDefined();
    const dms = screen.getByRole('list', { name: 'DM' });
    expect(within(dms).queryByText(/未読/)).toBeNull();
  });
});
