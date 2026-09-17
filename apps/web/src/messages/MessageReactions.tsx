import { useState } from 'react';
import { errorMessage } from '../api/client';
import { useSession } from '../auth/session-context';
import { useMessageChannel } from './message-channel';
import type { Message } from './queries';
import { REACTION_EMOJIS, useToggleReaction } from './reactions';

type Reaction = Message['reactions'][number];

/**
 * 付けた人の表示名（「誰が付けたか」をホバーで出す。機能一覧 7）。**退会した利用者は api が `users` に載せない**ため、人数との差を「削除済みの利用者」として足す（1.5）。
 */
function reactorsOf(reaction: Reaction): string {
  const names = reaction.users.map((user) => user.displayName);
  const deleted = reaction.count - reaction.users.length;
  if (deleted > 0) names.push(`削除済みの利用者 ${deleted}人`);
  return names.join('、');
}

/**
 * メッセージのリアクション（F-18。機能一覧 7）。絵文字ごとに人数を出し、付けた人を `title` とアクセシブルな名前で読めるようにする
 * （**自分が付けたかを色だけで伝えない**——`aria-pressed` で押されている状態として渡す。要件定義書 4.5「在席状態・リアクション」）。
 *
 * - **付け外しの操作は、チャンネルの画面の中で、アーカイブ済みでないときだけ出す**（出し分けは画面の配慮であり、判定は api。CLAUDE.md 2・機能一覧 3.2）
 * - **自分が付けたかは `users` から決める**——`reaction:changed` は部屋の全員に同じ値を送り、閲覧者ごとの値を持たない
 * - 削除済みのメッセージには出さない（api も返さず、付け外しを断る）
 */
export function MessageReactions({ message }: { message: Message }) {
  const scope = useMessageChannel();
  const session = useSession();
  if (message.body === null) return null;
  const me = session.status === 'signedIn' ? session.user.id : null;
  const editable = scope !== null && !scope.readOnly ? scope : null;

  if (!editable) {
    if (message.reactions.length === 0) return null;
    return (
      <ul className="mt-1 flex flex-wrap gap-1 text-sm">
        {message.reactions.map((reaction) => (
          <li
            key={reaction.emoji}
            title={reactorsOf(reaction)}
            className="rounded-full border px-2 py-0.5"
          >
            {`${reaction.emoji} ${reaction.count}`}
          </li>
        ))}
      </ul>
    );
  }
  return <EditableReactions scope={editable} message={message} me={me} />;
}

function EditableReactions({
  scope,
  message,
  me,
}: {
  scope: { workspaceId: string; channelId: string };
  message: Message;
  me: string | null;
}) {
  const [picking, setPicking] = useState(false);
  const toggle = useToggleReaction(scope.workspaceId, scope.channelId);
  const mine = (reaction: Reaction) => reaction.users.some((user) => user.id === me);

  return (
    <div className="mt-1 flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        {message.reactions.map((reaction) => {
          const pressed = mine(reaction);
          const reactors = reactorsOf(reaction);
          return (
            <button
              key={reaction.emoji}
              type="button"
              aria-pressed={pressed}
              aria-label={`${reaction.emoji} ${reaction.count}人（${reactors}）`}
              title={reactors}
              className={`rounded-full border px-2 py-0.5 disabled:opacity-50 ${pressed ? 'border-sky-700 bg-sky-50' : ''}`}
              disabled={toggle.isPending}
              onClick={() =>
                toggle.mutate({ messageId: message.id, emoji: reaction.emoji, add: !pressed })
              }
            >
              {`${reaction.emoji} ${reaction.count}`}
            </button>
          );
        })}
        <button
          type="button"
          aria-expanded={picking}
          className="rounded-full border px-2 py-0.5 text-slate-600"
          onClick={() => setPicking(!picking)}
        >
          リアクションを付ける
        </button>
      </div>
      {picking && (
        <div className="flex flex-wrap gap-1">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`${emoji} を付ける`}
              className="rounded border px-2 py-0.5 disabled:opacity-50"
              disabled={toggle.isPending}
              onClick={() => {
                setPicking(false);
                toggle.mutate({ messageId: message.id, emoji, add: true });
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {toggle.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(toggle.error)}
        </p>
      )}
    </div>
  );
}
