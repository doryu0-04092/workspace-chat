import { isHttpOrigin } from '../config/http-origin';

/*
 * S3 の設定（api-config.ts の API_SETTINGS）。**資格情報（アクセスキー）は設定に持たない**——本番は ECS のタスクロール、
 * 手元とテストは AWS SDK の既定の読み方（環境変数 AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY など）に任せる（#427）。
 * そのため、ここの設定はどれも秘密を含まない（S3_ENDPOINT は資格情報を URL に書かせない）。
 */

/** S3 のバケット名の規則のうち、起動時に確かめる分（3〜63 文字の英小文字・数字・`.`・`-`。先頭と末尾は英小文字か数字）。 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** 添付とアバターのバケット（環境変数 `S3_BUCKET`）。**必須。** 本番は infra/production/attachments.tf のバケット。 */
export function resolveS3Bucket(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error('S3_BUCKET が設定されていません（添付とアバターのバケット名を渡す）');
  }
  if (!BUCKET_NAME.test(raw)) {
    throw new Error(
      `S3_BUCKET の値が不正です（3〜63 文字の英小文字・数字・. と -。先頭と末尾は英小文字か数字）: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * バケットのリージョン（環境変数 `S3_REGION`。例: `ap-northeast-1`）。**必須。**
 * 署名はリージョンを含むため、違うリージョンで署名すると読み書きのたびに断られる。既定値に倒さない。
 */
export function resolveS3Region(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error('S3_REGION が設定されていません（バケットのリージョン。例: ap-northeast-1）');
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(raw)) {
    throw new Error(
      `S3_REGION の値が不正です（例: ap-northeast-1 の形で指定してください）: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * S3 の宛先（環境変数 `S3_ENDPOINT`）。手元とテストの S3 互換のストレージ（MinIO）を指すときだけ設定する。
 * **未設定なら AWS の既定の宛先を使う**（本番）。**空文字は未設定に倒さず起動時に落とす**——書き忘れが AWS への送信として動いてしまう。
 * origin の形（スキーム://ホスト[:ポート]）だけを受け付ける（パス・末尾の /・資格情報を付けない）。
 */
export function resolveS3Endpoint(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!isHttpOrigin(raw)) {
    throw new Error(
      `S3_ENDPOINT の値が不正です（スキーム://ホスト[:ポート] の形で、末尾の / やパス・資格情報を付けない）: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * キーをパスで指すか（環境変数 `S3_FORCE_PATH_STYLE`）。未設定なら false（AWS の既定の仮想ホスト形式）。
 * **手元とテストの MinIO では true にする**——false だとバケット名を前に付けたホスト名（`<バケット>.localhost` など）を引くことになり、
 * 引けずに読み書きが落ちる（Windows の手元で ENOTFOUND になることを確かめた。2026-09-17）。
 * **`true` / `false` 以外は起動時に落とす**（`TRUE` や `1` を黙って false に倒さない）。
 */
export function resolveS3ForcePathStyle(raw: string | undefined): boolean {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(
    `S3_FORCE_PATH_STYLE の値が不正です（true か false を指定してください）: ${JSON.stringify(raw)}`,
  );
}

/**
 * アップロード用の署名付き URL に署名するロール（環境変数 `S3_UPLOAD_ROLE_ARN`。秘密ではない）。**任意。**
 * 設定されていれば、api が `sts:AssumeRole` で引き受けた一時的な資格情報で署名する（#427。uploads/upload-signer.ts）——
 * **署名付き URL への PUT は署名したプリンシパルとして認証されるため、`quarantine/` にだけ書けるロールで署名する**（技術スタックの添付ファイルの行）。
 * 未設定なら S3 のクライアントの既定の資格情報で署名する（手元・テスト。手元では署名者と確定の主体を分けない）。
 *
 * **踏むと壊れる: 本番で設定し損ねると、確定の主体（api のタスクロール）で署名することになり、ブラウザからの PUT が配信用のキーにも通る権限で認証される。**
 * そのため空文字を未設定に倒さず、IAM のロールの ARN の形でなければ起動時に落とす。
 */
export function resolveS3UploadRoleArn(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(raw)) {
    throw new Error(
      `S3_UPLOAD_ROLE_ARN の値が不正です（arn:aws:iam::<アカウント ID 12 桁>:role/<ロール名> の形で指定してください）: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}
