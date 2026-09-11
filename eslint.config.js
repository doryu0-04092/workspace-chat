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
  // `packages/shared/src/api.gen.ts` は openapi-typescript が出力する REST の型であり、同じ理由で外す。
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
      'packages/shared/src/api.gen.ts',
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
  // **rules-of-hooks の行は、重大度の書き方だけは違う。** あちらは ESLint の
  // **出力**にルール ID と error が現れるかで見ており（hooks_rule_is_error）、
  // この行を配列形式に変えても検査は緑のまま通る。
  // **ただし「依存しない」のはその書き方までである。** 検出そのものは下の files に
  // 依存している（次の注記）。
  // **exhaustive-deps の行**の形を変えるときは、あちらの置換と件数の判定も
  // 併せて直すこと。**rules-of-hooks の行にその依存は無い**（すぐ上のとおり。
  // 置換と件数の判定が見ているのは exhaustive-deps の行だけである）。
  // （上の ignores と .prettierignore が「外れていることは
  // scripts/lint-scope.test.sh が機械で確かめる」と書いているのと同じ関係である）。
  {
    // **踏むと壊れる: この files の範囲に、scripts/lint-scope.test.sh が置く probe が
    // 入っていること。** あちらは probe の置き場所を apps/web/src の下に固定している。
    // ここを `apps/web/src/components/**` のように絞る、あるいは web を別の場所へ
    // 移すと、**probe がルールの適用対象から外れる。** そのとき
    // **npm run lint は緑のまま**（probe は他のルールにも当たらない位置にある）で、
    // あの検査の「react-hooks のルール」だけが「両方とも error で検出されていない」で
    // 落ちる。範囲を変えるときは、あちらの置き場所も併せて動かすこと。
    //
    // **手当は両側にある。** あちらの NG の案内も `files` を名指しする
    // （「eslint.config.js の files が … を含んでいることも確かめる」）。
    // **片方だけを「重複だ」として消さないこと。** この注記は設定を触る人に、
    // 案内は落ちたログを読む人に届く。届く相手が違う。
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // scripts/ の下は CI が Node で直接動かすもので、ブラウザでも
  // アプリのバンドルでもない。**Node のグローバルを宣言する。**
  //
  // 宣言しないと no-undef が process / console を「未定義」として落とす。
  // **no-undef を無効にする形は採らない**——綴りを間違えた変数まで通るようになる。
  //
  // 使うものだけを列挙している。`globals` パッケージを足せば一括で入るが、
  // **この2つのために依存を1つ増やすことになる。**
  // ここで使うグローバルが増えたら、この行に足す。
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
);
