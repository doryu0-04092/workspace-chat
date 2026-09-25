import type { Server } from 'node:http';

/**
 * HTTP サーバーの keep-alive の待ち時間。**ALB のアイドル時間（infra/production/compute.tf の alb_idle_timeout_seconds）より長くする**（#703）。
 * api が先に接続を閉じると、ALB がその接続に送った要求は 502 になる。Node の既定は 5 秒で、ALB の 60 秒より短い。
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;

/** ヘッダーの待ち時間。**keep-alive の待ち時間より長くする**（短いと、keep-alive の接続で次の要求のヘッダーを待つ間に閉じる）。 */
export const HTTP_HEADERS_TIMEOUT_MS = HTTP_KEEP_ALIVE_TIMEOUT_MS + 1_000;

export function applyHttpTimeouts(server: Server): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
}
