import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HERE_MENTION_NOTICE } from '@workspace-chat/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../testing/fake-api';
import {
  BOB,
  CHANNEL_PATH,
  GENERAL,
  MESSAGES,
  message,
  page,
  routes,
  WORKSPACE_ID,
} from '../testing/fake-messages';
import type { FakeSocket } from '../testing/fake-socket';
import { renderApp } from '../testing/render-app';
import { MessageBody } from './MessageBody';

const CANDIDATES = `/api/workspaces/${WORKSPACE_ID}/channels/${GENERAL.id}/mention-candidates`;
const OTHER_CHANNEL_ID = '01920000-0000-7000-8000-0000000000c9';

function candidatesPath(prefix: string): string {
  return `${CANDIDATES}?${new URLSearchParams({ prefix })}`;
}

async function openChannel(extra: Parameters<typeof fakeFetch>[0] = {}) {
  const fetch = fakeFetch(routes({ [`GET ${MESSAGES}`]: () => page([message(1)]), ...extra }));
  const view = renderApp(CHANNEL_PATH);
  await screen.findByText('メッセージ 1');
  const socket = view.sockets.at(-1)!;
  act(() => socket.open());
  return { ...fetch, ...view, socket };
}

function input(): HTMLTextAreaElement {
  return screen.getByRole('combobox', { name: 'メッセージ' }) as HTMLTextAreaElement;
}

function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

/** サーバーが `@here` の受け取りを確かめに来た。返事を返したら、その中身を返す（返さなければ undefined）。 */
function noticeHere(socket: FakeSocket, channelId: string) {
  const ack = vi.fn();
  act(() => socket.deliver(HERE_MENTION_NOTICE, { channelId, messageId: 'm-1' }, ack));
  return ack;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// 機能一覧 9.2「受け取った側は、そのチャンネルを開いていなければ弾き、開いていれば受け取りを返す」・
// 10.2「@here は、受け取った側がそのチャンネルを開いていなければ、ブラウザ通知もバッジも出さない（受け取りを返さずに弾く）」。
describe('@here の受け取り（F-21）', () => {
  it('開いているチャンネルの @here には受け取りを返し、開いていないチャンネルの @here には返さない', async () => {
    const { socket } = await openChannel();

    expect(noticeHere(socket, GENERAL.id)).toHaveBeenCalledWith({ received: true });
    expect(noticeHere(socket, OTHER_CHANNEL_ID)).not.toHaveBeenCalled();
  });

  it('チャンネルを離れた後に届いた @here には返さない', async () => {
    const { socket } = await openChannel();

    fireEvent.click(screen.getByRole('link', { name: 'チャンネルの一覧へ' }));
    await screen.findByRole('heading', { name: '開発チーム' });

    expect(noticeHere(socket, GENERAL.id)).not.toHaveBeenCalled();
  });
});

describe('@here / @channel の補完（F-21）', () => {
  it('書きかけに当たる @here / @channel を、参加者の候補の前に出し、Enter で差し込む', async () => {
    await openChannel({
      [`GET ${candidatesPath('h')}`]: () => json(200, []),
      [`GET ${candidatesPath('c')}`]: () => json(200, [{ ...BOB, userId: 'carol_b' }]),
    });

    type('みなさん @h');
    const hereList = await screen.findByRole('listbox', { name: 'メンションの候補' });
    expect(
      within(hereList)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['このチャンネルを開いている参加者 @here']);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('みなさん @here ');

    type('@c');
    // 一斉メンションの候補は読み込みを待たずに出るため、参加者の候補が読み込まれて並ぶまで待つ
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox', { name: 'メンションの候補' }))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['このチャンネルの参加者全員 @channel', 'ボブ @carol_b']),
    );
  });
});

describe('本文の @here / @channel の表示（F-21）', () => {
  it('@here / @channel を強調する。コードの中は強調しない', () => {
    const { container } = render(<MessageBody body={'@Here と @channel へ `@here`'} />);

    expect([...container.querySelectorAll('span.mention')].map((s) => s.textContent)).toEqual([
      '@here',
      '@channel',
    ]);
  });

  it('同じ綴りのユーザーID のメンションが応答に載っていれば、その利用者の表示名で出す（#497）', () => {
    const here = { id: BOB.id, userId: 'here', displayName: 'ヒア' };
    const { container } = render(
      <MessageBody body="@here" mentions={[{ userId: 'here', user: here }]} />,
    );

    expect(container.querySelector('span.mention')?.textContent).toBe('@ヒア');
  });
});
