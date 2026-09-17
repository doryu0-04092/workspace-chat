import {
  type components,
  UPLOAD_LIMIT_BYTES,
  type UploadKind,
  uploadFormatForFile,
} from '@workspace-chat/shared';
import { ApiError, requestJson } from '../api/client';
import type { SessionStore } from '../auth/session-store';

export type UploadTicket = components['schemas']['UploadTicket'];

/**
 * ファイルを上げる（機能一覧 11.1。アバター〔1.3〕も同じ段）: 発行 → 署名付き URL への PUT → 確定。確定の応答を返す。
 *
 * - **申告する Content-Type は許可リストから選ぶ**（`uploadFormatForFile`。ブラウザの `File.type` が許可リストに無ければ拡張子で選ぶ）。
 *   PUT には発行の応答のヘッダーをそのまま付ける（Content-Type と If-None-Match は署名に含まれ、変えると S3 が断る）
 * - 形式が許可リスト（`kinds` の種別）に無い・種別の上限を超えるものは、**送らずに** api と同じ `code` の失敗にする
 *   （画面の文を api の断りと揃えるため。判定の根拠は api の確定の検証であり、ここは送る前の配慮である）
 * - PUT は api ではなく S3 へ送るため、アクセストークンを付けない
 */
export async function uploadFile<T>(
  store: SessionStore,
  file: File,
  options: {
    readonly issuePath: string;
    readonly completePath: (uploadId: string) => string;
    readonly kinds: readonly UploadKind[];
  },
): Promise<T> {
  const format = uploadFormatForFile(file);
  if (!format || !options.kinds.includes(format.kind)) {
    throw new ApiError({ ok: false, status: 422, code: 'unsupported_file_type' });
  }
  if (file.size > UPLOAD_LIMIT_BYTES[format.kind]) {
    throw new ApiError({ ok: false, status: 422, code: 'file_too_large' });
  }
  const ticket = await requestJson<UploadTicket>(store, options.issuePath, {
    method: 'POST',
    body: { fileName: file.name, contentType: format.contentType, size: file.size },
  });
  let put: Response;
  try {
    put = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: ticket.uploadHeaders,
      body: file,
    });
  } catch {
    throw new ApiError({ ok: false, status: 0 });
  }
  if (!put.ok) throw new ApiError({ ok: false, status: put.status });
  return requestJson<T>(store, options.completePath(ticket.uploadId), { method: 'POST' });
}
