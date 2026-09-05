import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 検査しない場所。生成物と、追跡していない作業用のディレクトリ。
  //
  // `**/generated/**` は Prisma が出力するクライアント（apps/api/src/generated/）。
  // **人が書いたものではなく、指摘されても直せない**（REVIEW.md 7）。
  // 現時点では指摘は出ないが、Prisma の版が上がるか lint の規則が増えた時点で、
  // **誰も直せないコードで lint が落ちる**状態になる。
  //
  // .claude/ にはエージェントが作る git のワークツリーが入る。
  // その中には apps/ の複製がまるごと含まれるため、走査すると
  // 「tsconfig の候補が複数ある」という解析エラーで落ちる。
  //
  // **CI では起きない。** .claude/ は追跡しておらず、CI のチェックアウトには無い。
  // 手元でだけ落ちるため、気づかないまま「手元で lint を回さない」状態に倒れる。
  // 外れていることは scripts/lint-scope.test.sh が機械で確かめる。
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'reports/**',
      '**/generated/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
