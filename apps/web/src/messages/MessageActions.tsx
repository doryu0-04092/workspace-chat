import { errorMessage } from '../api/client';
import { MessageForm } from './PostMessageForm';
import { type Message, useDeleteMessage, useEditMessage } from './queries';

type Scope = { workspaceId: string; channelId: string };

/**
 * 自分のメッセージの本文をその場で編集する（F-13。機能一覧 4.2）。
 * **本文を送るフォームの不変条件は `MessageForm` が持つ**（空・空白だけでは保存できない・断られたら理由を出して入力を残す・Enter では送らない）。
 * ここで足すのは、元の本文から始めること・通ったら閉じること・取り消せることだけである。
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
  const edit = useEditMessage(scope.workspaceId, scope.channelId);
  return (
    <MessageForm
      submit={(body, options) => edit.mutate({ messageId: message.id, body }, options)}
      pending={edit.isPending}
      error={edit.error}
      workspaceId={scope.workspaceId}
      channelId={scope.channelId}
      label="メッセージを編集"
      hideLabel
      submitLabel="保存する"
      initialBody={message.body ?? ''}
      clearOnSuccess={false}
      onSubmitted={onDone}
      onCancel={onDone}
      className="flex flex-col gap-2"
    />
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
