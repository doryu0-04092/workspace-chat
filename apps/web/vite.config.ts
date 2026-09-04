import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
