import { useState } from 'react';
import { errorMessage } from '../api/client';
import { MessageBody } from './MessageBody';
import { useMessageChannel } from './message-channel';
import { usePins, useTogglePin } from './pins';
import type { Message } from './queries';

type Scope = { workspaceId: string; channelId: string; readOnly: boolean };

/**
 * メッセージのピン留め済みの印と、ピン留めする・外す操作（F-33。機能一覧 13.2）。
 *
 * - **ピン留め済みかは、チャンネルのピン留めの一覧から決める**（メッセージの応答はピン留めを持たない）。一覧を読めるまでは操作を出さない
 * - **外す操作は、ピン留めした本人に限らず出す**（外せるのは参加者なら誰でもよい。判定は api。CLAUDE.md 2）
 * - 付け外しの操作は、チャンネルの画面の中で、アーカイブ済みでないときだけ出す（印は出す。機能一覧 3.2）。削除済みのメッセージには何も出さない
 */
export function PinControls({ message }: { message: Message }) {
  const scope = useMessageChannel();
  if (scope === null || message.body === null) return null;
  return <PinControlsFor scope={scope} messageId={message.id} />;
}

function PinControlsFor({ scope, messageId }: { scope: Scope; messageId: string }) {
  const pins = usePins(scope.workspaceId, scope.channelId);
  const toggle = useTogglePin(scope.workspaceId, scope.channelId);
  const pinned = pins.data?.pins.some((pin) => pin.message.id === messageId) ?? false;

  return (
    <>
      {pinned && <span className="text-amber-700">ピン留め済み</span>}
      {!scope.readOnly && pins.data && (
        <button
          type="button"
          className="text-slate-600 underline disabled:opacity-50"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ messageId, pin: !pinned })}
        >
          {pinned ? 'ピン留めを外す' : 'ピン留めする'}
        </button>
      )}
      {toggle.isError && (
        <span role="alert" className="text-red-700">
          {errorMessage(toggle.error)}
        </span>
      )}
    </>
  );
}

/**
 * チャンネルのピン留めの一覧（F-33。機能一覧 13.2）。押したときに開き、開くたびに読み直す
 * （ピン留めの変化は配信されないため。`usePins`）。チャンネルの画面の `MessageChannelProvider` の中に置く。
 */
export function PinnedMessages() {
  const scope = useMessageChannel();
  const [open, setOpen] = useState(false);
  if (scope === null) return null;
  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        className="rounded border px-2 py-0.5 text-sm"
        onClick={() => setOpen(!open)}
      >
        ピン留めの一覧
      </button>
      {open && <PinList scope={scope} />}
    </div>
  );
}

function PinList({ scope }: { scope: Scope }) {
  const pins = usePins(scope.workspaceId, scope.channelId);
  const toggle = useTogglePin(scope.workspaceId, scope.channelId);

  return (
    <section aria-label="ピン留め" className="mt-2 rounded border p-2">
      {pins.isError ? (
        <p role="alert" className="text-red-700">
          ピン留めを読み込めませんでした。{errorMessage(pins.error)}
        </p>
      ) : !pins.data ? (
        <p role="status" className="text-slate-600">
          読み込み中…
        </p>
      ) : pins.data.pins.length === 0 ? (
        <p className="text-slate-600">ピン留めしたメッセージはありません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pins.data.pins.map(({ message, pinnedBy }) => (
            <li key={message.id}>
              <article className="px-2 py-1">
                <header className="flex items-baseline gap-2 text-sm">
                  <span className="font-bold">
                    {message.author?.displayName ?? '削除済みの利用者'}
                  </span>
                  <time dateTime={message.createdAt} className="text-slate-500">
                    {new Date(message.createdAt).toLocaleString('ja-JP')}
                  </time>
                </header>
                <MessageBody body={message.body ?? ''} mentions={message.mentions} />
                <p className="text-sm text-slate-500">
                  {`ピン留めした人: ${pinnedBy?.displayName ?? '削除済みの利用者'}`}
                </p>
                {!scope.readOnly && (
                  <button
                    type="button"
                    className="text-sm text-slate-600 underline disabled:opacity-50"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ messageId: message.id, pin: false })}
                  >
                    ピン留めを外す
                  </button>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}
      {toggle.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(toggle.error)}
        </p>
      )}
    </section>
  );
}
