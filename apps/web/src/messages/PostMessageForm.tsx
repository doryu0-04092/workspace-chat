import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { errorMessage } from '../api/client';
import { useTypingNotifier } from '../realtime/use-typing';
import { type AttachmentDraft, useAttachmentDrafts } from './attachment-drafts';
import { MentionInput } from './MentionInput';
import { usePostMessage } from './queries';

/**
 * チャンネルへの投稿（F-11）。入力中の知らせ（F-34）を送る。添付ファイル（F-27）を付けられる——選んだらすぐに上げ、確定したものの識別子を本文と一緒に送る。
 * **上げている間は送信できない**（確定していない添付を付けて送らない）。上げられなかったものは送信に含めない。
 */
export function PostMessageForm({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}) {
  const post = usePostMessage(workspaceId, channelId);
  const attachments = useAttachmentDrafts(workspaceId, channelId);
  const notifyTyping = useTypingNotifier(channelId);
  return (
    <MessageForm
      onBodyChange={notifyTyping}
      submit={(body, options) =>
        post.mutate(
          { body, attachmentIds: attachments.readyIds },
          {
            onSuccess: () => {
              attachments.clear();
              options.onSuccess();
            },
          },
        )
      }
      pending={post.isPending || attachments.uploading}
      error={post.error}
      workspaceId={workspaceId}
      channelId={channelId}
      label="メッセージ"
      submitLabel="送信する"
      extra={
        <AttachmentField
          drafts={attachments.drafts}
          full={attachments.full}
          onChoose={attachments.add}
          onRemove={attachments.remove}
        />
      }
    />
  );
}

/** 添付するファイルを選ぶ欄と、上げている・上げたファイルの一覧。 */
function AttachmentField({
  drafts,
  full,
  onChoose,
  onRemove,
}: {
  drafts: readonly AttachmentDraft[];
  full: boolean;
  onChoose: (files: File[]) => void;
  onRemove: (key: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={id}>ファイルを添付</label>
        <input
          id={id}
          type="file"
          multiple
          disabled={full}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // 同じファイルを選び直しても change が起きるよう、選んだものを入力欄から外す
            event.target.value = '';
            onChoose(files);
          }}
        />
      </div>
      {drafts.length > 0 && (
        <ul aria-label="添付するファイル" className="flex flex-col gap-1 text-sm">
          {drafts.map((draft) => (
            <li key={draft.key} className="flex flex-wrap items-baseline gap-2">
              <span>{draft.fileName}</span>
              {draft.status === 'uploading' && (
                <span className="text-slate-500">アップロード中…</span>
              )}
              {draft.status === 'failed' && (
                <span role="alert" className="text-red-700">
                  上げられませんでした。{errorMessage(draft.error)}
                </span>
              )}
              <button
                type="button"
                className="text-slate-600 underline"
                aria-label={`${draft.fileName} を取り除く`}
                onClick={() => onRemove(draft.key)}
              >
                取り除く
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 本文を送るフォーム（投稿 F-11・スレッドの返信 F-17・編集 F-13）。**本文を送るフォームの不変条件はここにだけ置く**——
 * 投稿と編集で別々に持つと、変えるときに片方だけが変わる（#536 第0巡の設計の提案②）。
 *
 * - **Enter では送信しない**——送信は送信のボタンで行い、Enter は、補完の一覧を開いている間は候補の差し込み、
 *   それ以外は改行である（改行は本文の改行として描画する。機能一覧 4.3・9.1）
 * - **空・空白だけではボタンを押せない**（api も 400 で断る。機能一覧 4.1）
 * - **失敗したら理由を出し、入力を残す**
 * - 入力欄はメンションを補完する（F-20。`MentionInput`。候補はそのチャンネルの参加者）。**`channelId` を渡さなければ補完しない**
 *   （DM。F-19。DM のメンションは解決しないため、補完の候補も出さない）
 *
 * 通ったら、既定では入力を空にする（投稿・返信）。`onSubmitted` を渡すと通った後に呼ぶ（編集は欄を閉じる）。
 * `onCancel` を渡すと「取り消す」を出す。`onBodyChange` を渡すと、本文が変わるたび（通って空にしたときを含む）にいまの本文を渡す。
 */
export function MessageForm({
  submit,
  pending,
  error,
  workspaceId,
  channelId,
  label,
  submitLabel,
  initialBody = '',
  hideLabel = false,
  clearOnSuccess = true,
  onSubmitted,
  onCancel,
  extra,
  onBodyChange,
  className = 'mt-4 flex flex-col gap-2',
}: {
  submit: (body: string, options: { onSuccess: () => void }) => void;
  pending: boolean;
  error: Error | null;
  workspaceId: string;
  channelId?: string;
  label: string;
  submitLabel: string;
  initialBody?: string;
  hideLabel?: boolean;
  clearOnSuccess?: boolean;
  onSubmitted?: () => void;
  onCancel?: () => void;
  /** 入力欄の下に置く欄（投稿の添付） */
  extra?: ReactNode;
  onBodyChange?: (body: string) => void;
  className?: string;
}) {
  // 投稿・スレッドの返信・編集のフォームが同じ画面に並ぶため、入力欄の id を固定しない
  const id = useId();
  const [body, setBodyState] = useState(initialBody);
  const setBody = (value: string) => {
    setBodyState(value);
    onBodyChange?.(value);
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit(body, {
      onSuccess: () => {
        if (clearOnSuccess) setBody('');
        onSubmitted?.();
      },
    });
  }

  return (
    <form className={className} onSubmit={onSubmit}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </label>
      {channelId === undefined ? (
        <textarea
          id={id}
          className="w-full rounded border px-2 py-1"
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      ) : (
        <MentionInput
          id={id}
          workspaceId={workspaceId}
          channelId={channelId}
          value={body}
          onChange={setBody}
        />
      )}
      {extra}
      {error !== null && (
        <p role="alert" className="text-red-700">
          {errorMessage(error)}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
          disabled={pending || body.trim() === ''}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="rounded border px-3 py-2" onClick={onCancel}>
            取り消す
          </button>
        )}
      </div>
    </form>
  );
}
