/**
 * アップロードのキー（機能一覧 1.3・11.1）。**すべてサーバーが、アップロードの行（本人・識別子・保存名）から組み立てる**——
 * 要求の値（キー・パス・URL）からは作らない。
 *
 * **隔離用のキーは `quarantine/` で始まり、配信用の接頭辞（`avatars/`・`workspace/`）の外にある**——
 * 配信 URL を持たず、`/avatars/*`・`/files/workspace/{ws}/channel/{ch}/*` の署名付き Cookie の対象に一致しない（11.1）。
 */
export const QUARANTINE_PREFIX = 'quarantine/';

/** アバターの配信用のキーの `{ファイル名}` の前まで（`avatars/{uid}/{UUID}/`）。`{uid}` は User.id（ログイン ID ではない）。 */
export function avatarKeyDirectory(userId: string, uploadId: string): string {
  return `avatars/${userId}/${uploadId}/`;
}

/** アバターの隔離用のキーの `{ファイル名}` の前まで（`quarantine/avatars/{uid}/{UUID}/`）。保存名の切り詰めの基準にする。 */
export function avatarQuarantineDirectory(userId: string, uploadId: string): string {
  return `${QUARANTINE_PREFIX}${avatarKeyDirectory(userId, uploadId)}`;
}

/** 配信用のキーから配信 URL のパスを作る（`/avatars/*` はパスを剥がさずにバケットへ渡すため、キーと同じ形。要件定義書 4.3）。 */
export function avatarUrlPath(deliveryKey: string): string {
  return `/${deliveryKey}`;
}

/**
 * 添付の配信用のキーの `{ファイル名}` の前まで（`workspace/{ws}/channel/{ch}/{UUID}/`。機能一覧 11.1）。
 * **この構造が配信の認可の一部である**——署名付き Cookie の対象は `/files/workspace/{ws}/channel/{ch}/*`（11.2）。
 */
export function attachmentKeyDirectory(
  workspaceId: string,
  channelId: string,
  uploadId: string,
): string {
  return `workspace/${workspaceId}/channel/${channelId}/${uploadId}/`;
}

/** 添付の隔離用のキーの `{ファイル名}` の前まで（`quarantine/workspace/{ws}/channel/{ch}/{UUID}/`）。 */
export function attachmentQuarantineDirectory(
  workspaceId: string,
  channelId: string,
  uploadId: string,
): string {
  return `${QUARANTINE_PREFIX}${attachmentKeyDirectory(workspaceId, channelId, uploadId)}`;
}

/** 添付の配信 URL のパス（`/files` を前置する。CloudFront の関数が剥がしてバケットへ渡す。要件定義書 4.3）。 */
export function attachmentUrlPath(deliveryKey: string): string {
  return `/files/${deliveryKey}`;
}
