import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 検査しない場所。生成物と依存パッケージ。
  //
  // `**/generated/**` は Prisma が出力するクライアント（apps/api/src/generated/）。
  // **人が書いたものではなく、指摘されても直せない**（REVIEW.md 7）。
  // 現時点では指摘は出ないが、Prisma の版が上がるか lint の規則が増えた時点で、
  // **誰も直せないコードで lint が落ちる**状態になる。
  { ignores: ['**/dist/**', '**/build/**', '**/coverage/**', 'reports/**', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
