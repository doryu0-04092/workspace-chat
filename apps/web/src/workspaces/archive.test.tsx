import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, headerOf, json, USER } from '../testing/fake-api';
import { BOB, GENERAL, WORKSPACE, WORKSPACE_ID, routes } from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

const WORKSPACE_PATH = `/workspaces/${WORKSPACE_ID}`;
const MANAGED = `/api/workspaces/${WORKSPACE_ID}/managed-channels`;
const CHANNELS = `/api/workspaces/${WORKSPACE_ID}/channels`;
const AS_OWNER = {
  [`GET /api/workspaces/${WORKSPACE_ID}`]: () => json(200, { ...WORKSPACE, role: 'OWNER' }),
};

/** 管理用の一覧の項目（REST の ManagedChannel と同じ形）。 */
const MANAGED_GENERAL = {
  id: GENERAL.id,
  name: 'general',
  visibility: 'PUBLIC',
  memberCount: 2,
  archived: false,
};
/** 参加していないプライベートチャンネル（一般の一覧には出ないが、管理用の一覧には出る）。 */
const SECRET = {
  id: '01920000-0000-7000-8000-0000000000c9',
  name: 'secret',
  visibility: 'PRIVATE',
  memberCount: 1,
  archived: false,
};

async function pause() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function openManaged() {
  fireEvent.click(await screen.findByRole('button', { name: 'チャンネルを管理する' }));
  return within(await screen.findByRole('list', { name: '管理用のチャンネル一覧' }));
}

function rowOf(list: ReturnType<typeof within>, name: RegExp): HTMLElement {
  return list
    .getAllByRole('listitem')
    .find((item: HTMLElement) => name.test(item.textContent ?? ''))!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 機能一覧 3.1・3.2（F-35）: オーナーの管理用の一覧と、アーカイブ・復元の web。#544。
describe('管理用のチャンネル一覧（F-35・3.1）', () => {
  it('オーナーには「チャンネルを管理する」を出し、メンバーには出さない', async () => {
    fakeFetch(routes(AS_OWNER));
    const owner = renderApp(WORKSPACE_PATH);
    expect(await screen.findByRole('button', { name: 'チャンネルを管理する' })).toBeDefined();
    owner.unmount();

    fakeFetch(routes());
    renderApp(WORKSPACE_PATH);
    await screen.findByRole('button', { name: 'メンバーを見る' });
    expect(screen.queryByRole('button', { name: 'チャンネルを管理する' })).toBeNull();
  });

  it('押すまで読まない。押すと、参加していないプライベートとアーカイブ済みも含めて、名前・種別・参加者数・アーカイブ済みかを出す', async () => {
    const archived = {
      ...SECRET,
      id: '01920000-0000-7000-8000-0000000000ca',
      name: 'old-1',
      visibility: 'PUBLIC',
      archived: true,
    };
    const { count, calls } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: () => json(200, [MANAGED_GENERAL, archived, SECRET]),
      }),
    );
    renderApp(WORKSPACE_PATH);
    await screen.findByRole('button', { name: 'チャンネルを管理する' });
    expect(count(`GET ${MANAGED}`)).toBe(0);

    const list = await openManaged();

    expect(rowOf(list, /general/).textContent).toContain('参加者 2 人');
    expect(rowOf(list, /secret/).textContent).toContain('プライベート');
    expect(rowOf(list, /old-1/).textContent).toContain('アーカイブ済み');
    expect(rowOf(list, /general/).textContent).not.toContain('アーカイブ済み');
    const read = calls.find((c) => c.key === `GET ${MANAGED}`)!;
    expect(headerOf(read.init, 'Authorization')).toBe('Bearer t1');
  });

  it('管理用の一覧を読めなければ、理由を出す', async () => {
    fakeFetch(routes({ ...AS_OWNER, [`GET ${MANAGED}`]: () => error(500, 'internal_error') }));
    renderApp(WORKSPACE_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'チャンネルを管理する' }));

    expect(await screen.findByText(/管理用のチャンネル一覧を読み込めませんでした/)).toBeDefined();
  });
});

