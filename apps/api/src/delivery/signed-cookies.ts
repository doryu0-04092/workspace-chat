import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import type { CookieOptions } from 'express';

/**
 * CloudFront の署名付き Cookie の有効期間（15 分。作業側の決定。機能一覧 11.2・1.3 の「判断が必要な点」）。
 * 仕様の想定（15〜30 分）の短い側を採る——**発行済みの Cookie は個別に失効できず、キック・退出・ログアウト・退会の後も期限まで有効である**
 * （要件定義書 4.3 の代償 2・機能一覧 1.3 の代償）。再発行は web が期限より前にサーバーへ求めて完結するため、短くしても体験は変わらない。
 */
export const SIGNED_COOKIE_TTL_SECONDS = 15 * 60;

/** 署名付き Cookie を発行する配信の経路。`path` は Cookie の Path 属性（要件定義書 4.3 の表）。 */
export type SignedCookieScope =
  | { readonly path: '/avatars' }
  | { readonly path: '/files'; readonly workspaceId: string; readonly channelId: string }
  | { readonly path: '/files'; readonly workspaceId: string; readonly dmId: string };

/**
 * Cookie の対象（署名する方針の Resource）。**配信 URL のパスであり、S3 のキーではない**（要件定義書 4.3 の表）。
 * 踏むと壊れる: `/*` に広げない（1枚の Cookie で全チャンネルの添付が取れる。REVIEW.md 2.1）。
 * `{ws}`・`{ch}` は、判定を通したワークスペースとチャンネルの id を、S3 のキーと同じ小文字で入れる。
 */
export function signedCookieResource(webOrigin: string, scope: SignedCookieScope): string {
  if (scope.path === '/avatars') return `${webOrigin}/avatars/*`;
  const workspace = `${webOrigin}/files/workspace/${scope.workspaceId.toLowerCase()}`;
  // DM の分（#239）はチャンネルの分と重ならない `dm/{dmId}/*` に限る
  return 'dmId' in scope
    ? `${workspace}/dm/${scope.dmId.toLowerCase()}/*`
    : `${workspace}/channel/${scope.channelId.toLowerCase()}/*`;
}

/**
 * Cookie の属性。**`Path` は配信の経路ごとに `/avatars`・`/files`**——省くと既定値が発行時の URI のディレクトリ（`/api/...`）になり、
 * 配信の要求に一度も送られない。`/` にすると、対象の範囲と実際に送られる範囲が食い違う（要件定義書 4.3 の表）。
 * `HttpOnly`・`Secure`・`SameSite=Strict` はリフレッシュトークンの Cookie（auth/session-tokens.ts）と揃える。`Domain` は付けない（発行したホストに限る）。
 */
function cookieOptions(scope: SignedCookieScope): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: scope.path,
    maxAge: SIGNED_COOKIE_TTL_SECONDS * 1000,
  };
}

/** 発行する Cookie（名前・値・属性）。 */
export type SignedCookie = {
  readonly name: string;
  readonly value: string;
  readonly options: CookieOptions;
};

/**
 * 方針（custom policy。Resource に `*` を使うため）に署名した3つの Cookie（CloudFront-Policy・CloudFront-Signature・CloudFront-Key-Pair-Id）を作る。
 * 期限（DateLessThan）は `now` から有効期間の後。
 */
export function signedCookies(
  signer: { readonly keyPairId: string; readonly privateKey: string; readonly webOrigin: string },
  scope: SignedCookieScope,
  now: Date,
): SignedCookie[] {
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: signedCookieResource(signer.webOrigin, scope),
        Condition: {
          DateLessThan: {
            'AWS:EpochTime': Math.floor(now.getTime() / 1000) + SIGNED_COOKIE_TTL_SECONDS,
          },
        },
      },
    ],
  });
  const cookies = getSignedCookies({
    keyPairId: signer.keyPairId,
    privateKey: signer.privateKey,
    policy,
  });
  const options = cookieOptions(scope);
  return Object.entries(cookies)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => ({ name, value, options }));
}
