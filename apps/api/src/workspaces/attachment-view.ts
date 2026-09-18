import { type UploadFormatId, type components, uploadFormatById } from '@workspace-chat/shared';
import { servedContentType } from '../file-uploads/upload-storage';
import {
  attachmentKeyDirectory,
  attachmentUrlPath,
  dmAttachmentKeyDirectory,
} from '../file-uploads/upload-keys';

export type Attachment = components['schemas']['Attachment'];

/** 応答の添付を作るために引く列（確定に成功した行だけを渡す）。 */
export const ATTACHMENT_SELECT = {
  id: true,
  workspaceId: true,
  channelId: true,
  originalName: true,
  formatId: true,
  deliveredFileName: true,
  size: true,
} as const;

/**
 * 確定に成功した行から、応答の添付を作る。**配信 URL のパスと配信の Content-Type は、行に残した検証の結果から組み立てる**
 * （確定の応答・2回目以降の確定・メッセージの一覧のどれでも同じ値になる）。
 */
export function toAttachment(row: {
  id: string;
  workspaceId: string;
  channelId: string;
  originalName: string;
  formatId: string | null;
  deliveredFileName: string | null;
  size: number | null;
}): Attachment {
  if (row.formatId === null || row.deliveredFileName === null || row.size === null) {
    throw new Error('確定に成功していない添付の行から応答を作ろうとした');
  }
  const format = uploadFormatById(row.formatId as UploadFormatId);
  return {
    id: row.id,
    fileName: row.originalName,
    contentType: servedContentType(format),
    kind: format.kind,
    size: row.size,
    url: attachmentUrlPath(
      `${attachmentKeyDirectory(row.workspaceId, row.channelId, row.id)}${row.deliveredFileName}`,
    ),
  };
}

/** DM の添付（#239）の応答を作るために引く列（確定に成功した行だけを渡す）。 */
export const DM_ATTACHMENT_SELECT = {
  id: true,
  workspaceId: true,
  dmId: true,
  originalName: true,
  formatId: true,
  deliveredFileName: true,
  size: true,
} as const;

/** 確定に成功した DM の添付の行から、応答の添付を作る（チャンネルの `toAttachment` と同じ形。キーの場所だけが DM の下）。 */
export function toDmAttachment(row: {
  id: string;
  workspaceId: string;
  dmId: string;
  originalName: string;
  formatId: string | null;
  deliveredFileName: string | null;
  size: number | null;
}): Attachment {
  if (row.formatId === null || row.deliveredFileName === null || row.size === null) {
    throw new Error('確定に成功していない添付の行から応答を作ろうとした');
  }
  const format = uploadFormatById(row.formatId as UploadFormatId);
  return {
    id: row.id,
    fileName: row.originalName,
    contentType: servedContentType(format),
    kind: format.kind,
    size: row.size,
    url: attachmentUrlPath(
      `${dmAttachmentKeyDirectory(row.workspaceId, row.dmId, row.id)}${row.deliveredFileName}`,
    ),
  };
}