describe('アーカイブ（F-35・3.2）', () => {
  // **一般の一覧からは、取り直しを待たずに外す**（#533 第0巡の 🔴1 と同じ型）。取り直しは返さない。
  it('確かめてから送り、管理用の一覧の行を応答で置き換え（名前に番号が付く）、一般の一覧からは取り直しを待たずに外す', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${CHANNELS}`]: [() => json(200, [GENERAL]), () => new Promise<Response>(() => {})],
        [`GET ${MANAGED}`]: () => json(200, [MANAGED_GENERAL]),
        [`POST ${CHANNELS}/${GENERAL.id}/archive`]: () =>
          json(200, { ...MANAGED_GENERAL, name: 'general-1', archived: true }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const channels = within(await screen.findByRole('list', { name: 'チャンネル' }));
    expect(channels.getByText(/# general/)).toBeDefined();
    const list = await openManaged();

    fireEvent.click(
      within(rowOf(list, /general/)).getByRole('button', { name: 'general をアーカイブする' }),
    );

    await waitFor(() => expect(rowOf(list, /general-1/).textContent).toContain('アーカイブ済み'));
    await waitFor(() => expect(screen.queryByRole('link', { name: /# general/ })).toBeNull());
    expect(confirm).toHaveBeenCalledOnce();
    const archive = calls.find((c) => c.key === `POST ${CHANNELS}/${GENERAL.id}/archive`)!;
    expect(headerOf(archive.init, 'Authorization')).toBe('Bearer t1');
  });

  it('アーカイブの確かめを取り消したら送らない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { count } = fakeFetch(
      routes({ ...AS_OWNER, [`GET ${MANAGED}`]: () => json(200, [MANAGED_GENERAL]) }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();

    fireEvent.click(
      within(rowOf(list, /general/)).getByRole('button', { name: 'general をアーカイブする' }),
    );
    // **要求は非同期で出る**ので、出る分だけ待ってから数える
    await pause();

    expect(count(`POST ${CHANNELS}/${GENERAL.id}/archive`)).toBe(0);
  });

  it('アーカイブが断られたら理由を出す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: () => json(200, [MANAGED_GENERAL]),
        [`POST ${CHANNELS}/${GENERAL.id}/archive`]: () => error(409, 'channel_archived'),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();

    fireEvent.click(
      within(rowOf(list, /general/)).getByRole('button', { name: 'general をアーカイブする' }),
    );

    expect(await screen.findByText(/アーカイブ済みのチャンネルです/)).toBeDefined();
  });
});

describe('復元（F-35・3.2）', () => {
  it('アーカイブ済みには「復元する」を出し、送って行を置き換え、一般の一覧を取り直す', async () => {
    const archived = { ...MANAGED_GENERAL, name: 'general-1', archived: true };
    const { count } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${CHANNELS}`]: [
          () => json(200, []),
          () => json(200, [{ ...GENERAL, name: 'general-1' }]),
        ],
        [`GET ${MANAGED}`]: () => json(200, [archived]),
        [`POST ${CHANNELS}/${GENERAL.id}/restore`]: () =>
          json(200, { ...archived, archived: false }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();
    expect(
      within(rowOf(list, /general-1/)).queryByRole('button', { name: /をアーカイブする$/ }),
    ).toBeNull();

    fireEvent.click(
      within(rowOf(list, /general-1/)).getByRole('button', { name: 'general-1 を復元する' }),
    );

    await waitFor(() =>
      expect(rowOf(list, /general-1/).textContent).not.toContain('アーカイブ済み'),
    );
    expect(await screen.findByRole('link', { name: /# general-1/ })).toBeDefined();
    expect(count(`GET ${CHANNELS}`)).toBe(2);
    expect(count(`POST ${CHANNELS}/${GENERAL.id}/restore`)).toBe(1);
  });

  it('復元が断られたら理由を出す', async () => {
    const archived = { ...MANAGED_GENERAL, name: 'general-1', archived: true };
    fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: () => json(200, [archived]),
        [`POST ${CHANNELS}/${GENERAL.id}/restore`]: () => error(409, 'channel_not_archived'),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();

    fireEvent.click(
      within(rowOf(list, /general-1/)).getByRole('button', { name: 'general-1 を復元する' }),
    );

    expect(await screen.findByText(/アーカイブされていないチャンネルです/)).toBeDefined();
  });
});

// **管理用の一覧の人数・行を変える操作は、通ったら管理用の一覧を直すか取り直す**（#545 第0巡の 🔴1 の適用先）。
// 参加（人数が増える）と作成（行が増える）は、どのように増えるかを画面が決めきれないので取り直す。
describe('管理用の一覧を変える、ほかの操作', () => {
  it('開いている間にチャンネルへ参加したら、管理用の一覧を取り直す', async () => {
    const random = {
      ...GENERAL,
      id: '01920000-0000-7000-8000-0000000000c2',
      name: 'random',
      joined: false,
    };
    const { count } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${CHANNELS}`]: () => json(200, [random]),
        [`GET ${MANAGED}`]: [
          () => json(200, [{ ...MANAGED_GENERAL, id: random.id, name: 'random', memberCount: 1 }]),
          () => json(200, [{ ...MANAGED_GENERAL, id: random.id, name: 'random', memberCount: 2 }]),
        ],
        [`POST ${CHANNELS}/${random.id}/join`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();
    expect(rowOf(list, /random/).textContent).toContain('参加者 1 人');

    fireEvent.click(screen.getByRole('button', { name: 'random に参加する' }));

    await waitFor(() => expect(rowOf(list, /random/).textContent).toContain('参加者 2 人'));
    expect(count(`GET ${MANAGED}`)).toBe(2);
  });

  it('開いている間にチャンネルを作ったら、管理用の一覧を取り直す', async () => {
    const created = {
      ...MANAGED_GENERAL,
      id: '01920000-0000-7000-8000-0000000000c3',
      name: 'design',
      memberCount: 1,
    };
    const { count } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: [
          () => json(200, [MANAGED_GENERAL]),
          () => json(200, [MANAGED_GENERAL, created]),
        ],
        [`POST ${CHANNELS}`]: () =>
          json(201, {
            ...GENERAL,
            id: created.id,
            name: 'design',
            unread: 0,
            mentions: 0,
            lastReadMessageId: null,
          }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();

    fireEvent.change(screen.getByLabelText('チャンネル名'), { target: { value: 'design' } });
    fireEvent.click(screen.getByRole('button', { name: 'チャンネルを作成する' }));

    await waitFor(() => expect(rowOf(list, /design/)).toBeDefined());
    expect(count(`GET ${MANAGED}`)).toBe(2);
  });

  // **一般の一覧の取り直しは `exact` で当てる**（#553）。鍵の前方には、各チャンネルのメッセージ・返信・参加者の一覧が入っており、
  // 前方一致で当てると、開いてある別のチャンネルの参加者の一覧まで読み直す。
  it('参加しても、開いてある別のチャンネルの参加者の一覧は読み直さない', async () => {
    const random = {
      ...GENERAL,
      id: '01920000-0000-7000-8000-0000000000c2',
      name: 'random',
      joined: false,
    };
    const generalMembers = `GET ${CHANNELS}/${GENERAL.id}/members`;
    const { count } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${CHANNELS}`]: () => json(200, [GENERAL, random]),
        [`GET ${MANAGED}`]: [
          () => json(200, [MANAGED_GENERAL, { ...MANAGED_GENERAL, id: random.id, name: 'random' }]),
          () =>
            json(200, [
              MANAGED_GENERAL,
              { ...MANAGED_GENERAL, id: random.id, name: 'random', memberCount: 3 },
            ]),
        ],
        [generalMembers]: () => json(200, [USER, BOB]),
        [`POST ${CHANNELS}/${random.id}/join`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();
    const general = within(rowOf(list, /general/));
    fireEvent.click(general.getByRole('button', { name: '参加者を見る' }));
    await general.findByRole('list', { name: '参加者' });
    expect(count(generalMembers)).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'random に参加する' }));

    await waitFor(() => expect(rowOf(list, /random/).textContent).toContain('参加者 3 人'));
    await pause();
    expect(count(generalMembers)).toBe(1);
  });

  it('チャンネルを作っても、開いてある別のチャンネルの参加者の一覧は読み直さない', async () => {
    const created = {
      ...MANAGED_GENERAL,
      id: '01920000-0000-7000-8000-0000000000c3',
      name: 'design',
      memberCount: 1,
    };
    const generalMembers = `GET ${CHANNELS}/${GENERAL.id}/members`;
    const { count } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: [
          () => json(200, [MANAGED_GENERAL]),
          () => json(200, [MANAGED_GENERAL, created]),
        ],
        [generalMembers]: () => json(200, [USER, BOB]),
        [`POST ${CHANNELS}`]: () =>
          json(201, {
            ...GENERAL,
            id: created.id,
            name: 'design',
            unread: 0,
            mentions: 0,
            lastReadMessageId: null,
          }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();
    const general = within(rowOf(list, /general/));
    fireEvent.click(general.getByRole('button', { name: '参加者を見る' }));
    await general.findByRole('list', { name: '参加者' });
    expect(count(generalMembers)).toBe(1);

    fireEvent.change(screen.getByLabelText('チャンネル名'), { target: { value: 'design' } });
    fireEvent.click(screen.getByRole('button', { name: 'チャンネルを作成する' }));

    await waitFor(() => expect(rowOf(list, /design/)).toBeDefined());
    await pause();
    expect(count(generalMembers)).toBe(1);
  });
});

