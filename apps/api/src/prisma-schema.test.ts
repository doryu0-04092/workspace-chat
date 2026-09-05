import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Prisma のスキーマとマイグレーションを、**実際の PostgreSQL に対して**検証する。
 *
 * SQLite やモックでは意味を持たない。ここで確かめたいのは
 * 「一意制約が本当に効くか」「検査制約が本当に拒否するか」であり、
 * それは実際の DB エンジンでしか分からない（#34）。
 *
 * ## 実行の前提: **Docker のデーモンが動いていること**
 *
 * このファイルは Testcontainers で `postgres:17` のコンテナを起動する。
 * そのため **`npm test` は Docker が動いていることを前提とする。**
 * 動いていない環境では `beforeAll` がコンテナを起動できず、
 * **このファイルのテストが一式落ちる。スキーマともマイグレーションとも無関係な理由で
 * 赤くなるため、原因を取り違えやすい。**
 * 落ちたメッセージに `docker` / `Could not find a working container runtime` が
 * 出ているなら、疑うのはスキーマではなく Docker である。
 *
 * （下の 600 秒はイメージの取得を待つための猶予であり、
 * 「待たされる理由」であって「動かない理由」ではない。）
 *
 * ## Prisma のクライアントを使わない理由
 *
 * Prisma 7 のクライアントは**ドライバアダプタ（`@prisma/adapter-pg`）を必須とする**。
 * これは未承認の依存であり、このイシューの範囲でもない。
 * この PR が成果物とするのは**スキーマとマイグレーション**であって、
 * クライアントの使い方ではない。よって
 *
 * - マイグレーションの適用と差分の検出 → `prisma` の CLI
 * - 表に対する問い合わせと制約の検証   → コンテナ内の `psql`
 *
 * の2つだけで検証する。**どちらも検証しているのは DB の実際の状態である。**
 *
 * ## イメージに pg_bigm を含めない理由
 *
 * 全文検索（F-30）は別のイシューで扱う。このイシューのモデルは検索を含まないため、
 * 素の `postgres:17` で足りる。**検索のモデルが入る時点で、pg_bigm を同梱した
 * イメージが別途必要になる**（イシュー #34 に代償として記録した）。
 */

const POSTGRES_IMAGE = 'postgres:17';

/** リポジトリの根（`node_modules/prisma` を持つディレクトリ）を、cwd から遡って探す。 */
function findRepositoryRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'prisma', 'build', 'index.js'))) return dir;
    const parent = dirname(dir);
    // 根に着いても見つからなければ、探し方が間違っている。黙って進むと
    // 後続の失敗が「prisma が壊れている」ように見える。
    if (parent === dir) throw new Error('prisma の CLI が見つからない');
    dir = parent;
  }
}

const repositoryRoot = findRepositoryRoot();
const prismaCli = join(repositoryRoot, 'node_modules', 'prisma', 'build', 'index.js');
const schemaPath = join(repositoryRoot, 'apps', 'api', 'prisma', 'schema.prisma');

/**
 * prisma の CLI を実行する。
 *
 * `npx` を介さない。Windows では `npx` が `npx.cmd` になり、`execFile` で
 * 直接起動できない。**手元と CI で起動の仕方を変えると、片方でしか通らない
 * テストになる。** Node で CLI の実体を直接動かせば、どちらも同じ経路になる。
 */
