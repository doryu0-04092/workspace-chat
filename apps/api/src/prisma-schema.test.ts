import { execFileSync } from 'node:child_process';
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
    await expectSqlToSucceed(`
      INSERT INTO "User" ("id", "userId", "displayName", "passwordHash") VALUES
        ('00000000-0000-7000-8000-000000000001', 'owner',    'オーナー',   'argon2id-placeholder'),
        ('00000000-0000-7000-8000-000000000002', 'insider',  '参加者',     'argon2id-placeholder'),
        ('00000000-0000-7000-8000-000000000003', 'outsider', '非参加者',   'argon2id-placeholder'),
        ('00000000-0000-7000-8000-000000000004', 'stranger', 'よその人',   'argon2id-placeholder');

      INSERT INTO "Workspace" ("id", "name") VALUES
        ('00000000-0000-7000-8000-0000000000a1', '第1ワークスペース'),
        ('00000000-0000-7000-8000-0000000000a2', '第2ワークスペース');

      INSERT INTO "Membership" ("id", "workspaceId", "userId", "role") VALUES
        ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000001', 'OWNER'),
        ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000002', 'MEMBER'),
        ('00000000-0000-7000-8000-0000000000b3', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000003', 'MEMBER');

      INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility") VALUES
        ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-0000000000a1', 'general', 'general', 'PUBLIC'),
        ('00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-0000000000a1', 'secret',  'secret',  'PRIVATE');

      INSERT INTO "ChannelMember" ("id", "channelId", "userId") VALUES
        ('00000000-0000-7000-8000-0000000000d1', '00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-000000000002'),
        ('00000000-0000-7000-8000-0000000000d2', '00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-000000000002');
    `);
    // 20 分。初回はイメージの取得が入る。
  }, 1_200_000);

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
      // **この検査は検査制約と部分一意索引を見ない。** Prisma がそれらを
      // スキーマとして扱わないためである（検査制約を消して確かめた）。
      // その3つは下の各テストが個別に見ている。**ここが通ったからといって、
      // マイグレーションの手書き部分まで守られているわけではない。**
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
    it('ユーザーID は重複できない', async () => {
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('00000000-0000-7000-8000-0000000000ff', 'owner', '別人', 'argon2id-placeholder');`,
      );
      expect(output).toContain('User_userId_key');
    });

    it('退会したユーザーID も再利用できない', async () => {
      // 論理削除の行が残る以上、一意制約はそのまま効く。
      // **過去のメンションが別人を指すことを防ぐ**（機能一覧 1.5）。
      await expectSqlToSucceed(
        `UPDATE "User" SET "deletedAt" = now() WHERE "userId" = 'stranger';`,
      );
      const output = await expectSqlToFail(
        `INSERT INTO "User" ("id", "userId", "displayName", "passwordHash")
         VALUES ('00000000-0000-7000-8000-0000000000fe', 'stranger', '後から来た人', 'argon2id-placeholder');`,
      );
      expect(output).toContain('User_userId_key');
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
        `INSERT INTO "ChannelMember" ("id", "channelId", "userId")
         VALUES ('00000000-0000-7000-8000-0000000000fb', '00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-000000000002');`,
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

    it('未使用のリカバリーコードは1人につき1つしか持てない', async () => {
      await expectSqlToSucceed(
        `INSERT INTO "RecoveryCode" ("id", "userId", "codeHash")
         VALUES ('00000000-0000-7000-8000-0000000000e1', '00000000-0000-7000-8000-000000000001', 'argon2id-placeholder');`,
      );
      const output = await expectSqlToFail(
        `INSERT INTO "RecoveryCode" ("id", "userId", "codeHash")
         VALUES ('00000000-0000-7000-8000-0000000000e2', '00000000-0000-7000-8000-000000000001', 'argon2id-placeholder-2');`,
      );
      expect(output).toContain('RecoveryCode_single_unused_per_user');
    });

    it('使用済みにすれば新しいリカバリーコードを発行できる', async () => {
      // 「再設定の完了時に新しいコードを発行する」（機能一覧 1.1）が
      // 上の制約と両立することを見る。**古いコードを無効にしない限り新しく出せない。**
      await expectSqlToSucceed(
        `UPDATE "RecoveryCode" SET "usedAt" = now()
         WHERE "id" = '00000000-0000-7000-8000-0000000000e1';`,
      );
      await expectSqlToSucceed(
        `INSERT INTO "RecoveryCode" ("id", "userId", "codeHash")
         VALUES ('00000000-0000-7000-8000-0000000000e3', '00000000-0000-7000-8000-000000000001', 'argon2id-placeholder-3');`,
      );
    });
  });

  describe('チャンネルのアーカイブと名前の採番', () => {
    it('採番せずにアーカイブできない', async () => {
      // **改名がアーカイブと不可分であることを、DB の検査制約で担保する。**
      // アプリ側の実装に委ねると、片方だけ実行した状態が作れてしまう。
      const output = await expectSqlToFail(
        `UPDATE "Channel" SET "archivedAt" = now()
         WHERE "id" = '00000000-0000-7000-8000-0000000000c1';`,
      );
      expect(output).toContain('Channel_archive_naming_check');
    });

    it('改名せずにアーカイブできない', async () => {
      const output = await expectSqlToFail(
        `UPDATE "Channel" SET "archivedAt" = now(), "archiveSequence" = 1
         WHERE "id" = '00000000-0000-7000-8000-0000000000c1';`,
      );
      expect(output).toContain('Channel_archive_naming_check');
    });

    it('採番だけ変えて改名しないことはできない', async () => {
      // 「アーカイブしていないのに採番できない」ではない。
      // **復元した行は、現役のまま採番を持ち続ける。** 禁じているのは
      // 採番と名前が食い違うことであって、現役の行が採番を持つことではない。
      const output = await expectSqlToFail(
        `UPDATE "Channel" SET "archiveSequence" = 1
         WHERE "id" = '00000000-0000-7000-8000-0000000000c1';`,
      );
      expect(output).toContain('Channel_archive_naming_check');
    });

    it('アーカイブと採番と改名を同時に行えば通り、同じ名前で作り直せる', async () => {
      await expectSqlToSucceed(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 1, "name" = "baseName" || '-1'
         WHERE "id" = '00000000-0000-7000-8000-0000000000c1';`,
      );
      // アーカイブ済みの名前は general-1 になったので、general が空く。
      await expectSqlToSucceed(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('00000000-0000-7000-8000-0000000000c3', '00000000-0000-7000-8000-0000000000a1', 'general', 'general', 'PUBLIC');`,
      );
    });

    it('復元しても名前と採番が保たれる', async () => {
      // **承認済みの決定は「復元しても番号は外れない」**（機能一覧 3.2）。
      //
      // 検査制約を archivedAt で場合分けすると、復元が
      // 「採番を外して名前を baseName に戻すこと」まで要求してしまい、
      // **上で作り直した general と衝突して復元そのものができなくなる。**
      // このテストが無いと、その矛盾が誰にも見えないまま土台に残る。
      await expectSqlToSucceed(
        `UPDATE "Channel" SET "archivedAt" = NULL
         WHERE "id" = '00000000-0000-7000-8000-0000000000c1';`,
      );
      const output = await expectSqlToSucceed(
        `SELECT "name" || ':' || "baseName" || ':' || "archiveSequence"
         FROM "Channel" WHERE "id" = '00000000-0000-7000-8000-0000000000c1';`,
      );
      expect(output).toBe('general-1:general:1');
    });

    it('同じ基底名に同じ採番を二度使えない', async () => {
      await expectSqlToSucceed(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 2, "name" = "baseName" || '-2'
         WHERE "id" = '00000000-0000-7000-8000-0000000000c3';`,
      );
      await expectSqlToSucceed(
        `INSERT INTO "Channel" ("id", "workspaceId", "name", "baseName", "visibility")
         VALUES ('00000000-0000-7000-8000-0000000000c4', '00000000-0000-7000-8000-0000000000a1', 'general', 'general', 'PUBLIC');`,
      );
      // 2 は general-2 が使っている。
      //
      // **採番そのものに一意制約は置いていない。** 検査制約により
      // アーカイブ済みの名前は `baseName-<採番>` に決まるため、
      // **採番が重複すれば名前が必ず重複する。** 名前の一意制約が同じことを担保する。
      const output = await expectSqlToFail(
        `UPDATE "Channel"
         SET "archivedAt" = now(), "archiveSequence" = 2, "name" = "baseName" || '-2'
         WHERE "id" = '00000000-0000-7000-8000-0000000000c4';`,
      );
      expect(output).toContain('Channel_workspaceId_name_key');
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

    it('オーナーでも、参加していないプライベートチャンネルは見えない', async () => {
      // 要件定義書 3.5.1 / 4.4。オーナーの権限は**人の出入りの管理**であって
      // **会話の閲覧ではない**。この境界がデータの側で守られていることを見る。
      const output = await expectSqlToSucceed(visibleChannels(owner, workspace));
      expect(output.split('\n')).not.toContain('secret');
      expect(output.length).toBeGreaterThan(0);
    });

    it('ワークスペースに参加していない利用者には何も見えない', async () => {
      const output = await expectSqlToSucceed(visibleChannels(stranger, workspace));
      expect(output).toBe('');
    });
  });
});
