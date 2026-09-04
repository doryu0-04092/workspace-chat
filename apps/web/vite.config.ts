import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // @workspace-chat/shared は CommonJS で出す（NestJS 11 が CommonJS のため。
  // 詳細は packages/shared/package.json のコメント）。
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
