import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AVATAR_FORMAT_IDS,
  UPLOAD_LIMIT_BYTES,
  type paths,
  uploadFormatByContentType,
} from '@workspace-chat/shared';
import { errorBodyForStatus } from '../error-response';
import { PrismaService } from '../prisma.service';
import { storedFileName, withExtension } from '../file-uploads/file-name';
import {
  FILE_TOO_LARGE,
  UNSUPPORTED_FILE_TYPE,
  UPLOAD_IN_PROGRESS,
  rejectionOf,
} from '../file-uploads/upload-errors';
import {
  avatarKeyDirectory,
  avatarQuarantineDirectory,
  avatarUrlPath,
} from '../file-uploads/upload-keys';
import { UploadStorage } from '../file-uploads/upload-storage';
import { type Profile, ProfileService } from './profile.service';

type IssueOperation = paths['/users/me/avatar/uploads']['post'];
export type UploadRequest = IssueOperation['requestBody']['content']['application/json'];
export type UploadTicket = IssueOperation['responses'][201]['content']['application/json'];

/** 保存名の切り詰めの基準に使う、識別子と同じ長さの値（識別子は行を作るまで決まらないが、長さは UUID の 36 文字で決まっている）。 */
const UPLOAD_ID_OF_SAME_LENGTH = '00000000-0000-0000-0000-000000000000';

/**
 * アバター画像のアップロード（F-04。機能一覧 1.3）。11.1 の添付と同じ段（UploadStorage）を通し、次だけを読み替える:
 * 形式は画像だけ、参加者判定は「本人のプロフィールであること」（行の `userId` が本人であること）、キーは `avatars/{uid}/{UUID}/{ファイル名}`。
 *
 * **確定で `avatarUrl` に入れるのは、サーバーが組み立てた配信 URL のパスだけである**（利用者が渡した URL を入れない）。
 */
@Injectable()
export class AvatarUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: UploadStorage,
    private readonly profiles: ProfileService,
  ) {}

  /** 署名付き URL を発行する。申告が画像でなければ 422 unsupported_file_type、10 MB を超えれば 422 file_too_large（行を作らない）。 */
  async issue(userId: string, input: UploadRequest): Promise<UploadTicket> {
    const format = uploadFormatByContentType(input.contentType);
    if (!format || !AVATAR_FORMAT_IDS.includes(format.id)) {
      throw new UnprocessableEntityException(UNSUPPORTED_FILE_TYPE);
    }
    if (input.size > UPLOAD_LIMIT_BYTES[format.kind]) {
      throw new UnprocessableEntityException(FILE_TOO_LARGE);
    }
    const fileName = storedFileName(
      input.fileName,
      avatarQuarantineDirectory(userId, UPLOAD_ID_OF_SAME_LENGTH),
    );
    const upload = await this.prisma.avatarUpload.create({
      data: { userId, fileName, contentType: format.contentType },
      select: { id: true },
    });
    const signed = await this.storage.sign(
      `${avatarQuarantineDirectory(userId, upload.id)}${fileName}`,
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

  /**
   * 確定する。**本人に払い出されていない識別子は 404**（識別子の存在を認めない。確定の権利も使わない）。
   *
   * **確定は識別子ごとに1回だけ行う**——発行の直後の行だけを「確定の途中」へ条件付きで進め、進めた要求だけが S3 を触る。
   * 2回目以降は結果の列から同じ応答を返し（成功ならその時点のプロフィール）、途中なら 409 upload_in_progress。
   * 想定外の失敗も結果として残す（500。隔離用のキーは UploadStorage が削除しているため、やり直すと削除の後の1回の書き込みを確定させうる）。
   */
  async complete(userId: string, uploadId: string): Promise<Profile> {
    const claimed = await this.prisma.avatarUpload.updateMany({
      where: { id: uploadId, userId, state: 'ISSUED' },
      data: { state: 'COMPLETING' },
    });
    const upload = await this.prisma.avatarUpload.findFirst({
      where: { id: uploadId, userId },
    });
    if (!upload) throw new NotFoundException();
    if (claimed.count === 0) {
      if (upload.state === 'SUCCEEDED') return this.profiles.get(userId);
      if (upload.state === 'REJECTED') {
        throw rejectionOf(
          upload.rejectedStatus ?? HttpStatus.INTERNAL_SERVER_ERROR,
          upload.rejectedCode ?? '',
        );
      }
      throw new ConflictException(UPLOAD_IN_PROGRESS);
    }

    const directory = avatarKeyDirectory(userId, upload.id);
    let result: Awaited<ReturnType<UploadStorage['promote']>>;
    try {
      result = await this.storage.promote({
        quarantineKey: `${avatarQuarantineDirectory(userId, upload.id)}${upload.fileName}`,
        declaredContentType: upload.contentType,
        accepts: AVATAR_FORMAT_IDS,
        deliveryKeyFor: (format) =>
          `${directory}${withExtension(upload.fileName, format.extension)}`,
      });
    } catch (error) {
      await this.reject(upload.id, HttpStatus.INTERNAL_SERVER_ERROR, errorBodyForStatus(500).code);
      throw error;
    }
    if (!result.ok) {
      await this.reject(upload.id, HttpStatus.UNPROCESSABLE_ENTITY, result.error.code);
      throw new UnprocessableEntityException(result.error);
    }

    const deliveredFileName = result.deliveryKey.slice(directory.length);
    await this.prisma.$transaction([
      this.prisma.avatarUpload.update({
        where: { id: upload.id },
        data: { state: 'SUCCEEDED', deliveredFileName, completedAt: new Date() },
      }),
      // 退会済みの行は書き換えない（そのときは続く get が 401 を返す。profile.service.ts の update と同じ）
      this.prisma.user.updateMany({
        where: { id: userId, deletedAt: null },
        data: { avatarUrl: avatarUrlPath(result.deliveryKey) },
      }),
    ]);
    return this.profiles.get(userId);
  }

  private async reject(uploadId: string, status: number, code: string): Promise<void> {
    await this.prisma.avatarUpload.update({
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
