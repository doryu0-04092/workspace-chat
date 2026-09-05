import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma の CLI の設定。
 *
 * **Prisma 7 は `datasource` ブロックの `url` を廃止した。** 接続先はこのファイルで渡す。
 * スキーマ（`apps/api/prisma/schema.prisma`）に接続先は書けない。
 *
 * リポジトリの根に置くのは、`prisma` の CLI をルートの開発依存として入れているため
 * である。根で `npx prisma migrate dev` を実行すれば、`--schema` を毎回渡さずに済む。
 */

// **必要な環境変数は `DATABASE_URL` の1つである。**
//
// `prisma generate` を除くすべての `prisma` のコマンド（`migrate dev` / `migrate deploy` /
// `migrate diff` / `db execute` など）がこれを必要とする。設定していないと、
// 接続先が undefined のまま Prisma に渡り、**原因の分かりにくいエラーになる。**
//
// 値はここにも .env.example にも書かない（CLAUDE.md 禁止事項）。
// **手元で動かすときは、開発用データベースの接続 URL を `DATABASE_URL` に入れる。**
//
// **Prisma 7 は .env を自動では読み込まない。**
// 依存を増やさずに読むため、Node 24 の組み込み機能を使う。
//
// **`.env` の値は、既に環境に入っている値を上書きしない。**
// Node 24.16.0 で実測した（`PROBE_VAR` を環境に入れた状態で、違う値を書いた `.env` を
// `process.loadEnvFile()` に読ませると、環境側の値が残る。引数の有無で違いは無い。
// ファイルにしか無い変数は読み込まれる）。
//
// **かつては「環境変数が入っているときは読まない」という条件を置いていた。**
// 理由は「手元の .env がテストの接続先を上書きすると、開発用の DB を壊す」だったが、
// **上書きは起きないため、その危険はそもそも無い。** 条件は外した。
// 残していると、`DATABASE_URL` が環境にある間、**.env に置いた他の変数も一切読まれない。**
// 現時点で必要な変数は `DATABASE_URL` だけなので実害は無いが、
// **根拠が事実と違うまま残ると、後からこの条件を外してよいか誰も判断できない。**
//
// **読む場所は、このファイルの位置から決める。** `process.loadEnvFile()` は
// 引数が無いと `path.resolve(process.cwd(), '.env')` を読むため、
// **`apps/api` など根以外を cwd にして `prisma` を実行すると、根の .env が読まれない。**
// 下の `catch` は握り潰すので何も出力されず、`datasource.url` が undefined のまま渡り、
// **上のコメントが避けたいと書いている「原因の分かりにくいエラー」がそのまま起きる。**
// 「根で実行すること」を規約で守らせるのではなく、仕組みで固定する。
try {
  process.loadEnvFile(join(import.meta.dirname, '.env'));
} catch {
  // .env が無い環境（CI）では、環境変数が直接渡される。ここで止めない。
}

// **パスも .env と同じ基準（このファイルの位置）で解決する。**
// Prisma 7 がこの2つを cwd 起点で解くのか設定ファイルの位置起点で解くのかは
// **確かめていない。** どちらであっても正しくなる形にして、その曖昧さを消す。
// 片方だけ `import.meta.dirname` にすると、**同じファイルの中に解決の基準が
// 2種類あるように読める。**
export default defineConfig({
  schema: join(import.meta.dirname, 'apps/api/prisma/schema.prisma'),
  migrations: {
    path: join(import.meta.dirname, 'apps/api/prisma/migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
