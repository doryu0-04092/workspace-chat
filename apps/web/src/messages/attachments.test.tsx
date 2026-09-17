import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, fakeFetch, json, USER } from '../testing/fake-api';
import {
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  WORKSPACE_ID,
  message,
  page,
  routes,
} from '../testing/fake-messages';
import { renderApp } from '../testing/render-app';

// 機能一覧 11.1（F-27）: 投稿の入力欄でファイルを選んで上げ（発行 → PUT → 確定）、投稿に付ける。一覧では画像を表示し、
// 動画は #t=30 の位置を表示し（画面外の <video> は作らない）、それ以外はリンクにする。

type Handler = (init: RequestInit) => Response | Promise<Response>;

const UPLOADS = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/attachments/uploads`;
const UPLOAD_ID = '01920000-0000-7000-8000-0000000000f1';
const UPLOAD_URL = `http://127.0.0.1:9000/bucket/quarantine/workspace/${WORKSPACE_ID}/channel/${GENERAL.id}/${UPLOAD_ID}/a.png?X-Amz-Signature=x`;
const FILE_URL = (id: string, name: string) =>
  `/files/workspace/${WORKSPACE_ID}/channel/${GENERAL.id}/${id}/${name}`;

function attachment(
  id: string,
  fileName: string,
  kind: 'image' | 'video' | 'document' | 'archive',
  contentType: string,
  stored = fileName,
) {
  return { id, fileName, contentType, kind, size: 1234, url: FILE_URL(id, stored) };
}

const PNG = attachment(UPLOAD_ID, '会議の写真.png', 'image', 'image/png', '_____.png');

function ticket(id = UPLOAD_ID, url = UPLOAD_URL, contentType = 'image/png') {
  return {
    uploadId: id,
    uploadUrl: url,
    uploadHeaders: { 'Content-Type': contentType, 'If-None-Match': '*' },
    expiresAt: '2026-09-17T10:05:00.000Z',
  };
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value } });
}

function choose(...files: File[]) {
  fireEvent.change(screen.getByLabelText('ファイルを添付'), { target: { files } });
}

const pngFile = () =>
  new File([new Uint8Array([0x89, 0x50])], '会議の写真.png', { type: 'image/png' });