// #539 から回した分: **参加していないプライベートチャンネルからも、管理用の一覧で相手を選んで外せる**（機能一覧 3.1・2.2）。
// **出す理由は直前の操作のものだけ**（#534 と同じ型を先に塞ぐ）。
describe('断られた理由の出し方', () => {
  it('アーカイブが断られた後に別のチャンネルの復元が通ったら、アーカイブの理由を残さない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const old = { ...SECRET, name: 'old-1', visibility: 'PUBLIC', archived: true };
    fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: () => json(200, [MANAGED_GENERAL, old]),
        [`POST ${CHANNELS}/${GENERAL.id}/archive`]: () => error(409, 'channel_archived'),
        [`POST ${CHANNELS}/${old.id}/restore`]: () => json(200, { ...old, archived: false }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();

    fireEvent.click(
      within(rowOf(list, /general/)).getByRole('button', { name: 'general をアーカイブする' }),
    );
    expect(await screen.findByText(/アーカイブ済みのチャンネルです/)).toBeDefined();

    fireEvent.click(within(rowOf(list, /old-1/)).getByRole('button', { name: 'old-1 を復元する' }));

    await waitFor(() => expect(rowOf(list, /old-1/).textContent).not.toContain('アーカイブ済み'));
    expect(screen.queryByText(/アーカイブ済みのチャンネルです/)).toBeNull();
  });
});

