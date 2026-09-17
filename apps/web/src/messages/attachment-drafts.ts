import type { components } from '@workspace-chat/shared';
import { useState } from 'react';
import { segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';
import { uploadFile } from '../file-uploads/upload-file';

export type Attachment = components['schemas']['Attachment'];

/** 1回の投稿に付けられる添付の上限（api の CreateMessageRequest の attachmentIds の maxItems と同じ）。 */
export const ATTACHMENT_LIMIT = 10;

/** 投稿の前に上げている・上げた添付1つ。 */
export type AttachmentDraft = {
  readonly key: number;
  readonly fileName: string;
} & (
  | { readonly status: 'uploading' }
  | { readonly status: 'ready'; readonly attachment: Attachment }
  | { readonly status: 'failed'; readonly error: unknown }
);

let nextKey = 0;

/**
 * 投稿に付ける添付の下書き（F-27。機能一覧 11.1）。ファイルを選んだらすぐに上げ（発行 → PUT → 確定）、確定したものの識別子を投稿に渡す。
 *
 * - **下書きはチャンネルごとに持つ**——別のチャンネルへ移ったら出さない（添付はそのチャンネルでしか付けられず、api が 422 で断る）
 * - 上げている間（`uploading`）は、呼ぶ側が送信を止める（確定していない添付を付けて送らない）
 * - 上げられなかったものは理由を出し、投稿には含めない。取り除ける
 */
export function useAttachmentDrafts(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const [state, setState] = useState<{ channelId: string; drafts: AttachmentDraft[] }>({
    channelId,
    drafts: [],
  });
  const drafts = state.channelId === channelId ? state.drafts : [];

  function update(key: number, next: AttachmentDraft) {
    setState((current) =>
      current.channelId === channelId
        ? { ...current, drafts: current.drafts.map((d) => (d.key === key ? next : d)) }
        : current,
    );
  }

  function add(files: readonly File[]) {
    const room = Math.max(0, ATTACHMENT_LIMIT - drafts.length);
    const started = files.slice(0, room).map((file) => {
      nextKey += 1;
      return { file, draft: { key: nextKey, fileName: file.name, status: 'uploading' } as const };
    });
    if (started.length === 0) return;
    setState({ channelId, drafts: [...drafts, ...started.map(({ draft }) => draft)] });
    const path = `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/attachments/uploads`;
    for (const { file, draft } of started) {
      uploadFile<Attachment>(store, file, {
        issuePath: path,
        completePath: (uploadId) => `${path}/${segment(uploadId)}/complete`,
        kinds: ['image', 'video', 'document', 'archive'],
      }).then(
        (attachment) => update(draft.key, { ...draft, status: 'ready', attachment }),
        (error: unknown) => update(draft.key, { ...draft, status: 'failed', error }),
      );
    }
  }

  function remove(key: number) {
    setState({ channelId, drafts: drafts.filter((draft) => draft.key !== key) });
  }

  function clear() {
    setState({ channelId, drafts: [] });
  }

  return {
    drafts,
    add,
    remove,
    clear,
    uploading: drafts.some((draft) => draft.status === 'uploading'),
    full: drafts.length >= ATTACHMENT_LIMIT,
    readyIds: drafts.flatMap((draft) => (draft.status === 'ready' ? [draft.attachment.id] : [])),
  };
}
