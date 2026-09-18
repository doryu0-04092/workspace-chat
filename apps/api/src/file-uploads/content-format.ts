import type { UploadFormat, UploadFormatId } from '@workspace-chat/shared';

/**
 * 中身から形式を決める（機能一覧 11.1。**拡張子や申告された Content-Type を信用しない**）。
 * マジックバイトを持つ形式（画像・動画・pdf・zip と、zip を容器とする docx / xlsx / pptx）はマジックバイトで、
 * 持たないテキスト系（txt / csv / md）は UTF-8 として正しく NUL を含まないことで検証する（決定・2026-09-11・依頼側）。
 */

/** 形式を決めるために読む先頭のバイト数（WebM の DocType まで届く長さ）。 */
export const SIGNATURE_BYTES = 64;

const startsWith = (head: Uint8Array, expected: readonly number[], offset = 0): boolean =>
  head.length >= offset + expected.length && expected.every((byte, i) => head[offset + i] === byte);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/**
 * mp4 と読む ISO BMFF の主ブランド（`ftyp` の直後の4バイト）。**`ftyp` だけで mp4 と読まない**——
 * HEIC（`heic`）・QuickTime（`qt  `）・音声の m4a（`M4A `）も同じ箱を持ち、`video/mp4` として配信することになる。
 */
const MP4_BRANDS: ReadonlySet<string> = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
  'mmp4',
]);

/** EBML の先頭の要素の中に、DocType（ID `42 82`・長さ 4）が `webm` であるものがあるか。Matroska（`matroska`）は外す。 */
function isWebm(head: Uint8Array): boolean {
  if (!startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const docType = [0x42, 0x82, 0x84, ...ascii('webm')];
  for (let i = 4; i + docType.length <= head.length; i += 1) {
    if (startsWith(head, docType, i)) return true;
  }
  return false;
}

/** 先頭のバイト列が当たる、マジックバイトを持つ形式。docx / xlsx / pptx は zip と区別できないため `zip` と読む。 */
export function formatBySignature(head: Uint8Array): UploadFormatId | undefined {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'gif';
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(head, ascii('ftyp'), 4) && head.length >= 12) {
    const brand = String.fromCharCode(...head.slice(8, 12));
    return MP4_BRANDS.has(brand) ? 'mp4' : undefined;
  }
  if (isWebm(head)) return 'webm';
  if (startsWith(head, ascii('%PDF-'))) return 'pdf';
  // 書庫の最初のファイルの記録。空の書庫（終端の記録 `50 4B 05 06` だけ）は受け付けない（11.1 が挙げる並びは `50 4B 03 04`）。
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  return undefined;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 として正しく、NUL を含まないか（テキスト系の検証。UTF-16 は NUL を含むため通らない）。 */
export function isUtf8TextWithoutNul(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const ZIP_CONTAINERS: ReadonlySet<UploadFormatId> = new Set(['docx', 'xlsx', 'pptx', 'zip']);
const TEXT_FORMATS: ReadonlySet<UploadFormatId> = new Set(['txt', 'csv', 'md']);

/**
 * 先頭のバイト列と申告から、検証した形式を決める。決まらなければ undefined（検証に通らない）。
 *
 * - マジックバイトを持つものは、**申告によらず中身の形式**にする（`photo.png` と申告した JPEG は jpeg として保存名を付け替える。11.1 の保存名の箇条）
 * - zip の先頭を持つものは、申告が docx / xlsx / pptx / zip ならその形式、そうでなければ zip（中身から区別する手段が無い。11.1「検証の範囲の代償」）
 * - マジックバイトを持たないものは、申告がテキスト系のときだけその形式にし、**全体を UTF-8 として確かめる**（`needsTextCheck`）
 */
export function verifiedFormatOf(
  head: Uint8Array,
  declared: UploadFormat,
): { id: UploadFormatId; needsTextCheck: boolean } | undefined {
  const bySignature = formatBySignature(head);
  if (bySignature === 'zip') {
    return { id: ZIP_CONTAINERS.has(declared.id) ? declared.id : 'zip', needsTextCheck: false };
  }
  if (bySignature !== undefined) return { id: bySignature, needsTextCheck: false };
  if (TEXT_FORMATS.has(declared.id)) return { id: declared.id, needsTextCheck: true };
  return undefined;
}
