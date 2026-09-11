/**
 * DB の接続先（環境変数 `DATABASE_URL`）。**未設定・空は起動時に落とす。**
 * 見逃すと最初の問い合わせで原因の分かりにくいエラーになる。
 * **値には資格情報が入る**（api-config.ts の API_SETTINGS で `secret: true`。不正なときのメッセージは集約が伏せる）。
 */
export function resolveDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error(
      'DATABASE_URL が設定されていません（開発用データベースの接続 URL を環境変数で渡す）',
    );
  }
  return raw;
}
