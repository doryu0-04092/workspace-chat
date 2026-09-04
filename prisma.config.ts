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
// 既に環境変数が入っているときは読まない。テストは接続先を環境変数で直接渡しており、
// **手元に置いてある .env がそれを上書きすると、テストが開発用の DB を壊す。**
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile();
  } catch {
    // .env が無い環境（CI）では、環境変数が直接渡される。ここで止めない。
  }
}

export default defineConfig({
  schema: 'apps/api/prisma/schema.prisma',
  migrations: {
    path: 'apps/api/prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
