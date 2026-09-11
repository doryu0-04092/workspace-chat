import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolvePort } from '../api/src/port';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // **踏むと壊れる: サーバーへ向かうパスは `/api` で始まる**（#77 の決定）。
  // 本番は CloudFront が `/api/*` だけを ALB へ振り分け、それ以外は静的配信の
  // バケットへ向かう。**手元には CloudFront が無い**ため、この proxy が同じ形を作る。
  // これが無いと `/api/...` は Vite の dev サーバーに当たり、NestJS には届かない。
  //
  // **Socket.IO の `path` も `/api/socket.io/` である**（既定の `/socket.io/` ではない）。
  // クライアント側で `io(url, { path: REALTIME_PATH })`（@workspace-chat/shared）と書くこと。
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
