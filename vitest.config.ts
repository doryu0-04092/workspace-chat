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
        // web の設定を読む。テストにも要るプラグイン（JSX の変換など）を
        // ビルドと共有するため。
        //
        // **ビルド設定の回帰はここでは捕まえられない。** build.commonjsOptions は
        // vite build（Rollup）にしか作用せず、Vitest は dev / SSR の変換経路で
        // 処理する。optimizeDeps も Vitest では既定で無効。
        // 「テストは通るのにビルドだけが落ちる」を捕まえるのは ci.yml の
        // ビルドのステップである。ここを理由にビルドの検査を外さない。
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
