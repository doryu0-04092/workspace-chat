import { defineConfig } from 'vitest/config';

// テストはワークスペースごとに環境が違う。api は Node、web は DOM が要る。
// 1つの設定にまとめ、ファイルの場所で切り替える。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        // web の実際のビルド設定を読む。読まないと、共有パッケージの
        // CommonJS 変換など vite.config.ts 側の設定がテストに効かず、
        // テストは通るのにビルドだけが落ちる状態を作り得る。
        extends: './apps/web/vite.config.ts',
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test-setup.ts'],
        },
      },
    ],
    reporters: ['default', 'junit'],
    outputFile: { junit: './reports/vitest-junit.xml' },
  },
});
