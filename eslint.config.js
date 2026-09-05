import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 検査しない場所。生成物と、追跡していない作業用のディレクトリ。
  //
  // .claude/ にはエージェントが作る git のワークツリーが入る。
  // その中には apps/ の複製がまるごと含まれるため、走査すると
  // 「tsconfig の候補が複数ある」という解析エラーで落ちる。
  //
  // **CI では起きない。** .claude/ は追跡しておらず、CI のチェックアウトには無い。
  // 手元でだけ落ちるため、気づかないまま「手元で lint を回さない」状態に倒れる。
  // 外れていることは scripts/lint-scope.test.sh が機械で確かめる。
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', 'reports/**', '.claude/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
