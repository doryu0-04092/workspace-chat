import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import {
  UPLOAD_LIMIT_BYTES,
  type UploadFormat,
  type UploadFormatId,
  uploadFormatByContentType,
  uploadFormatById,
} from '@workspace-chat/shared';
import { API_CONFIG, type ApiConfig } from '../config/api-config';
import type { ErrorResponse } from '../error-response';
import { S3_CLIENT } from '../storage/storage.module';
import { SIGNATURE_BYTES, isUtf8TextWithoutNul, verifiedFormatOf } from './content-format';
import { FILE_TOO_LARGE, UNSUPPORTED_FILE_TYPE, UPLOAD_NOT_RECEIVED } from './upload-errors';
import { UPLOAD_URL_TTL_SECONDS } from './upload-signer';

/** アップロード用の署名付き URL に署名する S3 のクライアント（upload-signer.ts の createUploadSigningClient）を注入するトークン。 */
export const UPLOAD_SIGNING_CLIENT = Symbol('UPLOAD_SIGNING_CLIENT');

/** 発行した署名付き URL と、PUT に付けるヘッダー（どちらも署名に含まれる）。 */
export type SignedUpload = {
  readonly url: string;
  readonly headers: { readonly 'Content-Type': string; readonly 'If-None-Match': '*' };
  readonly expiresAt: Date;
};

export type PromoteResult =
  | {
      readonly ok: true;
      readonly format: UploadFormat;
      readonly deliveryKey: string;
      /** 検証した版の大きさ（バイト）。 */
      readonly size: number;
    }
  | { readonly ok: false; readonly error: ErrorResponse };

const TEXT_FORMATS: ReadonlySet<UploadFormatId> = new Set(['txt', 'csv', 'md']);

/** 配信する `Content-Type`。**検証した形式からサーバーが決め、テキスト系は `text/plain; charset=utf-8` に固定する**（11.1。決定・2026-09-11・依頼側）。 */
export function servedContentType(format: UploadFormat): string {
  return TEXT_FORMATS.has(format.id) ? 'text/plain; charset=utf-8' : format.contentType;
}

/**
 * 配信する `Content-Disposition`。**画像・動画は `inline`、それ以外は `attachment`**（11.1。決定・2026-09-11・依頼側）。
 * `filename` と `filename*` の両方に、拡張子を付け替えた保存名を入れる（保存名は ASCII の英数字・`.`・`_`・`-` だけで、引用符を含まない）。
 */
