/** S3 のオブジェクトキーの上限（UTF-8 のバイト数。S3 公式「Object key naming guidelines」）。 */
export const S3_KEY_MAX_BYTES = 1024;

/**
 * キーの `{ファイル名}` に使う保存名（機能一覧 11.1 のキーの形式の行。決定・2026-09-10・依頼側）。
 * 英数字・`.`・`_`・`-` だけを残し、それ以外の文字（コードポイント単位）と先頭の `.` を `_` に置き換え、
 * **`keyPrefix`（発行の段で書く隔離用のキーの、`{ファイル名}` の前まで。`quarantine/` を含む）と合わせて 1,024 バイトに収まるよう末尾を切り詰める。**
 * 置き換えた後は ASCII だけなので、文字数とバイト数が一致する。
 *
 * 配信用のキーは `quarantine/` の 11 バイトだけ短く、確定の段の拡張子の付け替え（`withExtension`）で伸びるのは許可する形式の拡張子の最長（5 バイト）までであるため、
 * 配信用のキーも収まる。
 */
export function storedFileName(original: string, keyPrefix: string): string {
  const replaced = original.replace(/[^A-Za-z0-9._-]/gu, '_').replace(/^\./, '_');
  return replaced.slice(0, Math.max(0, S3_KEY_MAX_BYTES - Buffer.byteLength(keyPrefix, 'utf8')));
}

/**
 * 保存名の拡張子を、検証した形式のもの（`.jpg` など）に付け替える（11.1 の保存名の箇条）。最後の `.` から後ろを拡張子とみなし、
 * 無ければ付け足す。**二重拡張子（`.jpg.php`）は最後の1つだけを付け替える**——残った `.jpg` は保存名の途中にあり、開くときの拡張子にならない。
 */
export function withExtension(storedName: string, extension: string): string {
  const dot = storedName.lastIndexOf('.');
  return `${dot > 0 ? storedName.slice(0, dot) : storedName}${extension}`;
}
