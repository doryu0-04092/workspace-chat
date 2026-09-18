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
import {
  dmAttachmentKeyDirectory,
  dmAttachmentQuarantineDirectory,
} from '../file-uploads/upload-keys';
import { UploadStorage } from '../file-uploads/upload-storage';
import { PrismaService } from '../prisma.service';
import { type Attachment, DM_ATTACHMENT_SELECT, toDmAttachment } from './attachment-view';
import type { UploadRequest, UploadTicket } from './attachments.service';
import { partiesFor } from './dms.service';
import { WorkspacesService } from './workspaces.service';

/** 保存名の切り詰めの基準に使う、識別子と同じ長さの値（attachments.service.ts と同じ）。 */
const UPLOAD_ID_OF_SAME_LENGTH = '00000000-0000-0000-0000-000000000000';

const ALL_FORMAT_IDS = UPLOAD_FORMATS.map((format) => format.id);

/**
 * DM の添付ファイルのアップロード（F-27・F-28・F-19。#239。決定・2026-09-11・依頼側）。
 *
 * - **発行と確定を求められるのは、そのワークスペースに所属する DM の当事者だけ**（所属していない・当事者でない・DM が無いは区別せず 404。DM の他の経路と同じ）
 * - **チャンネルの添付（attachments.service.ts）と経路を分ける**——チャンネルの参加者判定と DM の当事者判定を1つの経路に混ぜない（#239）。
 *   状態の遷移（発行 → 確定は1回だけ → 成功・断りを保持）・検証・保存名の扱いは、チャンネルの添付と同じ
 * - キーはすべて、判定を通した DM と、サーバーが発行した識別子と、許可リストで置き換えた保存名から組み立てる（要求の値でキーを作らない）
 * - **確定の時点で当事者の判定をやり直す**。落ちたら検証に通らなかったのと同じ扱い（権利を使い切り、隔離用のキーを削除する）
 */
@Injectable()
export class DmAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly storage: UploadStorage,
  ) {}

  private async assertParty(userId: string, workspaceId: string, dmId: string): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    await partiesFor(this.prisma, userId, workspaceId, dmId);
  }

  async issue(
    userId: string,
    workspaceId: string,
    dmId: string,
    input: UploadRequest,
  ): Promise<UploadTicket> {
    await this.assertParty(userId, workspaceId, dmId);
    const format = uploadFormatByContentType(input.contentType);
    if (!format) throw new UnprocessableEntityException(UNSUPPORTED_FILE_TYPE);
    if (input.size > UPLOAD_LIMIT_BYTES[format.kind]) {
      throw new UnprocessableEntityException(FILE_TOO_LARGE);
    }
    const fileName = storedFileName(
      input.fileName,
      dmAttachmentQuarantineDirectory(workspaceId, dmId, UPLOAD_ID_OF_SAME_LENGTH),
    );
    const upload = await this.prisma.dmAttachment.create({
      data: {
        workspaceId,
        dmId,
        uploaderId: userId,
        originalName: input.fileName,
        fileName,
        contentType: format.contentType,
      },
      select: { id: true },
    });
    const signed = await this.storage.sign(
      `${dmAttachmentQuarantineDirectory(workspaceId, dmId, upload.id)}${fileName}`,
      format.contentType,
      input.size,
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
    dmId: string,
    uploadId: string,
  ): Promise<Attachment> {
    const owned = { id: uploadId, uploaderId: userId, workspaceId, dmId };
    const claimed = await this.prisma.dmAttachment.updateMany({
      where: { ...owned, state: 'ISSUED' },
      data: { state: 'COMPLETING' },
    });
    const upload = await this.prisma.dmAttachment.findFirst({
      where: owned,
      select: {
        ...DM_ATTACHMENT_SELECT,
        fileName: true,
        contentType: true,
        state: true,
        rejectedStatus: true,
        rejectedCode: true,
      },
    });
    if (!upload) throw new NotFoundException();
    if (claimed.count === 0) {
      if (upload.state === 'SUCCEEDED') return toDmAttachment(upload);
      if (upload.state === 'REJECTED') {
        throw rejectionOf(
          upload.rejectedStatus ?? HttpStatus.INTERNAL_SERVER_ERROR,
          upload.rejectedCode ?? '',
        );
      }
      throw new ConflictException(UPLOAD_IN_PROGRESS);
    }

    // キーと判定をやり直す DM は行から作る（`owned` で経路と一致させているが、要求の値からは組み立てない）
    const quarantineKey = `${dmAttachmentQuarantineDirectory(upload.workspaceId, upload.dmId, upload.id)}${upload.fileName}`;
    const directory = dmAttachmentKeyDirectory(upload.workspaceId, upload.dmId, upload.id);
    let result: Awaited<ReturnType<UploadStorage['promote']>>;
    try {
      try {
        await this.assertParty(userId, upload.workspaceId, upload.dmId);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
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

    const succeeded = await this.prisma.dmAttachment.update({
      where: { id: upload.id },
      data: {
        state: 'SUCCEEDED',
        formatId: result.format.id,
        deliveredFileName: result.deliveryKey.slice(directory.length),
        size: result.size,
        completedAt: new Date(),
      },
      select: DM_ATTACHMENT_SELECT,
    });
    return toDmAttachment(succeeded);
  }

  private async reject(uploadId: string, status: number, code: string): Promise<void> {
    await this.prisma.dmAttachment.update({
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
