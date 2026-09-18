/**
 * アップロードを受け付ける形式の許可リスト（機能一覧 11.1。**列挙した形式だけを受け付ける**）。
 * **api（発行で申告を断る・確定で中身を検証する）と web（送る前に Content-Type を決める・大きさを確かめる）で同じものを使う**——
 * 2箇所に書くと、web が送る Content-Type を api が断る食い違いが実行時まで露見しない。
 *
 * - `contentType` は、発行の要求で申告し、署名付き URL の PUT に付ける値（申告は信用しない。形式は確定で中身から決める）
 * - `extension` は、配信用のキーと保存名に付け替える拡張子（11.1 の保存名の箇条）
 * - `extensions` は、web がファイル名から形式を選ぶときに当てる拡張子（小文字）
 * - 大きさの上限は種別ごと（`UPLOAD_LIMIT_BYTES`）。1 MB は 1024 × 1024 バイトと数える（実装時に決めた値）
 */
export type UploadKind = 'image' | 'video' | 'document' | 'archive';

export type UploadFormatId =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'mp4'
  | 'webm'
  | 'pdf'
  | 'txt'
  | 'csv'
  | 'md'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'zip';

export interface UploadFormat {
  readonly id: UploadFormatId;
  readonly kind: UploadKind;
  readonly contentType: string;
  readonly extension: string;
  readonly extensions: readonly string[];
}

const MB = 1024 * 1024;

/** 種別ごとの大きさの上限（機能一覧 11.1 の表）。 */
export const UPLOAD_LIMIT_BYTES: Readonly<Record<UploadKind, number>> = {
  image: 10 * MB,
  video: 100 * MB,
  document: 25 * MB,
  archive: 25 * MB,
};

/** **SVG を含めない**（XML であり `<script>` を内包できる。機能一覧 11.1）。 */
export const UPLOAD_FORMATS: readonly UploadFormat[] = [
  {
    id: 'jpeg',
    kind: 'image',
    contentType: 'image/jpeg',
    extension: '.jpg',
    extensions: ['.jpg', '.jpeg'],
  },
  { id: 'png', kind: 'image', contentType: 'image/png', extension: '.png', extensions: ['.png'] },
  { id: 'gif', kind: 'image', contentType: 'image/gif', extension: '.gif', extensions: ['.gif'] },
  {
    id: 'webp',
    kind: 'image',
    contentType: 'image/webp',
    extension: '.webp',
    extensions: ['.webp'],
  },
  { id: 'mp4', kind: 'video', contentType: 'video/mp4', extension: '.mp4', extensions: ['.mp4'] },
  {
    id: 'webm',
    kind: 'video',
    contentType: 'video/webm',
    extension: '.webm',
    extensions: ['.webm'],
  },
  {
    id: 'pdf',
    kind: 'document',
    contentType: 'application/pdf',
    extension: '.pdf',
    extensions: ['.pdf'],
  },
  {
    id: 'txt',
    kind: 'document',
    contentType: 'text/plain',
    extension: '.txt',
    extensions: ['.txt'],
  },
  { id: 'csv', kind: 'document', contentType: 'text/csv', extension: '.csv', extensions: ['.csv'] },
  {
    id: 'md',
    kind: 'document',
    contentType: 'text/markdown',
    extension: '.md',
    extensions: ['.md', '.markdown'],
  },
  {
    id: 'docx',
    kind: 'document',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
    extensions: ['.docx'],
  },
  {
    id: 'xlsx',
    kind: 'document',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
    extensions: ['.xlsx'],
  },
  {
    id: 'pptx',
    kind: 'document',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
    extensions: ['.pptx'],
  },
  {
    id: 'zip',
    kind: 'archive',
    contentType: 'application/zip',
    extension: '.zip',
    extensions: ['.zip'],
  },
];

/** アバター画像として受け付ける形式（画像だけ。機能一覧 1.3 の読み替え）。 */
export const AVATAR_FORMAT_IDS: readonly UploadFormatId[] = UPLOAD_FORMATS.filter(
  (format) => format.kind === 'image',
).map((format) => format.id);

/** 申告された Content-Type に当たる形式（大文字小文字と引数は区別する——署名に焼き込む値そのものであるため）。 */
export function uploadFormatByContentType(contentType: string): UploadFormat | undefined {
  return UPLOAD_FORMATS.find((format) => format.contentType === contentType);
}

export function uploadFormatById(id: UploadFormatId): UploadFormat {
  const found = UPLOAD_FORMATS.find((format) => format.id === id);
  if (!found) throw new Error(`許可リストに無い形式: ${id}`);
  return found;
}

/**
 * web がファイルから申告する形式を選ぶ。**ブラウザの `File.type` が許可リストの Content-Type ならそれを、そうでなければ拡張子で選ぶ**
 * （Windows では zip が `application/x-zip-compressed`、csv が `application/vnd.ms-excel`、md が空になる）。当たらなければ undefined。
 */
export function uploadFormatForFile(file: {
  readonly name: string;
  readonly type: string;
}): UploadFormat | undefined {
  const byType = uploadFormatByContentType(file.type);
  if (byType) return byType;
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const extension = file.name.slice(dot).toLowerCase();
  return UPLOAD_FORMATS.find((format) => format.extensions.includes(extension));
}
