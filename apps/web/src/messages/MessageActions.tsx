import { type FormEvent, useId, useState } from 'react';
import { errorMessage } from '../api/client';
import { MentionInput } from './MentionInput';
import { type Message, useDeleteMessage, useEditMessage } from './queries';

type Scope = { workspaceId: string; channelId: string };

/**
 * 自分のメッセージの本文をその場で編集する（F-13。機能一覧 4.2）。
 * 空・空白だけでは保存できない（api も 400 で断る）。断られたら理由を出し、入力を残す。通ったら閉じる。
 * 入力欄はメンションを補完する（投稿と同じ `MentionInput`）。
 */
export function EditMessageForm({
  scope,
  message,
  onDone,
}: {
  scope: Scope;
  message: Message;
  onDone: () => void;
}) {
  const id = useId();
  const edit = useEditMessage(scope.workspaceId, scope.channelId);
  const [body, setBody] = useState(message.body ?? '');

  function submit(event: FormEvent) {
    event.preventDefault();
    edit.mutate({ messageId: message.id, body }, { onSuccess: onDone });
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor={id} className="sr-only">
        メッセージを編集
      </label>
      <MentionInput
        id={id}
        workspaceId={scope.workspaceId}
        channelId={scope.channelId}
        value={body}
        onChange={setBody}
      />
      {edit.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(edit.error)}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-50"
          disabled={edit.isPending || body.trim() === ''}
        >
          保存する
        </button>
        <button type="button" className="rounded border px-3 py-1" onClick={onDone}>
          取り消す
        </button>
      </div>
    </form>
  );
}

/**
 * 自分のメッセージの「編集」「削除」（F-13）。**出し分けは画面の配慮であり、権限の根拠ではない**（判定は api。CLAUDE.md 2）。
 * **削除は送る前に確かめる**——論理削除で本文は画面から消え、利用者には戻す手段が無い。
 */
export function MessageActions({
  scope,
  message,
  onEdit,
}: {
  scope: Scope;
  message: Message;
  onEdit: () => void;
}) {
  const remove = useDeleteMessage(scope.workspaceId, scope.channelId);

  function confirmAndDelete() {
    if (!window.confirm('このメッセージを削除しますか？ 削除すると元に戻せません。')) return;
    remove.mutate(message.id);
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex gap-2 text-sm">
        <button type="button" className="underline" onClick={onEdit}>
          編集する
        </button>
        <button
          type="button"
          className="text-red-700 underline disabled:opacity-50"
          disabled={remove.isPending}
          onClick={confirmAndDelete}
        >
          削除する
        </button>
      </div>
      {remove.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(remove.error)}
        </p>
      )}
    </div>
  );
}
