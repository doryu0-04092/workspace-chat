import { describe, expect, it } from 'vitest';
import {
  resolveS3Bucket,
  resolveS3Endpoint,
  resolveS3ForcePathStyle,
  resolveS3Region,
  resolveS3UploadRoleArn,
} from './s3-config';

describe('S3 の設定', () => {
  describe('S3_BUCKET（添付とアバターのバケット）', () => {
    it.each(['workspace-chat-attachments-123456789012', 'abc', 'a.b-c', 'a'.repeat(63)])(
      '%j を使う',
      (raw) => {
        expect(resolveS3Bucket(raw)).toBe(raw);
      },
    );
    // 名前の規則を外れた値は、最初の読み書きで原因の分かりにくい失敗になる。起動時に落とす。
    it.each([
      undefined,
      '',
      'ab',
      'a'.repeat(64),
      'Workspace-chat',
      'bucket_name',
      '-bucket',
      'bucket-',
      'bucket/avatars',
      ' bucket',
    ])('%j は起動時に落とす', (raw) => {
      expect(() => resolveS3Bucket(raw)).toThrow(/S3_BUCKET/);
    });
  });

  describe('S3_REGION（バケットのリージョン）', () => {
    it.each(['ap-northeast-1', 'us-east-1', 'us-gov-west-1'])('%j を使う', (raw) => {
      expect(resolveS3Region(raw)).toBe(raw);
    });
    // 署名はリージョンを含む。違うリージョンで署名すると、読み書きのたびに断られる。未設定を既定値に倒さない。
    it.each([undefined, '', 'ap-northeast', 'AP-NORTHEAST-1', 'ap-northeast-1 ', 'tokyo'])(
      '%j は起動時に落とす',
      (raw) => {
        expect(() => resolveS3Region(raw)).toThrow(/S3_REGION/);
      },
    );
  });

  // 手元とテストの S3 互換のストレージ（MinIO）の宛先。本番では設定せず、AWS の既定の宛先を使う。
  describe('S3_ENDPOINT（S3 の宛先）', () => {
    it('設定していなければ、AWS の既定の宛先を使う（undefined）', () => {
      expect(resolveS3Endpoint(undefined)).toBeUndefined();
    });
    it.each(['http://127.0.0.1:9000', 'http://localhost:9000', 'https://s3.example.com'])(
      '%j を使う',
      (raw) => {
        expect(resolveS3Endpoint(raw)).toBe(raw);
      },
    );
    // 空文字を「設定していない」に倒さない（書き忘れが AWS への送信として動いてしまう）。
    // パスや末尾の / が付くと、キーの前に余計な区切りが入る。資格情報を URL に書かせない（この設定は秘密として扱わない）。
    it.each([
      '',
      '127.0.0.1:9000',
      'http://127.0.0.1:9000/',
      'http://127.0.0.1:9000/bucket',
      'http://user:pass@127.0.0.1:9000',
      'ftp://127.0.0.1:9000',
    ])('%j は起動時に落とす', (raw) => {
      expect(() => resolveS3Endpoint(raw)).toThrow(/S3_ENDPOINT/);
    });
  });

  describe('S3_FORCE_PATH_STYLE（キーをパスで指すか）', () => {
    it('設定していなければ false（AWS の既定の仮想ホスト形式）', () => {
      expect(resolveS3ForcePathStyle(undefined)).toBe(false);
    });
    it.each([
      ['true', true],
      ['false', false],
    ])('%j は %s', (raw, expected) => {
      expect(resolveS3ForcePathStyle(raw)).toBe(expected);
    });
    // 切り替えるつもりで書いた `TRUE` や `1` を黙って false に倒さない。
    it.each(['', 'TRUE', '1', 'yes'])('%j は起動時に落とす', (raw) => {
      expect(() => resolveS3ForcePathStyle(raw)).toThrow(/S3_FORCE_PATH_STYLE/);
    });
  });

  // アップロード用の署名付き URL の署名者のロール（#427）。本番だけで設定し、手元とテストは既定の資格情報で署名する。
  describe('S3_UPLOAD_ROLE_ARN（署名付き URL の署名者のロール）', () => {
    it('設定していなければ、ロールを引き受けない（undefined）', () => {
      expect(resolveS3UploadRoleArn(undefined)).toBeUndefined();
    });
    it.each([
      'arn:aws:iam::123456789012:role/workspace-chat-upload-signer',
      'arn:aws:iam::123456789012:role/path/to/name_with+=,.@-',
      'arn:aws-us-gov:iam::123456789012:role/signer',
    ])('%j を使う', (raw) => {
      expect(resolveS3UploadRoleArn(raw)).toBe(raw);
    });
    // 空文字を「設定していない」に倒さない（本番で渡し損ねた値が、タスクロールそのもので署名する形として黙って動く）。
    it.each([
      '',
      'workspace-chat-upload-signer',
      'arn:aws:iam::123456789012:user/signer',
      'arn:aws:iam::12345678901:role/signer',
      'arn:aws:sts::123456789012:assumed-role/signer/session',
      'arn:aws:iam::123456789012:role/',
      ' arn:aws:iam::123456789012:role/signer',
    ])('%j は起動時に落とす', (raw) => {
      expect(() => resolveS3UploadRoleArn(raw)).toThrow(/S3_UPLOAD_ROLE_ARN/);
    });
  });
});
