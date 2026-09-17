import { createPrivateKey } from 'node:crypto';

/*
 * CloudFront の署名付き Cookie の設定（api-config.ts の API_SETTINGS。#427）。アバター（機能一覧 1.3）と添付（11.2）の配信に使う。
 * **2つとも未設定なら Cookie を発行しない**（手元とテスト。CloudFront が無い）。**片方だけの設定は起動時に落とす**（api-config.ts の resolveApiConfig）。
 * 本番は、キーペア ID をタスク定義の environment、秘密鍵を Parameter Store の SecureString から secrets で渡す（infra/production/service.tf）。
 */

/** キーペア ID の形（CloudFront の公開鍵の ID。英大文字と数字）。Cookie の値にそのまま載るため、区切りになる文字を受け付けない。 */
const KEY_PAIR_ID = /^[A-Z0-9]{1,64}$/;

/**
 * 署名に使う公開鍵の ID（環境変数 `CLOUDFRONT_KEY_PAIR_ID`。キーグループに登録した公開鍵の ID）。**秘密ではない。**
 * **未設定なら undefined（Cookie を発行しない）。空文字は未設定に倒さず起動時に落とす**——書き忘れが、本番で Cookie を黙って発行しない形で動いてしまう。
 */
export function resolveCloudFrontKeyPairId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!KEY_PAIR_ID.test(raw)) {
    throw new Error(
      `CLOUDFRONT_KEY_PAIR_ID の値が不正です（CloudFront の公開鍵の ID。英大文字と数字）: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * 署名の秘密鍵（環境変数 `CLOUDFRONT_PRIVATE_KEY`。PEM の RSA 秘密鍵。キーペア ID の公開鍵と対のもの）。
 * **値は鍵そのものである**（API_SETTINGS で `secret: true`。メッセージに値を載せない）。
 * **未設定なら undefined。空文字と、RSA の秘密鍵として読めない値は起動時に落とす**——読めない鍵で起動すると、Cookie の発行のたびに落ちる。
 */
export function resolveCloudFrontPrivateKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let type: string | undefined;
  try {
    type = createPrivateKey(raw).asymmetricKeyType;
  } catch {
    type = undefined;
  }
  if (type !== 'rsa') {
    throw new Error(
      'CLOUDFRONT_PRIVATE_KEY の値が不正です（PEM の RSA 秘密鍵を渡す。値は秘密を含むため載せない）',
    );
  }
  return raw;
}
