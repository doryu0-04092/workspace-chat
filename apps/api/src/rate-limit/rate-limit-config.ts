/**
 * Valkey の接続先（環境変数 `REDIS_URL`）。**未設定・空は起動時に落とす。** 例外のメッセージに値を載せない
 * （接続先には資格情報が入りうる）。
 */
export function resolveRedisUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error('REDIS_URL が設定されていません（Valkey の接続 URL を環境変数で渡す）');
  }
  return raw;
}

/**
 * 信頼する中継の段数（環境変数 `TRUST_PROXY_HOPS`。Express の `trust proxy` に渡す）。**必須**（決定・2026-09-11・依頼側。#252）。
 *
 * レート制限の発信元は `req.ip` であり、Express はこの段数だけ X-Forwarded-For を右から信じて決める。
 * **多すぎると利用者が偽の発信元を名乗れ、少なすぎると全員が手前の中継の IP で数えられ、1人の超過で全員が止まる。**
 * 本番（CloudFront → ALB → タスク）は 2。**ALB に CloudFront を経ずに届く経路を塞いでいることが前提**
 * （塞いでいないと、直接 ALB に X-Forwarded-For を送って発信元を偽れる）。手元で直接叩くときは 0 を明示する。
 *
 * **未設定を既定値に倒さない。** 本番で渡し忘れて 0 になると全員が ALB の IP で数えられ、エラーもログも出ないまま
 * 正規の利用者だけが 429 を受ける（迂回はアラートにしない決定のため、ほかに気づく経路も無い）。起動時に落とす。
 */
export function resolveTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error(
      'TRUST_PROXY_HOPS が設定されていません（信頼する中継の段数。本番は 2、手元で直接叩くなら 0 を明示する）',
    );
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY_HOPS の値が不正です（0 以上の10進の整数を指定してください）: ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

/**
 * api のタスク数（環境変数 `API_TASK_COUNT`）。未設定は 1。
 * Valkey が止まっている間、各タスクのメモリで数えるときに上限をこの数で割る（resilient-rate-limit-storage.ts）。
 */
export function resolveApiTaskCount(raw: string | undefined): number {
  if (raw === undefined) return 1;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `API_TASK_COUNT の値が不正です（1 以上の10進の整数を指定してください）: ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}
