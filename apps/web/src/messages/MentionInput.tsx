import {
  BROADCAST_MENTIONS,
  type BroadcastMention,
  MENTION_BEING_TYPED,
} from '@workspace-chat/shared';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { type UserSummary, useMentionCandidates } from './mention-candidates';

/** 一斉メンション（F-21。機能一覧 9.2）の候補の説明。候補の一覧で、ユーザーID の代わりに記法を出す。 */
const BROADCAST_LABELS: Record<BroadcastMention, string> = {
  here: 'このチャンネルを開いている参加者',
  channel: 'このチャンネルの参加者全員',
};

/**
 * 書きかけに当たる一斉メンションの候補（前方一致。大文字小文字によらない）。参加者の候補と同じ形にして、差し込みを1つにする。
 * `id` は利用者の id と重ならない値にする（一覧の key に使う）。
 */
function broadcastCandidates(prefix: string): UserSummary[] {
  return BROADCAST_MENTIONS.filter((mention) => mention.startsWith(prefix.toLowerCase())).map(
    (mention) => ({
      id: `broadcast:${mention}`,
      userId: mention,
      displayName: BROADCAST_LABELS[mention],
    }),
  );
}

/**
 * メンションの補完つきの入力欄（F-20。機能一覧 9.1）。プレーンな `textarea`（要件定義書の UI の表）を combobox にし、
 * カーソルの直前の書きかけのメンション（`MENTION_BEING_TYPED`）で候補を読んで、入力欄の下に一覧で出す。
 *
 * - 上下で選び（端で止まる）、Enter か Tab で `@ユーザーID ` に置き換える。候補を押しても置き換える
 * - **一覧を開いている間の Enter（改行）と Tab（フォーカスの移動）は差し込みに使い、フォーカスを入力欄の外へ出さない**
 *   （要件定義書のアクセシビリティ「メンション補完でフォーカスを閉じ込め」）。一覧が無いときは妨げない
 * - Escape で閉じ、入力が変わるまで開かない
 * - 候補が0人・読めないときは一覧を出さない
 * - **書きかけに当たる `@here` / `@channel`（F-21）を、参加者の候補の前に出す**（候補の読み込みを待たない）
 */
export function MentionInput({
  id,
  workspaceId,
  channelId,
  value,
  onChange,
}: {
  id: string;
  workspaceId: string;
  channelId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const listboxId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [active, setActive] = useState<{ prefix: string | null; index: number }>({
    prefix: null,
    index: 0,
  });
  // 差し込んだ後に置くカーソルの位置。値を描画し直した後に当てる
  const caretAfterInsert = useRef<number | null>(null);

  const typed = caret === null ? null : MENTION_BEING_TYPED.exec(value.slice(0, caret));
  const prefix = typed !== null && dismissedAt !== value ? (typed[1] ?? '') : null;
  const candidates = useMentionCandidates(workspaceId, channelId, prefix);
  const options =
    prefix === null ? [] : [...broadcastCandidates(prefix), ...(candidates.data ?? [])];
  const open = options.length > 0;
  const selected = active.prefix === prefix ? Math.min(active.index, options.length - 1) : 0;

  useEffect(() => {
    if (caretAfterInsert.current === null || textarea.current === null) return;
    textarea.current.setSelectionRange(caretAfterInsert.current, caretAfterInsert.current);
    caretAfterInsert.current = null;
  });

  function insert(user: UserSummary) {
    if (typed === null || caret === null) return;
    const start = caret - typed[0].length;
    const inserted = `@${user.userId} `;
    caretAfterInsert.current = start + inserted.length;
    setCaret(start + inserted.length);
    onChange(value.slice(0, start) + inserted + value.slice(caret));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive({ prefix, index: Math.max(0, Math.min(options.length - 1, selected + step)) });
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const user = options[selected];
      if (user) insert(user);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDismissedAt(value);
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={textarea}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-${selected}` : undefined}
        className="w-full rounded border px-2 py-1"
        rows={3}
        value={value}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          onChange(event.target.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="メンションの候補"
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border bg-white shadow"
        >
          {options.map((user, index) => (
            <li
              key={user.id}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === selected}
              className={`cursor-pointer px-2 py-1 ${index === selected ? 'bg-sky-100' : ''}`}
              // 押しても入力欄からフォーカスを外さない
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(user)}
            >
              <span className="font-bold">{user.displayName}</span>{' '}
              <span className="text-slate-500">@{user.userId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
