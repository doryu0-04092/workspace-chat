import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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
  // apps/web だけに React hooks のルールを入れる（#18）。
  //
  // eslint-plugin-react-hooks@7 の `configs.recommended` は、rules-of-hooks /
  // exhaustive-deps に加えて React Compiler 向けの静的解析ルール（purity・refs・
  // static-components など10件超）を丸ごと束ねている。#18 が挙げている問題は
  // 「hooks の呼び出し規則の違反」と「useEffect の依存配列の漏れ」の2つだけであり、
  // eslint-plugin-react（JSX 全般）を入れるかどうかも別途判断するとしている。
  // 挙動を変えるルールを、issue が求めていない範囲まで一括で足さないよう、
  // 使うルールをこの2つに絞って明示する。
  //
  // **踏むと壊れる: 下の rules のうち exhaustive-deps の行だけは、
  // scripts/lint-scope.test.sh が文字列の完全一致で参照している。**
  // 壊す確認はその重大度を書いた行が**ちょうど1件**あることを求め、
  // warn に置き換えて走らせる。そのため **その行の重大度をオプション付きの配列
  // （`[..., { ... }]`）の形に変えると、npm run lint は通るのにあの検査だけが
  // 「sed が想定どおりに書き換えられていない」で落ちる。**
  // 同じ理由で、**この注記に重大度付きの行をそのまま書き写してもならない**
  // （件数が2件になって同じ落ち方をする。実測）。
  //
  // **rules-of-hooks の行は違う。** あちらは ESLint の**出力**にルール ID と
  // error が現れるかで見ており（hooks_rule_is_error）、この設定ファイルの
  // 書き方には依存しない。配列形式に変えても検査は緑のまま通る。
  // 形を変えるときは、あちらの置換と件数の判定も併せて直すこと
  // （上の ignores と .prettierignore が「外れていることは
  // scripts/lint-scope.test.sh が機械で確かめる」と書いているのと同じ関係である）。
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