/** 呼ぶまで返らない応答。 */
function deferred() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { handler: () => promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('添付ファイルを付けて投稿する（F-27）', () => {
  it('ファイルを選ぶと発行・PUT・確定の順に上げ、送信で本文と添付の識別子を送り、通ったら添付の欄を空にする', async () => {
    const issue = vi.fn<Handler>(() => json(201, ticket()));
    const posted = message(2, { author: USER, body: '写真です', attachments: [PNG] });
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([]),
        [`POST ${UPLOADS}`]: issue,
        [`PUT ${UPLOAD_URL}`]: () => new Response(null, { status: 200 }),
        [`POST ${UPLOADS}/${UPLOAD_ID}/complete`]: () => json(200, PNG),
        [`POST ${MESSAGES}`]: () => json(201, posted),
      }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByLabelText('ファイルを添付');

    choose(pngFile());

    const drafts = await screen.findByRole('list', { name: '添付するファイル' });
    await within(drafts).findByText('会議の写真.png');
    await waitFor(() => expect(within(drafts).queryByText('アップロード中…')).toBeNull());
    expect(JSON.parse(String(issue.mock.calls[0]?.[0]?.body))).toEqual({
      fileName: '会議の写真.png',
      contentType: 'image/png',
      size: 2,
    });
    type('写真です');
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));

    await waitFor(() =>
      expect(screen.queryByRole('list', { name: '添付するファイル' })).toBeNull(),
    );
    const post = calls.find((c) => c.key === `POST ${MESSAGES}`)!;
    expect(JSON.parse(String(post.init.body))).toEqual({
      body: '写真です',
      attachmentIds: [UPLOAD_ID],
    });
    expect(calls.map((c) => c.key).filter((key) => /attachments|PUT http/.test(key))).toEqual([
      `POST ${UPLOADS}`,
      `PUT ${UPLOAD_URL}`,
      `POST ${UPLOADS}/${UPLOAD_ID}/complete`,
    ]);
    expect((await screen.findByRole('img', { name: '会議の写真.png' })).getAttribute('src')).toBe(
      PNG.url,
    );
  });

  it('上げている間は送信できない', async () => {
    const put = deferred();
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([]),
        [`POST ${UPLOADS}`]: () => json(201, ticket()),
        [`PUT ${UPLOAD_URL}`]: put.handler,
        [`POST ${UPLOADS}/${UPLOAD_ID}/complete`]: () => json(200, PNG),
      }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByLabelText('ファイルを添付');
    type('写真です');

    choose(pngFile());

    await screen.findByText('アップロード中…');
    expect((screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      put.resolve(new Response(null, { status: 200 }));
    });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it('上げられなかったファイルは理由を出し、送信に含めない', async () => {
    const posted = message(2, { author: USER, body: '本文' });
    const { calls } = fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([]),
        [`POST ${UPLOADS}`]: () => json(201, ticket()),
        [`PUT ${UPLOAD_URL}`]: () => new Response(null, { status: 200 }),
        [`POST ${UPLOADS}/${UPLOAD_ID}/complete`]: () => error(422, 'unsupported_file_type'),
        [`POST ${MESSAGES}`]: () => json(201, posted),
      }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByLabelText('ファイルを添付');

    choose(pngFile());

    const drafts = await screen.findByRole('list', { name: '添付するファイル' });
    expect((await within(drafts).findByRole('alert')).textContent).toContain(
      'この形式のファイルは上げられません',
    );
    type('本文');
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await waitFor(() => expect(calls.some((c) => c.key === `POST ${MESSAGES}`)).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.key === `POST ${MESSAGES}`)!.init.body))).toEqual({
      body: '本文',
    });
  });

  it('取り除いたファイルは送信に含めない', async () => {
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([]),
        [`POST ${UPLOADS}`]: () => json(201, ticket()),
        [`PUT ${UPLOAD_URL}`]: () => new Response(null, { status: 200 }),
        [`POST ${UPLOADS}/${UPLOAD_ID}/complete`]: () => json(200, PNG),
      }),
    );
    renderApp(CHANNEL_PATH);
    await screen.findByLabelText('ファイルを添付');
    choose(pngFile());
    const drafts = await screen.findByRole('list', { name: '添付するファイル' });
    await waitFor(() => expect(within(drafts).queryByText('アップロード中…')).toBeNull());

    fireEvent.click(within(drafts).getByRole('button', { name: '会議の写真.png を取り除く' }));

    expect(screen.queryByRole('list', { name: '添付するファイル' })).toBeNull();
  });

  it('許可リストに無いファイル（SVG）は送らずに理由を出す', async () => {
    const issue = vi.fn<Handler>(() => json(201, ticket()));
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([]), [`POST ${UPLOADS}`]: issue }));
    renderApp(CHANNEL_PATH);
    await screen.findByLabelText('ファイルを添付');

    choose(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }));

    const drafts = await screen.findByRole('list', { name: '添付するファイル' });
    expect((await within(drafts).findByRole('alert')).textContent).toContain('形式');
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('一覧の添付の表示（F-27）', () => {
  /** 与えた要素が画面に入ったことにできる IntersectionObserver の代わり。 */
  function stubIntersectionObserver() {
    const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
    class FakeIntersectionObserver {
      private readonly entry: { callback: IntersectionObserverCallback; targets: Element[] };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    return {
      showAll: () =>
        act(() => {
          for (const { callback, targets } of observers) {
            callback(
              targets.map(
                (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
              ),
              {} as IntersectionObserver,
            );
          }
        }),
    };
  }

  it('画像は表示し、それ以外はファイル名のリンクにする', async () => {
    stubIntersectionObserver();
    const pdf = attachment(
      '01920000-0000-7000-8000-0000000000f2',
      '資料.pdf',
      'document',
      'application/pdf',
      '__.pdf',
    );
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () => page([message(1, { attachments: [PNG, pdf] })]),
      }),
    );
    renderApp(CHANNEL_PATH);

    const image = await screen.findByRole('img', { name: '会議の写真.png' });
    expect(image.getAttribute('src')).toBe(PNG.url);
    const link = screen.getByRole('link', { name: /資料\.pdf/ });
    expect(link.getAttribute('href')).toBe(pdf.url);
  });

  it('動画は画面に入るまで <video> を作らず、入ったら #t=30 の位置を表示する', async () => {
    const observer = stubIntersectionObserver();
    const video = attachment(
      '01920000-0000-7000-8000-0000000000f3',
      'demo.mp4',
      'video',
      'video/mp4',
    );
    fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1, { attachments: [video] })]) }));
    renderApp(CHANNEL_PATH);
    await screen.findByText('メッセージ 1');
    await screen.findByText('demo.mp4');
    expect(document.querySelector('video')).toBeNull();

    observer.showAll();

    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe(`${video.url}#t=30`),
    );
  });

  it('削除済みのメッセージには添付を出さない', async () => {
    stubIntersectionObserver();
    fakeFetch(
      routes({
        [`GET ${MESSAGES}`]: () =>
          page([message(1, { body: null, deleted: true, attachments: [PNG] })]),
      }),
    );
    renderApp(CHANNEL_PATH);

    await screen.findByText('このメッセージは削除されました');
    expect(screen.queryByRole('img', { name: '会議の写真.png' })).toBeNull();
  });
});
