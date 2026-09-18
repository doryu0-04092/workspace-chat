import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolvePort } from '../api/src/port';
import { resolveS3Bucket, resolveS3Endpoint } from '../api/src/storage/s3-config';
import { storageProxies } from './src/dev/storage-proxy';

/**
 * 手元の配信の中継（src/dev/storage-proxy.ts）。**api を起動した端末と同じ `S3_ENDPOINT`・`S3_BUCKET` を、この dev サーバーの端末にも渡す**
 * （`PORT` と同じく `.env` からは来ない）。**値の規則は api の s3-config.ts の1つだけを使う**（渡したのに不正なら起動時に落とす）。
 * どちらかが無ければ中継せず、そのことを出す（アバターの画像が出ない理由を黙らせない）。
 */
function localStorageProxies() {
  const { S3_ENDPOINT, S3_BUCKET } = process.env;
  if (S3_ENDPOINT === undefined || S3_BUCKET === undefined) {
    console.warn(
      'S3_ENDPOINT と S3_BUCKET が無いため、/avatars と /files を MinIO へ中継しない（アバターと添付の画像は表示されない）',
    );
    return {};
  }
  return storageProxies({
    endpoint: resolveS3Endpoint(S3_ENDPOINT),
    bucket: resolveS3Bucket(S3_BUCKET),
  });
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // **踏むと壊れる: サーバーへ向かうパスは `/api` で始まる**（#77 の決定）。
  // 本番は CloudFront が `/api/*` だけを ALB へ振り分け、それ以外は静的配信の
  // バケットへ向かう。**手元には CloudFront が無い**ため、この proxy が同じ形を作る。
  // これが無いと `/api/...` は Vite の dev サーバーに当たり、NestJS には届かない。
  //
  // **Socket.IO の `path` も `/api/socket.io/` である**（既定の `/socket.io/` ではない）。
  // クライアント側で `io(url, { path: REALTIME_PATH, transports: [...REALTIME_TRANSPORTS] })`（@workspace-chat/shared）と書くこと。
  // transports を既定（polling から始める）のままにすると、同一 origin の polling に Origin が付かずハンドシェイクが断られる（理由は shared の注記）。
  // **書き忘れると既定のまま CloudFront の既定ビヘイビアに落ちて静的配信へ向かい、
  // アプリ側のログには何も出ない**（機能一覧 5.2 / docs/tech-stack.md の CloudFront の行）。
  server: {
    proxy: {
      '/api': {
        // **`PORT` の解決規則は `apps/api/src/port.ts` が定める1つだけである。**
        // ここで書き直すと api と web で規則が2つになる——とくに `PORT=`（空文字）は
        // `port.ts` が起動時に落とす入力であり、web 側で既定値に落とすと
        // **8080 のつもりが黙って 3000 に繋ぎに行く**（README「動かす」）。
        // **値は `.env` からは来ない。** Vite は設定ファイルの評価時に `.env` を読まず、
        // 見えるのはその時点の環境変数だけである（api も `.env` を読まない。.env.example）。
        // **api を起動した端末と同じ `PORT` を、この開発サーバーの端末にも渡すこと。**
        // 接続先のホストは `127.0.0.1` に固定し `localhost` と書かない（README「接続先の組み立て方」）。
        target: `http://127.0.0.1:${resolvePort(process.env.PORT)}`,
        // WebSocket のハンドシェイクも同じ前置きに載るため、ws を有効にする。
        ws: true,
      },
      // 配信 URL のパス（本番は CloudFront の `/avatars/*` と `/files/*`）。手元では MinIO へ中継する。
      ...localStorageProxies(),
    },
  },
  // @workspace-chat/shared は CommonJS で出す（NestJS 11 が CommonJS のため）。
  // 理由と代償は docs/tech-stack.md「共有パッケージを CommonJS で出す理由と代償」に記す。
  // ワークスペースのリンク先は node_modules の外にあり、Rollup の CommonJS 変換は
  // 既定で node_modules しか見ないため、明示しないと「名前付きエクスポートが無い」と
  // 判定されてビルドだけが落ちる（型チェックとテストは通る）。
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages\/shared/],
    },
  },
  optimizeDeps: {
    include: ['@workspace-chat/shared'],
  },
});