function servedContentDisposition(format: UploadFormat, storedName: string): string {
  const disposition = format.kind === 'image' || format.kind === 'video' ? 'inline' : 'attachment';
  return `${disposition}; filename="${storedName}"; filename*=UTF-8''${encodeURIComponent(storedName)}`;
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

/**
 * アップロードの S3 の段（機能一覧 11.1。アバター〔1.3〕も同じ段を通る）。**キーは呼ぶ側がアップロードの行から組み立てて渡す。**
 *
 * - 発行（`sign`）: 隔離用のキーへの PUT の署名付き URL。**署名は専用のクライアント（`UPLOAD_SIGNING_CLIENT`）で行う**
 * - 確定（`promote`）: 検証 → 検証した版に固定して配信用のキーへコピー → 隔離用のキーの削除。**確定の主体は `S3_CLIENT`（既定の資格情報）**
 */
@Injectable()
export class UploadStorage {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(UPLOAD_SIGNING_CLIENT) private readonly signer: S3Client,
    @Inject(API_CONFIG) private readonly config: Pick<ApiConfig, 's3Bucket'>,
  ) {}

  /**
   * 隔離用のキーへの PUT の署名付き URL（有効期限 5 分）。**`Content-Type` と `If-None-Match: *` を署名に含める**——
   * 前者は申告の固定（4.3 のアップロードの行）、後者は同じ発行のキーへの上書きの拒否（S3 の条件付き書き込み。11.1）。
   */
  async sign(quarantineKey: string, contentType: string): Promise<SignedUpload> {
    const signingDate = new Date();
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: quarantineKey,
        ContentType: contentType,
        IfNoneMatch: '*',
      }),
      {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        signingDate,
        // 既定では署名に入らないヘッダーを明示して署名に含める（含めないと、PUT で変えても外しても通る）
        signableHeaders: new Set(['content-type', 'if-none-match']),
      },
    );
    return {
      url,
      headers: { 'Content-Type': contentType, 'If-None-Match': '*' },
      expiresAt: new Date(signingDate.getTime() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  /**
   * 隔離用のキーの本体を検証し、通れば**検証で読んだ版（`versionId`）に固定して**配信用のキーへコピーする。**通っても通らなくても、隔離用のキーを削除する。**
   *
   * 1. HEAD で現行の版と大きさを読む（無ければ `upload_not_received`）。`accepts` の種別の上限の最大を超えれば、読まずに `file_too_large`
   * 2. その版の先頭を読んで形式を決め（`content-format.ts`）、テキスト系はその版の全体を UTF-8 として確かめる
   * 3. 形式が `accepts` に無ければ `unsupported_file_type`、形式の種別の上限を超えれば `file_too_large`
   * 4. 版を指定してコピーし、メタデータを置き換える（`Content-Type`・`Content-Disposition` を検証した形式から決める。既定の `COPY` はアップロード時の値を引き継ぐ）
   *
   * **版の固定は多層の防御である**——署名付き URL の `If-None-Match: *` により検証の後の差し替えは断られるが、
   * その前提が崩れても、検証していないバイト列は配信用のキーへコピーされない（11.1）。
   */
  async promote(input: {
    readonly quarantineKey: string;
    readonly declaredContentType: string;
    readonly accepts: readonly UploadFormatId[];
    /** 検証した形式の拡張子に付け替えた配信用のキー。 */
    readonly deliveryKeyFor: (format: UploadFormat) => string;
  }): Promise<PromoteResult> {
    try {
      return await this.verifyAndCopy(input);
    } finally {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: input.quarantineKey }),
      );
    }
  }

  /** 検証せずに隔離用のキーを削除する（確定で参加者判定のやり直しに落ちたとき。11.1）。 */
  async discard(quarantineKey: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: quarantineKey }),
    );
  }

  private async verifyAndCopy(input: {
    readonly quarantineKey: string;
    readonly declaredContentType: string;
    readonly accepts: readonly UploadFormatId[];
    readonly deliveryKeyFor: (format: UploadFormat) => string;
  }): Promise<PromoteResult> {
    const bucket = this.config.s3Bucket;
    // 発行で許可リストの Content-Type だけを受け付けているため、ここで当たらないのは行の誤りである
    const declared = uploadFormatByContentType(input.declaredContentType);
    if (!declared) return { ok: false, error: UNSUPPORTED_FILE_TYPE };
    let versionId: string;
    let size: number;
    try {
      const head = await this.s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.quarantineKey }),
      );
      // **版を固定できないなら確定しない**（バケットのバージョニングが無効。compose と infra/production/attachments.tf は有効にしている）
      if (head.VersionId === undefined || head.VersionId === 'null') {
        throw new Error('隔離用のキーの版が読めない（バケットのバージョニングが無効）');
      }
      versionId = head.VersionId;
      size = head.ContentLength ?? 0;
    } catch (error) {
      if (statusOf(error) === 404) return { ok: false, error: UPLOAD_NOT_RECEIVED };
      throw error;
    }
    const accepted = input.accepts.map(uploadFormatById);
    const largestLimit = Math.max(...accepted.map((format) => UPLOAD_LIMIT_BYTES[format.kind]));
    if (size > largestLimit) return { ok: false, error: FILE_TOO_LARGE };
    if (size === 0) return { ok: false, error: UNSUPPORTED_FILE_TYPE };

    const read = async (range?: string): Promise<Uint8Array> => {
      const object = await this.s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: input.quarantineKey,
          VersionId: versionId,
          ...(range === undefined ? {} : { Range: range }),
        }),
      );
      return (await object.Body?.transformToByteArray()) ?? new Uint8Array();
    };
    const verified = verifiedFormatOf(await read(`bytes=0-${SIGNATURE_BYTES - 1}`), declared);
    if (!verified || !input.accepts.includes(verified.id)) {
      return { ok: false, error: UNSUPPORTED_FILE_TYPE };
    }
    const format = uploadFormatById(verified.id);
    if (size > UPLOAD_LIMIT_BYTES[format.kind]) return { ok: false, error: FILE_TOO_LARGE };
    if (verified.needsTextCheck && !isUtf8TextWithoutNul(await read())) {
      return { ok: false, error: UNSUPPORTED_FILE_TYPE };
    }

    const deliveryKey = input.deliveryKeyFor(format);
    const storedName = deliveryKey.slice(deliveryKey.lastIndexOf('/') + 1);
    const source = `${bucket}/${input.quarantineKey.split('/').map(encodeURIComponent).join('/')}`;
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: deliveryKey,
        CopySource: `${source}?versionId=${encodeURIComponent(versionId)}`,
        MetadataDirective: 'REPLACE',
        ContentType: servedContentType(format),
        ContentDisposition: servedContentDisposition(format, storedName),
      }),
    );
    return { ok: true, format, deliveryKey, size };
  }
}
