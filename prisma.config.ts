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
//
// **優先順位はこのファイルの中で確定させる。** 上の実測（環境側が勝つ）に
// 寄りかからず、読み込む前の値を控えておいて、それを優先する。
// **`npm test` の接続先が手元の .env に差し替わると、起動したコンテナではなく
// 開発用の DB に対して `migrate deploy` / `migrate diff` を当てることになる。**
// Node の版が上がったときも、将来 `dotenv` などに置き換えたときも、
// **その事故だけは、この1行があれば起きない。**
const databaseUrlFromEnvironment = process.env.DATABASE_URL;

try {
  process.loadEnvFile(join(import.meta.dirname, '.env'));
} catch (error) {
  // **握り潰してよいのは「ファイルが無い」ことだけである。**
  // .env が無い環境（CI）では環境変数が直接渡されるため、そこは止めない。
  //
  // **理由を見ずに握り潰すと、.env があるのに読めない場合**
  // （権限が無い・壊れたシンボリックリンク・`.env` という名前のディレクトリ）**も
  // 同じく無視される。** そのとき `DATABASE_URL` は環境にも無いため
  // `datasource.url` が undefined のまま渡り、**上のコメントが「避けたい」と
  // 名指ししている「原因の分かりにくいエラー」がそのまま起きる。**
  // **「置いた .env が読まれていない」ことが利用者に一切伝わらない**のが本質である。
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// **Prisma の CLI に渡す接続先は、証明書を検証する形に読み替える。**
// 本番の `DATABASE_URL` は libpq の形（`sslmode=verify-full&sslrootcert=<CA のファイル>`）で、
// api の pg と psql はこの形でサーバー証明書を検証する。**Prisma の CLI（7.10.0）はこの形では検証しない**——
// `verify-full` を `prefer` に読み替えて `sslrootcert` を捨て、別の CA でも繋がる（#424 で確かめた）。
// CLI が検証する形（`sslmode=require&sslcert=<CA のファイル>&sslaccept=strict`）はここでだけ作る。
// その形は psql が読めず pg では警告になるため、`DATABASE_URL` の値そのものにはしない
// （docs/tech-stack.md の「DB への接続の暗号化」）。
//
// **踏むと壊れる: この読み替えを外すと、マイグレーションは暗号化されるが、接続先を検証しないまま流れる。**
// scripts/api-image.test.sh が、別の CA ではマイグレーションを適用できないことを見る。
// `sslmode=verify-full` の無い接続先（手元の開発用 DB とテスト）は、そのまま渡す。
function toPrismaCliUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // URL として読めない値は Prisma の検査に任せる。例外の `input` には値（資格情報を含む）が載るため、ここで投げない。
    return url;
  }
  if (parsed.searchParams.get('sslmode') !== 'verify-full') return url;
  const rootCertificate = parsed.searchParams.get('sslrootcert');
  if (rootCertificate === null || rootCertificate === '') {
    // Prisma に渡すと prefer に読み替えられ、検証する CA が無いまま繋がる。
    throw new Error(
      'DATABASE_URL の sslmode=verify-full には sslrootcert（サーバー証明書を検証する CA のファイル）を付ける',
    );
  }
  parsed.searchParams.set('sslmode', 'require');
  parsed.searchParams.delete('sslrootcert');
  parsed.searchParams.set('sslcert', rootCertificate);
  parsed.searchParams.set('sslaccept', 'strict');
  return parsed.toString();
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
    // **環境に入っていた値が常に勝つ。** 上の説明を参照。CLI が証明書を検証する形への読み替えも上にある。
    url: toPrismaCliUrl(databaseUrlFromEnvironment ?? process.env.DATABASE_URL),
  },
});
