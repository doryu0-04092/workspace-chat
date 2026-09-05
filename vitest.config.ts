import swc from 'unplugin-swc';
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
        // api だけ SWC で変換する。Vitest の既定の変換器（esbuild）は
        // `emitDecoratorMetadata` を実装しておらず、Nest がコンストラクタの
        // 依存を解決する `design:paramtypes` が出力されない。
        // Nest は解決に失敗せず undefined を注入するため、DI の誤りが
        // 「使う瞬間に別の場所で落ちる」形になる（#14）。
        //
        // 変換の設定は apps/api/tsconfig.json から読まれる。
        // **同ファイルの `experimentalDecorators` と `emitDecoratorMetadata` を
        // 外すと、この変換もメタデータを出さなくなる。**
        // 外れていないことは src/dependency-injection.test.ts が見ている。
        plugins: [swc.vite()],
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