describe('管理用の一覧からのキック（F-09）', () => {
  it('参加していないプライベートチャンネルの参加者を見て、外せる', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const secretMembers = `${CHANNELS}/${SECRET.id}/members`;
    const { count } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: () => json(200, [SECRET]),
        [`GET ${secretMembers}`]: () => json(200, [BOB]),
        [`DELETE ${secretMembers}/${BOB.id}`]: () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();
    const row = within(rowOf(list, /secret/));

    fireEvent.click(row.getByRole('button', { name: '参加者を見る' }));
    const members = within(await row.findByRole('list', { name: '参加者' }));
    fireEvent.click(members.getByRole('button', { name: 'ボブ をチャンネルから外す' }));

    await waitFor(() => expect(members.queryByText(/ボブ/)).toBeNull());
    expect(count(`DELETE ${secretMembers}/${BOB.id}`)).toBe(1);
    // **同じ行の見出しの人数も、その場で直る**（参加者の一覧と食い違ったまま残さない。#545 第0巡の 🔴1）。管理用の一覧は取り直さない
    expect(rowOf(list, /secret/).textContent).toContain('参加者 0 人');
    expect(count(`GET ${MANAGED}`)).toBe(1);
    // ログインしている利用者（アリス）は、この一覧に居ない
    expect(USER.id).not.toBe(BOB.id);
  });

  // ワークスペースからのキックは、外した相手がどのチャンネルに居たかを画面が知らないため、管理用の一覧を取り直す（#545 第0巡の 🔴1）。
  it('ワークスペースからキックしたら、開いている管理用の一覧を取り直し、人数を直す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { count } = fakeFetch(
      routes({
        ...AS_OWNER,
        [`GET ${MANAGED}`]: [
          () => json(200, [MANAGED_GENERAL]),
          () => json(200, [{ ...MANAGED_GENERAL, memberCount: 1 }]),
        ],
        [`GET /api/workspaces/${WORKSPACE_ID}/members`]: () =>
          json(200, [
            { ...USER, role: 'OWNER' },
            { ...BOB, role: 'MEMBER' },
          ]),
        [`DELETE /api/workspaces/${WORKSPACE_ID}/members/${BOB.id}`]: () =>
          new Response(null, { status: 204 }),
      }),
    );
    renderApp(WORKSPACE_PATH);
    const list = await openManaged();
    expect(rowOf(list, /general/).textContent).toContain('参加者 2 人');

    fireEvent.click(await screen.findByRole('button', { name: 'メンバーを見る' }));
    const members = within(await screen.findByRole('list', { name: 'メンバー' }));
    fireEvent.click(members.getByRole('button', { name: 'ボブ をキックする' }));

    await waitFor(() => expect(rowOf(list, /general/).textContent).toContain('参加者 1 人'));
    expect(count(`GET ${MANAGED}`)).toBe(2);
  });
});