function runPrisma(args: string[], databaseUrl: string): string {
  return execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: repositoryRoot,
    // Prisma 7 は .env を自動で読み込まない。接続先はここで明示的に渡す。
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('Prisma のスキーマとマイグレーション', () => {
  let container: StartedPostgreSqlContainer;

  /** コンテナ内の `psql` で SQL を実行し、結果と終了コードを返す。 */
  async function psql(sql: string): Promise<{ exitCode: number; output: string }> {
    const result = await container.exec([
      'psql',
      '-U',
      container.getUsername(),
      '-d',
      container.getDatabase(),
      // 途中の文が失敗したら、そこで止めて非ゼロで終える。
      // これが無いと、失敗した文を飛ばして最後の文の成否だけが返る。
      '-v',
      'ON_ERROR_STOP=1',
      // 見出しと桁揃えを外す。値をそのまま比較したい。
      '-tA',
      '-c',
      sql,
    ]);
    return { exitCode: result.exitCode, output: result.output.trim() };
  }

  /** SQL が失敗することを期待し、その出力を返す。成功したら失敗として扱う。 */
  async function expectSqlToFail(sql: string): Promise<string> {
    const { exitCode, output } = await psql(sql);
    expect(exitCode, `この SQL は拒否されるべきだが成功した:\n${sql}`).not.toBe(0);
    return output;
  }

  /** SQL が成功することを期待し、その出力を返す。 */
  async function expectSqlToSucceed(sql: string): Promise<string> {
    const { exitCode, output } = await psql(sql);
    expect(exitCode, `この SQL は成功するべきだが失敗した:\n${sql}\n${output}`).toBe(0);
    return output;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    // 空の DB にマイグレーションを適用する。ここが落ちるなら、
    // マイグレーションが実際の PostgreSQL に適用できていない。
    runPrisma(['migrate', 'deploy', '--schema', schemaPath], container.getConnectionUri());

    // 前提データはここで揃える。**どれか1つの describe の中に置かない。**
    // 置くと、describe の並べ替え・`.only`・`-t` での絞り込みのいずれでも
    // 「投入されていない行を参照する」形で落ち、
    // **落ちた原因がスキーマなのか実行順なのかを、失敗した人が区別できない。**
    //
    // **`"userId"` という列名は2つの違うものを指す。** `User."userId"` は
    // ログイン識別子（`VARCHAR(30)`。`schema.prisma` では `loginId`）であり、
    // `RecoveryCode` / `Membership` / `ChannelMember` の `"userId"` は
    // `User."id"` への外部キー（`UUID`）である。**この SQL でも両方が出てくる。**
    await expectSqlToSucceed(`
      INSERT INTO "User" ("id", "userId", "displayName", "passwordHash") VALUES
        ('00000000-0000-7000-8000-000000000001', 'owner',    'オーナー',   'argon2id-placeholder'),
        ('00000000-0000-7000-8000-000000000002', 'insider',  '参加者',     'argon2id-placeholder'),
        ('00000000-0000-7000-8000-000000000003', 'outsider', '非参加者',   'argon2id-placeholder'),
        ('00000000-0000-7000-8000-000000000004', 'stranger', 'よその人',   'argon2id-placeholder'),
        -- **第2ワークスペースのオーナー。第1ワークスペースには参加していない。**
        -- これが無いと、可視性の条件から「所属ワークスペースが一致すること」だけを
        -- 落としても1件も落ちない（役割だけを見る書き間違いが素通りする）。
        ('00000000-0000-7000-8000-000000000005', 'other_owner', '別ワークスペースのオーナー', 'argon2id-placeholder');

      INSERT INTO "Workspace" ("id", "name") VALUES
        ('00000000-0000-7000-8000-0000000000a1', '第1ワークスペース'),
        ('00000000-0000-7000-8000-0000000000a2', '第2ワークスペース');

      INSERT INTO "Membership" ("id", "workspaceId", "userId", "role") VALUES
        ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000001', 'OWNER'),
        ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000002', 'MEMBER'),
        ('00000000-0000-7000-8000-0000000000b3', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000003', 'MEMBER'),
        ('00000000-0000-7000-8000-0000000000b4', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-000000000005', 'OWNER');

      INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility") VALUES
        ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-0000000000a1', 'general', 'general', 'PUBLIC'),
        ('00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-0000000000a1', 'secret',  'secret',  'PRIVATE'),
        -- 第2ワークスペースのチャンネル。**肯定側の固定に使う。**
        -- これが無いと、第2ワークスペースのオーナーを使う it が
        -- 「空であること」しか見ず、**前提データが消えても素通りで緑になる。**
        ('00000000-0000-7000-8000-0000000000c3', '00000000-0000-7000-8000-0000000000a2', 'their-secret', 'their-secret', 'PRIVATE');

      INSERT INTO "ChannelMember" ("id", "channelId", "workspaceId", "userId") VALUES
        ('00000000-0000-7000-8000-0000000000d1', '00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000002'),
        ('00000000-0000-7000-8000-0000000000d2', '00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000002');
    `);
    // 10 分。初回はイメージの取得が入る。
    //
    // **ci.yml の timeout-minutes（15）より小さくする。** あちらはジョブ全体に掛かる。
    // ここに大きい値を置くと、先に GitHub Actions がジョブごと打ち切り、
    // **Vitest のメッセージも junit レポートも残らない**（reports/ が無いので
    // 保存のステップも飛ぶ）。落ちた人が、イメージの取得で待たされたのか
    // 制約の検証で落ちたのかを区別できなくなる。
  }, 600_000);

  afterAll(async () => {
    await container?.stop();
  });

  describe('マイグレーションの適用', () => {
    it('6つのモデルの表がすべて作られている', async () => {
      const output = await expectSqlToSucceed(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name;`,
      );
      const tables = output.split('\n').filter((line) => line.length > 0);
      expect(tables).toEqual(
        expect.arrayContaining([
          'Channel',
          'ChannelMember',
          'Membership',
          'RecoveryCode',
          'User',
          'Workspace',
        ]),
      );
    });

    it('マイグレーションを適用した DB と schema.prisma に差が無い', () => {
      // **スキーマだけを直してマイグレーションを作り忘れる**のが、この種の
      // 変更で最も起きやすい取りこぼしである。両者を突き合わせて検出する。
      //
      // `--from-config-datasource` は prisma.config.ts の接続先、すなわち
      // 直前に migrate deploy を当てたコンテナを指す。
      // `--exit-code` は差があるときに 2 を返すため、execFileSync が例外を投げる。
      //
      // **この検査は検査制約・部分一意索引・式に対する索引（`lower(...)`）を見ない。**
      // Prisma がそれらをスキーマとして扱わないためである
      // （検査制約を消して確かめた。`User_userId_lower_key` を足しても差分は出ない）。
      // **手書きした制約は4つあり、その4つは下の各テストが個別に見ている。**
      // ここが通ったからといって、マイグレーションの手書き部分まで
      // 守られているわけではない。列挙は `schema.prisma` の冒頭と揃えてある。
      expect(() =>
        runPrisma(
          ['migrate', 'diff', '--from-config-datasource', '--to-schema', schemaPath, '--exit-code'],
          container.getConnectionUri(),
        ),
      ).not.toThrow();
      // 既定の 5 秒を使わない。**このテストだけが子プロセスを起こす。**
      // Node の起動・CLI の読み込み・DB の内省を含むため、CI の負荷次第で
      // 「スキーマとは無関係な理由で赤くなる」。
    }, 60_000);

    it('主キーが連番ではなく UUID である', async () => {
      // 連番を用いない（要件定義書 3.5.2）。**型が integer なら連番である。**
      // 値が UUIDv7 であることの保証は Prisma の `@default(uuid(7))` 側にあるため、
      // ここで見るのは列の型に留める。**型が uuid なら連番ではありえない。**
      const output = await expectSqlToSucceed(
        `SELECT c.table_name || ':' || c.data_type
         FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.column_name = 'id'
           -- Prisma 自身の適用履歴。これは我々のモデルではない。
           AND c.table_name <> '_prisma_migrations'
         ORDER BY c.table_name;`,
      );
      const types = output.split('\n').filter((line) => line.length > 0);
      expect(types).toHaveLength(6);
      for (const type of types) {
        expect(type).toMatch(/:uuid$/);
      }
    });
  });

  describe('一意制約', () => {
    /**
     * ユーザーID の一意性に違反したことを、**索引の作成順に依存せずに**確かめる。
     *
     * **綴りが完全に一致する重複は、2つの索引の両方に違反する**
     * （`User_userId_key` と `User_userId_lower_key`）。どちらの名前が返るかは
     * PostgreSQL が索引を走査する順、すなわち**索引の OID（作成順）**で決まる。
     * 今は `User_userId_key` が先に作られているというだけの理由で、その名前が返る。
     * **マイグレーションを整理して順序が入れ替わると、一意性は正しく効いているのに
     * このテストだけが落ちる。** 落ちた人が原因を取り違える。
     * （実測で確かめた。`lower` 索引を先に作ると `User_userId_lower_key` が返る。）
     *
     * **「一意制約違反であること」だけを見る形にはしない。** それだと
     * `id` の重複など**別の一意制約で落ちても緑になる。**
     * 見るのは「**ユーザーID の一意性に違反したこと**」までである。
     *
     * **同じ問題が他の it に無いことを確かめた。**
     * 一意索引の名前を期待しているのは、この関数を使う2件を除くと**9件**である。
     * **9件とも、違反しうる一意索引が1つしかない**ため、作成順に依存しない。
     *
     *   1. 大文字小文字だけが違うユーザーID … 綴りが一致しないので
     *      `User_userId_key`（既定の照合順序）には届かない
     *   2. 退会したユーザーID を綴りを変えて再利用 … 同上
     *   3. 二重の参加（`Membership`）… 役割が MEMBER なので
     *      `Membership_single_owner_per_workspace`（`role = 'OWNER'` の部分索引）に届かない
     *   4. オーナーが2人（`Membership`）… その利用者は当のワークスペースに参加がまだ無く、
     *      `Membership_workspaceId_userId_key` に届かない
     *   5. チャンネルへの二重の参加 … 他に重なる一意索引が無い
     *   6. 同じワークスペースに同じ名前のチャンネル … 同上（`id` は新しい値を使う）
     *   7. チャンネル名が長すぎる … 大きさで落ちるのは `name` を含む索引だけである。
     *      `Channel_id_workspaceId_key` は uuid 2つで、大きさの上限に届かない
     *   8. 未使用のリカバリーコードが2つ … 他に重なる一意索引が無い
     *   9. 同じ基底名に同じ採番を二度 … 落ちるのは名前の重複であり、
     *      **採番そのものには一意索引を置いていない**
     *
     * **外部キー（2件）と検査制約（4件）は、この問題の対象外である。**
     * 索引ではなく、名前が1つに定まる。
     */
    function expectUserIdUniquenessViolation(output: string): void {
      expect(output).toContain('duplicate key value violates unique constraint');
      expect(output).toMatch(/User_userId(_lower)?_key/);
    }

    it('ユーザーID は重複できない', async () => {
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('00000000-0000-7000-8000-0000000000ff', 'owner', '別人', 'argon2id-placeholder');`,
      );
      expectUserIdUniquenessViolation(output);
    });

    it('大文字小文字だけが違うユーザーID は登録できない', async () => {
      // ユーザーID の一意性は**大文字小文字を区別しない**（機能一覧 1.1）。
      // 区別すると `@owner` と `@Owner` が別人を指し、**メンションでは見分けがつかない。**
      // 既定の照合順序で作られる `User_userId_key` だけでは、これは止まらない。
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('${randomUUID()}', 'Owner', '大文字にした別人', 'argon2id-placeholder');`,
      );
      expect(output).toContain('User_userId_lower_key');
    });

    it('退会したユーザーID は、綴りを変えても再利用できない', async () => {
      // F-36 の「ユーザーID を再利用させない」が、綴り違いで抜けないことを見る。
      // **この it は自分の行を作る。** 他の it が退会させた行に相乗りすると、
      // 落ちた原因が実行順なのかスキーマなのかを、失敗した人が区別できない。
      await expectSqlToSucceed(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash", "deletedAt")
         VALUES ('${randomUUID()}', 'retired_user', '退会した人', 'argon2id-placeholder', now());`,
      );
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('${randomUUID()}', 'Retired_User', '後から来た人', 'argon2id-placeholder');`,
      );
      expect(output).toContain('User_userId_lower_key');
    });

    it('ユーザーID の長さの上限が列で効く', async () => {
      // 要件が数値で決めている上限（30文字。機能一覧 1.1）は列の型に入れてある。
      // **アプリ側の検証を1箇所書き漏らしても、DB が受け付けない。**
      const id = randomUUID();
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('${id}', '${'a'.repeat(31)}', '長すぎる', 'argon2id-placeholder');`,
      );
      expect(output).toContain('character varying(30)');
    });

    it('statusText の長さの上限が列で効く', async () => {
      // `userId` と**同じ理由・同じ扱い**で列の型に入れてある（100文字。機能一覧 1.3）。
      // **片方にしか検証が無いと、片方だけ列から外れても誰も気づけない。**
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash", "statusText")
         VALUES ('${randomUUID()}', 'long_status', 'ひとこと長すぎ', 'argon2id-placeholder', '${'あ'.repeat(101)}');`,
      );
      expect(output).toContain('character varying(100)');
    });

    it('退会したユーザーID も再利用できない', async () => {
      // 論理削除の行が残る以上、一意制約はそのまま効く。
      // **過去のメンションが別人を指すことを防ぐ**（機能一覧 1.5）。
      //
      // **この it は自分の行を作る。** `beforeAll` が入れた共有の行を退会させると、
      // その行を使う他の describe（可視性の検査）の前提が実行順で変わる。
      // **落ちた原因がスキーマなのか実行順なのかを、失敗した人が区別できなくなる。**
      await expectSqlToSucceed(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash", "deletedAt")
         VALUES ('${randomUUID()}', 'left_user', '退会した人', 'argon2id-placeholder', now());`,
      );
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('${randomUUID()}', 'left_user', '後から来た人', 'argon2id-placeholder');`,
      );
      expectUserIdUniquenessViolation(output);
    });

    it('同じワークスペースに同じ利用者を二重に参加させられない', async () => {
      const output = await expectSqlToFail(
        `INSERT INTO "Membership" ("id", "workspaceId", "userId", "role")
         VALUES ('00000000-0000-7000-8000-0000000000fd', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000002', 'MEMBER');`,
      );
      expect(output).toContain('Membership_workspaceId_userId_key');
    });

    it('1つのワークスペースにオーナーは1人しか置けない', async () => {
      const output = await expectSqlToFail(
        `INSERT INTO "Membership" ("id", "workspaceId", "userId", "role")
         VALUES ('00000000-0000-7000-8000-0000000000fc', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000004', 'OWNER');`,
      );
      expect(output).toContain('Membership_single_owner_per_workspace');
    });

    it('同じチャンネルに同じ利用者を二重に参加させられない', async () => {
      const output = await expectSqlToFail(
        `INSERT INTO "ChannelMember" ("id", "channelId", "workspaceId", "userId")
         VALUES ('00000000-0000-7000-8000-0000000000fb', '00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000002');`,
      );
      expect(output).toContain('ChannelMember_channelId_userId_key');
    });

    it('同じワークスペースに同じ名前のチャンネルは作れない', async () => {
      const output = await expectSqlToFail(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('00000000-0000-7000-8000-0000000000fa', '00000000-0000-7000-8000-0000000000a1', 'general', 'general', 'PRIVATE');`,
      );
      expect(output).toContain('Channel_workspaceId_name_key');
    });

    it('別のワークスペースなら同じ名前のチャンネルを作れる', async () => {
      // 一意制約がワークスペース単位であることの裏返し。
      // これが無いと「一意制約が効いた」だけで、**範囲が広すぎても気づけない。**
      await expectSqlToSucceed(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('00000000-0000-7000-8000-0000000000f9', '00000000-0000-7000-8000-0000000000a2', 'general', 'general', 'PUBLIC');`,
      );
    });

    it('チャンネル名の事実上の上限は、文字数では決まらない', async () => {
      // **チャンネル名に数値の上限は決めていない**（機能一覧 3.1）。
      // しかし「上限が無い」わけではない。この列は一意索引
      // `Channel_workspaceId_name_key`（B-tree）に載っており、
      // **B-tree の索引タプルには約 2704 バイトの上限がある。**
      //
      // **ただし、その上限に当たるのは圧縮後の大きさである。**
      // 索引タプルの値は行の外に出せない（TOAST できない）が、インラインでの圧縮は効く。
      // よって**同じ文字数でも、通るか落ちるかが中身で変わる。**
      // この it が2つを並べて確かめるのは、`schema.prisma` の name のコメントが
      // 「事実上の上限はあるが、文字数では表せない」と書いているためである。
      // **書いただけで確かめないと、記述だけが古くなる。**
      const workspace = '00000000-0000-7000-8000-0000000000a2';

      // 圧縮がよく効く 6000 文字。**通る。**
      const compressible = 'x'.repeat(6000);
      await expectSqlToSucceed(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('${randomUUID()}', '${workspace}', '${compressible}', '${compressible}', 'PUBLIC');`,
      );

      // 同じ 6000 文字でも、圧縮の効かない乱数なら**落ちる。**
      const incompressible = randomBytes(3000).toString('hex');
      const output = await expectSqlToFail(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('${randomUUID()}', '${workspace}', '${incompressible}', '${incompressible}', 'PUBLIC');`,
      );
      // 失敗の理由が「索引タプルの大きさ」であることまで見る。
      // **別の制約で落ちて緑になるのを防ぐ。**
      expect(output).toContain('index row size');
      expect(output).toContain('Channel_workspaceId_name_key');
    });

    it('索引の上限すれすれの名前のチャンネルは、アーカイブできない', async () => {
      // **アーカイブは名前を `baseName-<採番>` に変える。** 数バイト伸びるため、
      // **INSERT は通るのにアーカイブの UPDATE だけが落ちる名前**が存在する。
      // 改名の機能は無いため、**そのチャンネルは永久にアーカイブできない**
      // （F-35 は Must）。これは `archiveSequence` が `MAX + 1` を却下した理由と
      // まったく同じ形の失敗である。**採番の側は却下してテストで固定したのに、
      // 名前の長さの側は記述だけで止まっていた。**
      //
      // よって**アプリ側の上限は、接尾辞を付けても索引タプルに収まる長さで
      // 決めなければならない**（機能一覧 3.1）。
      const workspaceForLimit = '00000000-0000-7000-8000-0000000000a2';

      // **上限の数値を焼き付けない。** 索引タプルの上限は版で変わりうる。
      // 入る最大の長さを実際に探す（乱数の16進なので圧縮は効かない）。
      let id: string | undefined;
      for (let length = 2800; id === undefined; length -= 2) {
        expect(length, '索引に収まる名前が見つからない').toBeGreaterThan(0);
        const candidate = randomBytes(length / 2).toString('hex');
        const candidateId = randomUUID();
        const { exitCode } = await psql(
          `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
           VALUES ('${candidateId}', '${workspaceForLimit}', '${candidate}', '${candidate}', 'PUBLIC');`,
        );
        if (exitCode === 0) id = candidateId;
      }

      // これ以上長くはできない。**接尾辞 `-1` を足す余地が無い。**
      const output = await expectSqlToFail(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '${id}';`,
      );
      expect(output).toContain('index row size');
      expect(output).toContain('Channel_workspaceId_name_key');
    }, 60_000);

    /**
     * リカバリーコードの検査は、いずれも**自分の利用者を作ってから**行う。
     *
     * 固定データの利用者を使い回すと、**前の `it` が入れた行を次の `it` が更新する**形になり、
     * 単独で走らせたときに `UPDATE` が0行に一致して**素通りで緑になる**
     * （psql は0行の更新を成功として返す）。制約を一度も踏まないまま通る。
     */
    async function createUserWithUnusedCode(): Promise<{ userId: string; codeId: string }> {
      const userId = randomUUID();
      const codeId = randomUUID();
      await expectSqlToSucceed(`
        INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
          VALUES ('${userId}', 'u-${userId.slice(0, 8)}', '検査用', 'argon2id-placeholder');
        INSERT INTO "RecoveryCode" ("id", "userId", "codeHash")
          VALUES ('${codeId}', '${userId}', 'argon2id-placeholder');
      `);
      return { userId, codeId };
    }

    it('未使用のリカバリーコードは1人につき1つしか持てない', async () => {
      const { userId } = await createUserWithUnusedCode();
      const output = await expectSqlToFail(
        `INSERT INTO "RecoveryCode" ("id", "userId", "codeHash")
         VALUES ('${randomUUID()}', '${userId}', 'argon2id-placeholder-2');`,
      );
      expect(output).toContain('RecoveryCode_single_unused_per_user');
    });

    it('未使用のリカバリーコードは、利用者ごとに1つずつ持てる', async () => {
      // **この制約は「1人につき1つ」であって「システム全体で1つ」ではない。**
      // 同じ利用者で重複を試すだけでは、索引の定義から "userId" が落ちても気づけない。
      // チャンネル名の一意制約に「別のワークスペースなら作れる」を置いたのと同じ理由で、
      // **範囲が広すぎても落ちる形にする。**
      await createUserWithUnusedCode();
      await createUserWithUnusedCode();
    });

    it('使用済みにすれば新しいリカバリーコードを発行できる', async () => {
      // 「再設定の完了時に新しいコードを発行する」（機能一覧 1.1）が
      // 上の制約と両立することを見る。**古いコードを無効にしない限り新しく出せない。**
      const { userId, codeId } = await createUserWithUnusedCode();
      await expectSqlToSucceed(
        `UPDATE "RecoveryCode" SET "usedAt" = now() WHERE "id" = '${codeId}';`,
      );
      await expectSqlToSucceed(
        `INSERT INTO "RecoveryCode" ("id", "userId", "codeHash")
         VALUES ('${randomUUID()}', '${userId}', 'argon2id-placeholder-2');`,
      );
    });
  });

  describe('ワークスペース参加との整合', () => {
    /**
     * **チャンネル参加は、ワークスペース参加の上にしか成り立たない。**
     *
     * `ChannelMember` を可視性の根拠にする以上、ワークスペースから外れた利用者の行が
     * 残ってはならない。残ると、**キックされた利用者がプライベートチャンネルを
     * 読み続けられる**（機能一覧 2.2「所属していた全チャンネルから自動的に外れる」
     * 「そのワークスペースのデータに一切アクセスできなくなる」）。
     *
     * アプリ側の実装に委ねず、複合外部キーで DB に守らせる。
     */

    /** このブロック専用のワークスペースと利用者を作る。他のテストの行を触らない。 */
    async function createWorkspaceWithMember(): Promise<{
      workspaceId: string;
      userId: string;
      channelId: string;
    }> {
      const workspaceId = randomUUID();
      const userId = randomUUID();
      const channelId = randomUUID();
      const name = `ch-${channelId.slice(0, 8)}`;
      await expectSqlToSucceed(`
        INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
          VALUES ('${userId}', 'u-${userId.slice(0, 8)}', '検査用', 'argon2id-placeholder');
        INSERT INTO "Workspace" ("id", "name") VALUES ('${workspaceId}', '検査用ワークスペース');
        INSERT INTO "Membership" ("id", "workspaceId", "userId", "role")
          VALUES ('${randomUUID()}', '${workspaceId}', '${userId}', 'OWNER');
        INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
          VALUES ('${channelId}', '${workspaceId}', '${name}', '${name}', 'PRIVATE');
      `);
      return { workspaceId, userId, channelId };
    }

    it('ワークスペースに参加していない利用者はチャンネルに参加できない', async () => {
      // 機能一覧 2.2「プライベートチャンネルへの招待で、ワークスペース外の利用者は
      // 指定できない」を、DB が受け入れない形にする。
      const { workspaceId, channelId } = await createWorkspaceWithMember();
      const outsiderId = randomUUID();
      await expectSqlToSucceed(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('${outsiderId}', 'u-${outsiderId.slice(0, 8)}', 'よその人', 'argon2id-placeholder');`,
      );
      const output = await expectSqlToFail(
        `INSERT INTO "ChannelMember" ("id", "channelId", "workspaceId", "userId")
         VALUES ('${randomUUID()}', '${channelId}', '${workspaceId}', '${outsiderId}');`,
      );
      expect(output).toContain('ChannelMember_workspaceId_userId_fkey');
    });

    it('ワークスペースからキックすると、チャンネル参加も消える', async () => {
      const { workspaceId, userId, channelId } = await createWorkspaceWithMember();
      await expectSqlToSucceed(
        `INSERT INTO "ChannelMember" ("id", "channelId", "workspaceId", "userId")
         VALUES ('${randomUUID()}', '${channelId}', '${workspaceId}', '${userId}');`,
      );
      // キック・退出は Membership の削除である。
      await expectSqlToSucceed(
        `DELETE FROM "Membership" WHERE "workspaceId" = '${workspaceId}' AND "userId" = '${userId}';`,
      );
      const remaining = await expectSqlToSucceed(
        `SELECT count(*) FROM "ChannelMember" WHERE "userId" = '${userId}';`,
      );
      expect(remaining).toBe('0');
    });

    it('チャンネルと食い違うワークスペースの組み合わせは入れられない', async () => {
      // workspaceId を持たせた以上、**チャンネルの所属と食い違う値**を入れられては
      // 意味がない。食い違うと、上のキックの連鎖が別のワークスペースに向かう。
      const first = await createWorkspaceWithMember();
      const second = await createWorkspaceWithMember();
      const output = await expectSqlToFail(
        `INSERT INTO "ChannelMember" ("id", "channelId", "workspaceId", "userId")
         VALUES ('${randomUUID()}', '${first.channelId}', '${second.workspaceId}', '${second.userId}');`,
      );
      expect(output).toContain('ChannelMember_channelId_workspaceId_fkey');
    });
  });

  describe('チャンネルのアーカイブと名前の採番', () => {
    const workspace = '00000000-0000-7000-8000-0000000000a1';

    /**
     * このブロック専用のチャンネルを作る。
     *
     * **各テストが自分の行だけを触る。** 直前の `it` の副作用に頼ると、
     * `.only` や `-t` で1件だけ走らせたときに、投入されていない行を参照して落ちる。
     * **落ちた原因がスキーマなのか実行順なのかを、失敗した人が区別できない。**
     */
    async function createChannel(name: string): Promise<string> {
      const id = randomUUID();
      await expectSqlToSucceed(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('${id}', '${workspace}', '${name}', '${name}', 'PUBLIC');`,
      );
      return id;
    }

    it('採番せずにアーカイブできない', async () => {
      // **改名がアーカイブと不可分であることを、DB の検査制約で担保する。**
      // アプリ側の実装に委ねると、片方だけ実行した状態が作れてしまう。
      const id = await createChannel('arch-a');
      const output = await expectSqlToFail(
        `UPDATE "Channel" SET "archivedAt" = now() WHERE "id" = '${id}';`,
      );
      expect(output).toContain('Channel_archive_naming_check');
    });

    it('改名だけはできない', async () => {
      // 機能一覧 3.2 は「アーカイブだけ・採番だけ・改名だけ、のいずれも成立しない」と
      // 3つを並べている。**「改名だけ」を見るのはこの it だけである。**
      //
      // 検査制約の `CASE` の `THEN` 側（採番が無いなら name = baseName）に
      // **拒否する側として届く経路は、ここしかない。** 他の it は
      // `archiveSequence` を渡すため必ず `ELSE` 側に入り、
      // **`THEN` を `TRUE` に置き換えても1件も落ちない。**
      const id = await createChannel('arch-rename-only');
      const output = await expectSqlToFail(
        `UPDATE "Channel" SET "name" = 'arch-rename-only-renamed' WHERE "id" = '${id}';`,
      );
      expect(output).toContain('Channel_archive_naming_check');
    });

    it('改名せずにアーカイブできない', async () => {
      const id = await createChannel('arch-b');
      const output = await expectSqlToFail(
        `UPDATE "Channel" SET "archivedAt" = now(), "archiveSequence" = 1 WHERE "id" = '${id}';`,
      );
      expect(output).toContain('Channel_archive_naming_check');
    });

    it('採番だけ変えて改名しないことはできない', async () => {
      // 「アーカイブしていないのに採番できない」ではない。
      // **復元した行は、現役のまま採番を持ち続ける。** 禁じているのは
      // 採番と名前が食い違うことであって、現役の行が採番を持つことではない。
      const id = await createChannel('arch-c');
      const output = await expectSqlToFail(
        `UPDATE "Channel" SET "archiveSequence" = 1 WHERE "id" = '${id}';`,
      );
      expect(output).toContain('Channel_archive_naming_check');
    });

    it('アーカイブと採番と改名を同時に行えば通り、同じ名前で作り直せる', async () => {
      const id = await createChannel('arch-d');
      await expectSqlToSucceed(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '${id}';`,
      );
      // アーカイブ済みの名前は arch-d-1 になったので、arch-d が空く。
      await createChannel('arch-d');
    });

    it('復元しても名前と採番が保たれる', async () => {
      // **承認済みの決定は「復元しても番号は外れない」**（機能一覧 3.2）。
      //
      // 検査制約を archivedAt で場合分けすると、復元が
      // 「採番を外して名前を baseName に戻すこと」まで要求してしまい、
      // **作り直した同名のチャンネルと衝突して復元そのものができなくなる。**
      // このテストが無いと、その矛盾が誰にも見えないまま土台に残る。
      const id = await createChannel('arch-e');
      await expectSqlToSucceed(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '${id}';`,
      );
      await createChannel('arch-e');

      await expectSqlToSucceed(`UPDATE "Channel" SET "archivedAt" = NULL WHERE "id" = '${id}';`);
      const output = await expectSqlToSucceed(
        `SELECT "name" || ':' || "baseName" || ':' || "archiveSequence"
         FROM "Channel" WHERE "id" = '${id}';`,
      );
      expect(output).toBe('arch-e-1:arch-e:1');
    });

    it('復元したチャンネルを再びアーカイブしても、名前と採番は変わらない', async () => {
      // **既に採番を持つ行を再アーカイブするときは、採番も改名も行わない。**
      //
      // 採番の規則（名前が空いている最小の番号）をそのまま当てると、
      // **自分自身が arch-h-1 を占有しているため 2 が選ばれ、名前が arch-h-2 に変わる。**
      // アーカイブと復元を繰り返すたびに番号が進み、名前がずれ続ける。
      // 「復元しても番号は外れない」（機能一覧 3.2）と読み合わせが取れない。
      //
      // **検査制約はこれを止めない。** 据え置きも採番し直しも、どちらも通る。
      // 規則を文書とテストの両方に置かないと、実装側で決まってしまう。
      const id = await createChannel('arch-h');
      const archive = `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '${id}';`;
      await expectSqlToSucceed(archive);
      await expectSqlToSucceed(`UPDATE "Channel" SET "archivedAt" = NULL WHERE "id" = '${id}';`);

      // 再アーカイブ。**採番と名前には触れない。**
      await expectSqlToSucceed(`UPDATE "Channel" SET "archivedAt" = now() WHERE "id" = '${id}';`);
      const output = await expectSqlToSucceed(
        `SELECT "name" || ':' || "archiveSequence" FROM "Channel" WHERE "id" = '${id}';`,
      );
      expect(output).toBe('arch-h-1:1');
    });

    it('同じ基底名に同じ採番を二度使えない', async () => {
      const first = await createChannel('arch-f');
      await expectSqlToSucceed(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '${first}';`,
      );
      const second = await createChannel('arch-f');
      // 1 は arch-f-1 が使っている。
      //
      // **採番そのものに一意制約は置いていない。** 検査制約により
      // 名前は `baseName-<採番>` に決まるため、
      // **採番が重複すれば名前が必ず重複する。** 名前の一意制約が同じことを担保する。
      const output = await expectSqlToFail(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '${second}';`,
      );
      expect(output).toContain('Channel_workspaceId_name_key');
    });

    /**
     * 次の採番を求める問い合わせ。
     *
     * **「MAX(archiveSequence) + 1」ではない。** チャンネル名に制限は無いため、
     * 利用者が自分で `arch-g-1` という名前を付けられる。その状態で `arch-g` を
     * アーカイブすると、MAX + 1 では 1 を選び、**名前が衝突してアーカイブ自体が失敗する。**
     * 改名の機能は無いため、そのチャンネルは**永久にアーカイブできない**状態になる。
     * F-35 は Must であり、これは受け入れられない。
     *
     * よって「**その基底名で、名前がまだ空いている最小の番号**」と定義する。
     * 探索の上限をワークスペース内のチャンネル数 + 1 に取れるのは、
     * **N 件のチャンネルが塞げる名前は高々 N 個**だからである。
     *
     * ## 実装に写すときは、必ずパラメータ化すること
     *
     * ここで確かめているのは**番号の選び方**であって、値の渡し方ではない。
     * 下の連結は、**このテストが固定の文字列しか渡さないから**成立している。
     *
     * **`baseName` は利用者が自由に付けたチャンネル名であり、`'` を含められる**
     * （機能一覧 3.1 に名前の制限は無い）。この形のまま `$queryRaw` に移すと
     * **SQL インジェクションの経路になる**（REVIEW.md 3 / CWE-89）。
     * 実装では `baseName` と `workspaceId` をプレースホルダとして渡すこと。
     */
    function nextArchiveSequence(baseName: string): string {
      return `
        SELECT COALESCE(MIN(s.n), 1)
        FROM generate_series(
          1,
          (SELECT count(*) + 1 FROM "Channel" WHERE "workspaceId" = '${workspace}')
        ) AS s(n)
        WHERE NOT EXISTS (
          SELECT 1 FROM "Channel" c
          WHERE c."workspaceId" = '${workspace}'
            AND c."name" = '${baseName}' || '-' || s.n
        );
      `;
    }

    it('利用者が先に「基底名-1」を作っていても、アーカイブできる', async () => {
      const id = await createChannel('arch-g');
      // **利用者が自分で付けられる名前である。** 禁止していない。
      await createChannel('arch-g-1');

      const next = await expectSqlToSucceed(nextArchiveSequence('arch-g'));
      expect(next).toBe('2');

      await expectSqlToSucceed(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = ${next}, "name" = "baseName" || '-${next}'
         WHERE "id" = '${id}';`,
      );
    });
  });

  describe('プライベートチャンネルの可視性', () => {
    /**
     * 「その利用者に見えるチャンネル」を求める問い合わせ。
     *
     * **これがプライベートチャンネルの可視性の根拠である**（CLAUDE.md 2）。
     * 画面で隠すのではなく、参加の有無（ChannelMember）で機械的に決まる。
     *
     * **このテストが守る範囲を正確に書く。** ここで確かめているのは
     * 「**この形の問い合わせなら漏れない**」ことであって、
     * 「API がこの形の問い合わせを使う」ことではない。API はまだ存在しない。
     * **API を実装する PR は、この形に乗っていることを自分のテストで示す必要がある**
     * （要件定義書 4.8 の「必ずテストを書く箇所」1・8）。
     *
     * **判定しているのは「取得してよいか」であって「一覧に出すか」ではない。**
     * アーカイブ済みのチャンネルは、**参加者は読めるが一覧からは外れる**
     * （機能一覧 3.2）。**一覧の API は、この条件に加えて `AND c."archivedAt" IS NULL`
     * が要る。** この形をそのまま一覧に写すと、アーカイブ済みが一覧に出る。
     *
     * **参加者一覧の経路には、この条件を使わない。** 機能一覧 3.1 は
     * 「**オーナーは、参加していないプライベートチャンネルの参加者一覧は取得できる**」
     * と定めている（REVIEW.md 2.1 も同じ境界）。この問い合わせは
     * `ChannelMember` に行が無いオーナーにチャンネル行そのものを返さないため、
     * **そのまま参加者一覧に写すとオーナーに 404 が返る。**
     * そうなると「誰がいるか見えなければキックすべき相手を特定できない」に当たり、
     * **F-09 の管理者権限が機能しなくなる。**
     * 参加者一覧を取得できるのは、次の**どちらか**である。
     *
     *   - **そのチャンネルの参加者**（`ChannelMember` に行がある）
     *   - **そのワークスペースのオーナー**（`Membership.role = 'OWNER'`）
     *
     * **オーナーだけにしないこと。** オーナー専用の経路として実装すると、
     * **参加者本人が、自分が参加しているチャンネルの参加者一覧を取得できない。**
     * オーナーは「参加していなくても取得できる」という**例外の側**であって、
     * 条件そのものではない。
     * **境界は「人の出入りの管理」と「会話の閲覧」の間に引く。**
     *
     * **この形をそのまま写さないこと。** ここは固定の文字列を連結しているが、
     * **`workspaceId` は URL のパスパラメータ由来である**（機能一覧 2.1 の
     * 「所属していないワークスペースの情報は取得できない」の判定対象そのもの）。
     * `$queryRaw` へそのまま写した時点で注入経路になる。
     * **実装では `workspaceId` も `userId` もプレースホルダとして渡す**
     * （REVIEW.md 3 / CWE-89）。写してよいのは**条件の形**であって、
     * 値の埋め込み方ではない。`nextArchiveSequence` にも同じ注意がある。
     */
    function visibleChannels(userId: string, workspaceId: string): string {
      return `
        SELECT c."name"
        FROM "Channel" c
        -- ワークスペースに参加していること自体を条件にする。
        -- ここを外すと、退出・キックされた利用者にチャンネルが見え続ける。
        JOIN "Membership" m
          ON m."workspaceId" = c."workspaceId" AND m."userId" = '${userId}'
        LEFT JOIN "ChannelMember" cm
          ON cm."channelId" = c."id" AND cm."userId" = '${userId}'
        WHERE c."workspaceId" = '${workspaceId}'
          AND (c."visibility" = 'PUBLIC' OR cm."userId" IS NOT NULL)
        ORDER BY c."name";
      `;
    }

    const workspace = '00000000-0000-7000-8000-0000000000a1';
    const owner = '00000000-0000-7000-8000-000000000001';
    const insider = '00000000-0000-7000-8000-000000000002';
    const outsider = '00000000-0000-7000-8000-000000000003';
    const stranger = '00000000-0000-7000-8000-000000000004';
    // 第2ワークスペースのオーナー。**第1ワークスペースには参加していない。**
    const otherWorkspaceOwner = '00000000-0000-7000-8000-000000000005';
    // 第2ワークスペースのプライベートチャンネル。
    const otherWorkspaceChannel = '00000000-0000-7000-8000-0000000000c3';

    it('参加者にはプライベートチャンネルが見える', async () => {
      const output = await expectSqlToSucceed(visibleChannels(insider, workspace));
      expect(output.split('\n')).toContain('secret');
    });

    it('参加していないメンバーにはプライベートチャンネルが見えない', async () => {
      const output = await expectSqlToSucceed(visibleChannels(outsider, workspace));
      expect(output.split('\n')).not.toContain('secret');
      // パブリックは見えていること。見えない実装でもこのテストは通ってしまうため、
      // **「何も見えない」で通過しないことを併せて確かめる。**
      expect(output.length).toBeGreaterThan(0);
    });

    it('オーナーでも、参加していないプライベートチャンネルの中身は見えない', async () => {
      // 要件定義書 3.5.1 / 4.4。オーナーの権限は**人の出入りの管理**であって
      // **会話の閲覧ではない**。この境界がデータの側で守られていることを見る。
      //
      // **見えないのはチャンネルの中身までである。** 参加者一覧は取得できる
      // （機能一覧 3.1）。その経路はこの問い合わせを使わない（上の説明を参照）。
      const output = await expectSqlToSucceed(visibleChannels(owner, workspace));
      expect(output.split('\n')).not.toContain('secret');
      expect(output.length).toBeGreaterThan(0);
    });

    it('ワークスペースに参加していない利用者には何も見えない', async () => {
      const output = await expectSqlToSucceed(visibleChannels(stranger, workspace));
      expect(output).toBe('');
    });

    /**
     * 「その利用者が、そのチャンネルの**参加者一覧**を取得してよいか」を求める問い合わせ。
     *
     * **`visibleChannels` とは条件が違う。** あちらは「チャンネルの中身を取得してよいか」
     * であり、オーナーであっても参加していなければ通さない。
     * こちらは**オーナーを通す**（機能一覧 3.1 / REVIEW.md 2.1）。
     * **境界は「人の出入りの管理」と「会話の閲覧」の間に引く。**
     * 誰がいるか見えなければキックすべき相手を特定できず、F-09 が機能しない。
     *
     * **散文で書いた条件を、ここで固定する。** すぐ上の
     * `visibleChannels` の説明は「参加者 または オーナー」と書いているが、
     * **書いただけでは、片側だけの実装に書き換えても1件も落ちない。**
     * 誤りは2方向にある。**両方を別々の `it` で押さえる。**
     *
     *   - オーナー専用にする → **参加者本人が自分のチャンネルの一覧を引けない**
     *   - 参加者だけにする   → **オーナーが F-09 を行使できない**
     *   - 全員に開ける       → 非参加者にも参加者一覧が漏れる
     *
     * **この形をそのまま写さないこと。** `channelId` は URL のパスパラメータ由来である。
     * 実装では `channelId` も `userId` もプレースホルダとして渡す
     * （REVIEW.md 3 / CWE-89）。`visibleChannels` / `nextArchiveSequence` と同じ扱いである。
     */
    function channelMemberViewers(userId: string, channelId: string): string {
      return `
        SELECT c."id"
        FROM "Channel" c
        -- ワークスペースに参加していること自体を条件にする。
        -- 外すと、退出・キックされた利用者に参加者一覧が見え続ける。
        JOIN "Membership" m
          ON m."workspaceId" = c."workspaceId" AND m."userId" = '${userId}'
        LEFT JOIN "ChannelMember" cm
          ON cm."channelId" = c."id" AND cm."userId" = '${userId}'
        WHERE c."id" = '${channelId}'
          -- 参加者、**または**そのワークスペースのオーナー。
          -- オーナーは例外の側であって、条件そのものではない。
          AND (cm."userId" IS NOT NULL OR m."role" = 'OWNER');
      `;
    }

    // beforeAll が入れているチャンネル。どちらも参加者は insider だけである。
    const secretChannel = '00000000-0000-7000-8000-0000000000c2';
    const publicChannel = '00000000-0000-7000-8000-0000000000c1';

    it('参加者は、そのチャンネルの参加者一覧を取得できる', async () => {
      const output = await expectSqlToSucceed(channelMemberViewers(insider, secretChannel));
      expect(output).toBe(secretChannel);
    });

    it('参加していないオーナーでも、参加者一覧は取得できる', async () => {
      // **中身は見えないが、人の出入りは管理できる。** すぐ上の
      // 「オーナーでも、参加していないプライベートチャンネルの中身は見えない」と対になる。
      const output = await expectSqlToSucceed(channelMemberViewers(owner, secretChannel));
      expect(output).toBe(secretChannel);
    });

    it('参加していないメンバーは、参加者一覧を取得できない', async () => {
      // **これが無いと「全員に開ける」実装でも緑になる。**
      const output = await expectSqlToSucceed(channelMemberViewers(outsider, secretChannel));
      expect(output).toBe('');
    });

    it('ワークスペースの外の利用者は、参加者一覧を取得できない', async () => {
      const output = await expectSqlToSucceed(channelMemberViewers(stranger, secretChannel));
      expect(output).toBe('');
    });

    it('ワークスペースの外の利用者は、パブリックチャンネルの参加者一覧も取得できない', async () => {
      // **拒否のコードは2段階で決まる**（機能一覧 3.1）。
      // 「所属しているが非参加者」は種別で 403 / 404 に分かれるが、
      // **ワークスペースに所属していない利用者は、種別によらず 404 である**（機能一覧 2.1）。
      // ここを種別だけで決めると、**パブリックチャンネルの存在と
      // `channelId` が有効であることが 403 として外部に漏れる。**
      const output = await expectSqlToSucceed(channelMemberViewers(stranger, publicChannel));
      expect(output).toBe('');
    });

    it('パブリックチャンネルでも、参加していないメンバーは参加者一覧を取得できない', async () => {
      // **この条件は `visibility` を見ない**（機能一覧 3.1 の但し書き）。
      // 決まっていなかったことを**閉じる側に倒した**記録であり、
      // 開ける側は機能を1つ増やすため、提案と承認の手順が要る。
      //
      // **この it が無いと、後から `c."visibility" = 'PUBLIC' OR` を足して
      // 緩めても1件も落ちない。** 承認を経ない変更が静かに通るのを防ぐ。
      const output = await expectSqlToSucceed(channelMemberViewers(outsider, publicChannel));
      expect(output).toBe('');
    });

    it('パブリックチャンネルの参加者は、参加者一覧を取得できる', async () => {
      // 上の it だけだと、**パブリックを一律で閉じる実装でも緑になる。**
      const output = await expectSqlToSucceed(channelMemberViewers(insider, publicChannel));
      expect(output).toBe(publicChannel);
    });

    /**
     * オーナー向けの**管理のためのチャンネル一覧**（機能一覧 3.1。2026-09-05 決定）。
     *
     * **`visibleChannels` とは別の経路である。** あちらは「会話を取得してよいか」で、
     * 参加していないオーナーにはプライベートチャンネルを返さない。
     * こちらは**存在と名前だけを返す。** これが無いと、オーナーは
     * 参加者一覧を取得する権限を持ちながら **`channelId` を知る手段が1つも無い。**
     *
     * **返すものは名前までである。** メッセージ・添付は返さない。
     * 境界は `visibleChannels` と同じく「人の出入りの管理」と「会話の閲覧」の間にある。
     *
     * **`archivedAt` で絞ってはならない。** 兄弟の `visibleChannels` には
     * 「一覧の API はこの条件に加えて `AND c."archivedAt" IS NULL` が要る」と書いてあるが、
     * **こちらにそれを写すと、オーナーはアーカイブ済みチャンネルの `id` を知る手段を失い、
     * 「オーナーが復元できる」（F-35。Must）が成立しなくなる。**
     * 一貫性のつもりで隣の注意書きを写すのが、最も起きやすい壊し方である。
     * 下の `it` がこれを固定している。
     *
     * **この形をそのまま写さないこと。** `workspaceId` は URL のパスパラメータ由来である。
     * 実装ではプレースホルダとして渡す（REVIEW.md 3 / CWE-89）。
     */
    function manageableChannels(userId: string, workspaceId: string): string {
      return `
        SELECT c."name"
        FROM "Channel" c
        JOIN "Membership" m
          ON m."workspaceId" = c."workspaceId" AND m."userId" = '${userId}'
        WHERE c."workspaceId" = '${workspaceId}'
          AND m."role" = 'OWNER'
        ORDER BY c."name";
      `;
    }

    it('オーナーには、参加していないプライベートチャンネルも一覧に出る', async () => {
      // **これが無いと F-09 が成立しない。** 参加者一覧を取得する権限があっても、
      // チャンネルの id を知る手段が無ければ行使できない。
      const output = await expectSqlToSucceed(manageableChannels(owner, workspace));
      expect(output.split('\n')).toContain('secret');
    });

    it('オーナーには、アーカイブ済みのチャンネルも管理の一覧に出る', async () => {
      // **これが無いと F-35 の「オーナーが復元できる」が成立しない。**
      // アーカイブすると一覧から外れる以上、管理の一覧まで `archivedAt IS NULL` で
      // 絞ると、**復元すべきチャンネルの id を知る経路が1つも無くなる。**
      // この it は `AND c."archivedAt" IS NULL` を足した瞬間に落ちる。
      const id = randomUUID();
      await expectSqlToSucceed(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('${id}', '${workspace}', 'to-archive', 'to-archive', 'PUBLIC');`,
      );
      // アーカイブ・採番・改名は同時に行う（検査制約）。
      await expectSqlToSucceed(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '${id}';`,
      );
      const output = await expectSqlToSucceed(manageableChannels(owner, workspace));
      expect(output.split('\n')).toContain('to-archive-1');
    });

    it('オーナーでないメンバーには、管理の一覧が1件も返らない', async () => {
      // **オーナー専用の経路であることを固定する。**
      // これが無いと、`m."role" = 'OWNER'` を落としても1件も落ちない。
      const output = await expectSqlToSucceed(manageableChannels(insider, workspace));
      expect(output).toBe('');
    });

    it('別のワークスペースのオーナーには、管理の一覧が1件も返らない', async () => {
      const output = await expectSqlToSucceed(manageableChannels(otherWorkspaceOwner, workspace));
      expect(output).toBe('');
    });

    it('第2ワークスペースのオーナーは、自分のワークスペースでは参加者一覧を取得できる', async () => {
      // **下の2件（空を期待する側）と対になる肯定側の固定である。**
      // これが無いと、`b4` の `Membership` が落ちても UUID が1文字ずれても、
      // 下の2件は空を返して**緑のまま**になり、
      // 「所属ワークスペースが一致すること」を守っているつもりの2件が
      // **何も守らない状態に静かに落ちる。**
      const output = await expectSqlToSucceed(
        channelMemberViewers(otherWorkspaceOwner, otherWorkspaceChannel),
      );
      expect(output).toBe(otherWorkspaceChannel);
    });

    it('別のワークスペースのオーナーには、参加者一覧が見えない', async () => {
      // **「所属ワークスペースが一致すること」を落としても落ちるようにする。**
      // これが無いと、条件から `m."workspaceId" = c."workspaceId"` だけを外しても
      // 1件も落ちない。**役割だけを見る書き間違い**が素通りする形になり、
      // **どこか1つのワークスペースのオーナーが、他人のワークスペースの
      // プライベートチャンネルの参加者一覧を取得できる**（機能一覧 2.1）。
      const output = await expectSqlToSucceed(
        channelMemberViewers(otherWorkspaceOwner, secretChannel),
      );
      expect(output).toBe('');
    });

    it('別のワークスペースのオーナーには、チャンネルが1つも見えない', async () => {
      // `visibleChannels` 側も同じ形の書き間違いを起こしうる。
      // **パブリックチャンネルまで見えてしまう**ため、こちらも押さえる。
      const output = await expectSqlToSucceed(visibleChannels(otherWorkspaceOwner, workspace));
      expect(output).toBe('');
    });
  });
});
