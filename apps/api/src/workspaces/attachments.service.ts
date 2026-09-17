import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  UPLOAD_FORMATS,
  UPLOAD_LIMIT_BYTES,
  type paths,
  uploadFormatByContentType,
} from '@workspace-chat/shared';
import { errorBodyForStatus, errorResponseOf } from '../error-response';
import { storedFileName, withExtension } from '../file-uploads/file-name';
import {
  FILE_TOO_LARGE,
  UNSUPPORTED_FILE_TYPE,
  UPLOAD_IN_PROGRESS,
  rejectionOf,
} from '../file-uploads/upload-errors';
import { attachmentKeyDirectory, attachmentQuarantineDirectory } from '../file-uploads/upload-keys';
import { UploadStorage } from '../file-uploads/upload-storage';
import { PrismaService } from '../prisma.service';
import { type Attachment, ATTACHMENT_SELECT, toAttachment } from './attachment-view';
import { assertChannelParticipant, channelFor } from './channel-access';
import { WorkspacesService } from './workspaces.service';

type IssueOperation = paths['/workspaces/{id}/channels/{channelId}/attachments/uploads']['post'];
export type UploadRequest = IssueOperation['requestBody']['content']['application/json'];
export type UploadTicket = IssueOperation['responses'][201]['content']['application/json'];

/** 保存名の切り詰めの基準に使う、識別子と同じ長さの値（識別子は行を作るまで決まらないが、長さは UUID の 36 文字で決まっている）。 */
const UPLOAD_ID_OF_SAME_LENGTH = '00000000-0000-0000-0000-000000000000';

const ALL_FORMAT_IDS = UPLOAD_FORMATS.map((format) => format.id);

/**
 * チャンネルの添付ファイルのアップロード（F-27・F-28。機能一覧 11.1）。
 *
 * - **発行と確定の参加者判定は、メッセージと同じ2段階**（所属していなければ 404〔`membershipOf`〕、所属していればパブリック 403・プライベート 404。
 *   **オーナーの例外は及ばない**）
 * - **キーはすべて、判定を通したチャンネルと、サーバーが発行した識別子と、許可リストで置き換えた保存名から組み立てる**（要求の値でキーを作らない）
 * - **確定を求められるのは、識別子を払い出された本人が、発行した経路（ワークスペースとチャンネル）で求めたときだけ**（そうでなければ 404。権利を使わない）。
 *   隔離用のキー・コピー先・やり直す参加者判定の対象チャンネルは、行に保持した値から作る
 * - **確定の時点で参加者判定をやり直す**。落ちたら検証に通らなかったのと同じ扱い（権利を使い切り、隔離用のキーを削除する。決定・2026-09-11・依頼側）
 * - 確定は識別子ごとに1回だけ（アバターの avatar-upload.service.ts と同じ形）
 * - **アーカイブ済みのチャンネルでも発行と確定を断らない**（書き込みの判定は投稿の側にあり、アーカイブ済みのチャンネルには投稿できない。3.2）
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly storage: UploadStorage,
  ) {}

  private async assertParticipant(
    userId: string,
    workspaceId: string,
    channelId: string,
  ): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channelId));
  }

  async issue(
    userId: string,
    workspaceId: string,
    channelId: string,
    input: UploadRequest,
  ): Promise<UploadTicket> {
    await this.assertParticipant(userId, workspaceId, channelId);
    const format = uploadFormatByContentType(input.contentType);
    if (!format) throw new UnprocessableEntityException(UNSUPPORTED_FILE_TYPE);
    if (input.size > UPLOAD_LIMIT_BYTES[format.kind]) {
      throw new UnprocessableEntityException(FILE_TOO_LARGE);
    }
    const fileName = storedFileName(
      input.fileName,
      attachmentQuarantineDirectory(workspaceId, channelId, UPLOAD_ID_OF_SAME_LENGTH),
    );
    const upload = await this.prisma.attachment.create({
      data: {
        workspaceId,
        channelId,
        uploaderId: userId,
        originalName: input.fileName,
        fileName,
        contentType: format.contentType,
      },
      select: { id: true },
    });
    const signed = await this.storage.sign(
      `${attachmentQuarantineDirectory(workspaceId, channelId, upload.id)}${fileName}`,
      format.contentType,
    );
    return {
      uploadId: upload.id,
      uploadUrl: signed.url,
      uploadHeaders: signed.headers,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  async complete(
    userId: string,
    workspaceId: string,
    channelId: string,
    uploadId: string,
  ): Promise<Attachment> {
    const owned = { id: uploadId, uploaderId: userId, workspaceId, channelId };
    const claimed = await this.prisma.attachment.updateMany({
      where: { ...owned, state: 'ISSUED' },
      data: { state: 'COMPLETING' },
    });
    const upload = await this.prisma.attachment.findFirst({
      where: owned,
      select: {
        ...ATTACHMENT_SELECT,
        fileName: true,
        contentType: true,
        state: true,
        rejectedStatus: true,
        rejectedCode: true,
      },
    });
    if (!upload) throw new NotFoundException();
    if (claimed.count === 0) {
      if (upload.state === 'SUCCEEDED') return toAttachment(upload);
      if (upload.state === 'REJECTED') {
        throw rejectionOf(
          upload.rejectedStatus ?? HttpStatus.INTERNAL_SERVER_ERROR,
          upload.rejectedCode ?? '',
        );
      }
      throw new ConflictException(UPLOAD_IN_PROGRESS);
    }

    // キーと対象チャンネルは行から作る（`owned` で経路と一致させているが、要求の値からは組み立てない）
    const quarantineKey = `${attachmentQuarantineDirectory(upload.workspaceId, upload.channelId, upload.id)}${upload.fileName}`;
    const directory = attachmentKeyDirectory(upload.workspaceId, upload.channelId, upload.id);
    let result: Awaited<ReturnType<UploadStorage['promote']>>;
    try {
      try {
        await this.assertParticipant(userId, upload.workspaceId, upload.channelId);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        // 参加者判定のやり直しに落ちたら、検証に通らなかったのと同じ扱い（権利を使い切り、隔離用のキーを削除する）
        await this.storage.discard(quarantineKey);
        const { status, body } = errorResponseOf(error);
        await this.reject(upload.id, status, body.code);
        throw error;
      }
      result = await this.storage.promote({
        quarantineKey,
        declaredContentType: upload.contentType,
        accepts: ALL_FORMAT_IDS,
        deliveryKeyFor: (format) =>
          `${directory}${withExtension(upload.fileName, format.extension)}`,
      });
    } catch (error) {
      if (!(error instanceof HttpException)) {
        await this.reject(
          upload.id,
          HttpStatus.INTERNAL_SERVER_ERROR,
          errorBodyForStatus(500).code,
        );
      }
      throw error;
    }
    if (!result.ok) {
      await this.reject(upload.id, HttpStatus.UNPROCESSABLE_ENTITY, result.error.code);
      throw new UnprocessableEntityException(result.error);
    }

    const succeeded = await this.prisma.attachment.update({
      where: { id: upload.id },
      data: {
        state: 'SUCCEEDED',
        formatId: result.format.id,
        deliveredFileName: result.deliveryKey.slice(directory.length),
        size: result.size,
        completedAt: new Date(),
      },
      select: ATTACHMENT_SELECT,
    });
    return toAttachment(succeeded);
  }

  private async reject(uploadId: string, status: number, code: string): Promise<void> {
    await this.prisma.attachment.update({
      where: { id: uploadId },
      data: {
        state: 'REJECTED',
        rejectedStatus: status,
        rejectedCode: code,
        completedAt: new Date(),
      },
    });
  }
}
