import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { type ErrorResponse, errorBodyForStatus } from '../error-response';
import { NOT_A_CHANNEL_MEMBER } from '../workspaces/channel-errors';

/**
 * 受け付けない形式（422。機能一覧 11.1 の許可リスト）。発行では申告した Content-Type が許可リストに無いとき、
 * 確定では中身が許可する形式に当たらないとき（SVG・申告と違う種別・アバターに画像でないもの）に返す。
 */
export const UNSUPPORTED_FILE_TYPE: ErrorResponse = {
  code: 'unsupported_file_type',
  message: 'この形式のファイルは受け付けません',
};

/** 種別ごとの上限を超える（422。発行では申告の大きさ、確定では PUT された本体の大きさ）。 */
export const FILE_TOO_LARGE: ErrorResponse = {
  code: 'file_too_large',
  message: 'ファイルが大きすぎます',
};

/** 確定を求めたが、隔離用のキーに本体が無い（422。PUT していない・期限切れで書けなかった）。 */
export const UPLOAD_NOT_RECEIVED: ErrorResponse = {
  code: 'upload_not_received',
  message: 'ファイルが届いていません。アップロードからやり直してください',
};

/** 同じ識別子の確定が進行中（409）。**確定は識別子ごとに1回だけ行う**ため、並んだ2つ目は待たずに断る。 */
export const UPLOAD_IN_PROGRESS: ErrorResponse = {
  code: 'upload_in_progress',
  message: 'このアップロードは確定の途中です',
};

/**
 * 確定で断った結果を、行に残した状態コードと `code` から作り直す（2回目以降の確定に1回目と同じ結果を返す。機能一覧 11.1）。
 * 404 は本体を持たない例外にする（ErrorResponseFilter が状態コードの本体にする。存在を認めない。1.4）。
 */
export function rejectionOf(status: number, code: string): HttpException {
  if (status === HttpStatus.NOT_FOUND) return new NotFoundException();
  const known = [UNSUPPORTED_FILE_TYPE, FILE_TOO_LARGE, UPLOAD_NOT_RECEIVED, NOT_A_CHANNEL_MEMBER];
  const body = known.find((candidate) => candidate.code === code);
  return new HttpException(body ?? errorBodyForStatus(status), status);
}

/**
 * 投稿に付けられない添付がある（422。機能一覧 11.1）。自分が上げ、そのチャンネルで確定に成功し、まだどの投稿にも付いていないものだけを付けられる。
 * **どれに当たらなかったか・なぜかを区別しない**（他の利用者の添付の有無を漏らさない）。
 */
export const ATTACHMENT_UNAVAILABLE: ErrorResponse = {
  code: 'attachment_unavailable',
  message: '付けられない添付があります。アップロードからやり直してください',
};
