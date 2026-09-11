import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { PrismaService } from '../prisma.service';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';
import type { StartedTestContainer } from 'testcontainers';
import { canonicalRecoveryCode } from './recovery-code';

type RegisterResponses = paths['/auth/register']['post']['responses'];
type RegisterResponse = RegisterResponses[201]['content']['application/json'];
type ErrorResponse = RegisterResponses[400 | 403 | 409]['content']['application/json'];

/** アプリのログをすべて控える。パスワードがログの経路に渡っていないかを見るため。 */
class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private capture(level: string, message: unknown, rest: unknown[]): void {
    this.lines.push(`${level} ${JSON.stringify([message, ...rest], errorReplacer)}`);
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.capture('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.capture('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.capture('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.capture('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.capture('verbose', message, rest);
  }
}

/** Error はそのままでは JSON にならない。メッセージとスタックを残す。 */
function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}

/** OWASP Password Storage Cheat Sheet の Argon2id の最小構成（m=19456 (19 MiB), t=2, p=1）。 */
const OWASP_MINIMUM = { algorithm: 'argon2id', version: '19', m: '19456', t: '2', p: '1' };

/**
 * PHC 文字列（`$argon2id$v=19$m=…,t=…,p=…$salt$hash`）からアルゴリズムとパラメータを取り出す。
 * パラメータの並び順はライブラリが決める（argon2 0.45.1 は m,p,t）ため、順序には寄りかからない。
 */
function argon2idParameters(phc: string): Record<string, string | undefined> {
  const [, algorithm, version, params] = phc.split('$');
  const entries = Object.fromEntries((params ?? '').split(',').map((kv) => kv.split('=')));
  return {
    algorithm,
    version: version?.replace('v=', ''),
    m: entries.m,
    t: entries.t,
    p: entries.p,
  };
}

let userSequence = 0;
/** テストごとに重ならないユーザーID を作る（3〜30文字の英数字とアンダースコア）。 */
function uniqueUserId(): string {
  userSequence += 1;
  return `user_${Date.now().toString(36)}_${userSequence}`;
}

async function startApp(logger: LoggerService): Promise<{ app: INestApplication; base: string }> {
  const app = await createApp({ logger });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}` };
}

/** 繋がらない Valkey の宛先。レート制限はメモリへ迂回する。 */
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:9';

let ipSequence = 0;
/**
 * 要求ごとに違う発信元を作る（文書用の IPv6 の範囲 2001:db8::/32）。
 * **レート制限は発信元単位で数えるため、同じ発信元から送り続けると、登録そのものを見るテストが 429 で落ちる。**
 * アプリは TRUST_PROXY_HOPS=1 で起動し、X-Forwarded-For の最後の値を発信元として読む。
 */
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::${ipSequence.toString(16)}`;
}

function postRegister(base: string, body: unknown, ip: string = nextIp()): Promise<Response> {
  return fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/register（F-01 / F-03 / F-37）', () => {
  let container: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    container = await startMigratedPostgres();
    const started = await startValkey();
    valkey = started.container;
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('REDIS_URL', started.url);
    vi.stubEnv('TRUST_PROXY_HOPS', '1');
    vi.stubEnv('API_TASK_COUNT', undefined);
    vi.stubEnv('REGISTRATION_ENABLED', undefined);
    ({ app, base } = await startApp(logger));
    prisma = app.get(PrismaService);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('登録できる', () => {
    it('201 を返し、利用者とリカバリーコードを返す', async () => {
      const userId = uniqueUserId();
      const res = await postRegister(base, {
        userId,
        password: 'correct horse battery',
        displayName: '登録する人',
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as RegisterResponse;
      expect(body.user.userId).toBe(userId);
      expect(body.user.displayName).toBe('登録する人');
      expect(body.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      expect(body.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    });

    it('パスワードは Argon2id（m=19456, t=2, p=1）でハッシュ化して保存する', async () => {
      const userId = uniqueUserId();
      const password = 'correct horse battery';
      const res = await postRegister(base, { userId, password, displayName: 'ハッシュ' });
      expect(res.status).toBe(201);

      const row = await prisma.user.findUniqueOrThrow({ where: { loginId: userId } });
      expect(argon2idParameters(row.passwordHash)).toEqual(OWASP_MINIMUM);
      expect(await argon2.verify(row.passwordHash, password)).toBe(true);
    });

    // NIST SP 800-63B-4 3.1.1.2: Unicode を受け付けるなら NFC で正規化する（SHOULD）。
    // 端末によって同じ見た目の文字が別のコードポイント列で送られても、同じパスワードとして照合できるようにする。
    it('パスワードは NFC に正規化してからハッシュ化する', async () => {
      const userId = uniqueUserId();
      const decomposed = 'café-password'; // e + 結合用アキュート
      const composed = 'café-password';
      const res = await postRegister(base, { userId, password: decomposed, displayName: 'NFC' });
      expect(res.status).toBe(201);

      const row = await prisma.user.findUniqueOrThrow({ where: { loginId: userId } });
      expect(await argon2.verify(row.passwordHash, composed)).toBe(true);
    });

    it('応答にパスワードもそのハッシュも含まれない', async () => {
      const userId = uniqueUserId();
      const password = 'response-must-not-echo';
      const res = await postRegister(base, { userId, password, displayName: '応答' });
      const text = await res.text();
      const row = await prisma.user.findUniqueOrThrow({ where: { loginId: userId } });

      expect(res.status).toBe(201);
      expect(text).not.toContain(password);
      expect(text).not.toContain(row.passwordHash);
      expect(text).not.toContain('$argon2');
    });

    it('リカバリーコードは平文で保存せず、Argon2id のハッシュを未使用で1件だけ保存する', async () => {
      const userId = uniqueUserId();
      const res = await postRegister(base, {
        userId,
        password: 'recovery-code-test',
        displayName: 'コード',
      });
      const body = (await res.json()) as RegisterResponse;
      const user = await prisma.user.findUniqueOrThrow({
        where: { loginId: userId },
        include: { recoveryCodes: true },
      });

      expect(user.recoveryCodes).toHaveLength(1);
      const [code] = user.recoveryCodes;
      expect(code?.usedAt).toBeNull();
      expect(argon2idParameters(code?.codeHash ?? '')).toEqual(OWASP_MINIMUM);
      expect(code?.codeHash).not.toContain(canonicalRecoveryCode(body.recoveryCode));
      expect(
        await argon2.verify(code?.codeHash ?? '', canonicalRecoveryCode(body.recoveryCode)),
      ).toBe(true);
    });
  });

  describe('ユーザーID の一意性（大文字小文字を区別しない）', () => {
    it('既に使われているユーザーID では 409 を返す', async () => {
      const userId = uniqueUserId();
      const first = await postRegister(base, {
        userId,
        password: 'first-password',
        displayName: '先',
      });
      expect(first.status).toBe(201);

      const second = await postRegister(base, {
        userId,
        password: 'second-password',
        displayName: '後',
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as ErrorResponse).code).toBe('user_id_taken');
    });

    it('大文字小文字だけが違うユーザーID でも 409 を返し、行は1つのまま', async () => {
      const userId = uniqueUserId();
      await postRegister(base, { userId, password: 'lower-password', displayName: '小文字' });

      const res = await postRegister(base, {
        userId: userId.toUpperCase(),
        password: 'upper-password',
        displayName: '大文字',
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorResponse).code).toBe('user_id_taken');

      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM "User" WHERE lower("userId") = lower(${userId})`;
      expect(rows[0]?.count).toBe(1n);
    });
  });

  describe('入力が仕様に合わない', () => {
    const valid = { password: 'valid-password', displayName: '表示名' };
    it.each([
      ['ユーザーID が2文字', { userId: 'ab' }],
      ['ユーザーID が31文字', { userId: 'a'.repeat(31) }],
      ['ユーザーID に記号', { userId: 'bad-id' }],
      ['ユーザーID に日本語', { userId: 'ユーザー' }],
      ['パスワードが7文字', { password: 'short77' }],
      ['パスワードが129文字', { password: 'p'.repeat(129) }],
      ['表示名が空', { displayName: '' }],
      ['表示名が空白だけ', { displayName: '   ' }],
      ['表示名が51文字', { displayName: 'あ'.repeat(51) }],
      ['仕様に無い項目', { isOwner: true }],
      ['表示名が無い', { displayName: undefined }],
    ])('%s なら 400 を返し、行を作らない', async (_label, override) => {
      const userId = uniqueUserId();
      const res = await postRegister(base, { userId, ...valid, ...override });

      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).code).toBe('validation_failed');
      const count = await prisma.user.count({
        where: { loginId: { in: [userId, (override as { userId?: string }).userId ?? ''] } },
      });
      expect(count).toBe(0);
    });

    it('400 の応答に、送ったパスワードが含まれない', async () => {
      const password = 'secret7';
      const res = await postRegister(base, { userId: uniqueUserId(), password, displayName: '名' });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(password);
    });

    // 境界の内側は通る。上の境界の外側だけを見ると、上限・下限をずらしても落ちない。
    it('境界の内側（ユーザーID 3文字と30文字・パスワード8文字と128文字・表示名50文字）は通る', async () => {
      const suffix = Date.now().toString(36).slice(-4);
      const cases = [
        { userId: `a${suffix}`.slice(0, 3), password: 'p'.repeat(8), displayName: 'あ'.repeat(50) },
        { userId: `z_${suffix}`.padEnd(30, 'x'), password: 'p'.repeat(128), displayName: 'い' },
      ];
      for (const input of cases) {
        const res = await postRegister(base, input);
        expect(res.status, JSON.stringify(input)).toBe(201);
      }
    });
  });

  // 機能一覧 1.1「パスワードがログに出力されない」。CLAUDE.md 禁止事項「パスワードをログ出力の経路に渡さない」。
  // このファイルのすべての要求（成功・重複・検証の失敗）を通した後のログを見る。
  it('パスワードもリカバリーコードも、ログに出力されない', async () => {
    const userId = uniqueUserId();
    const password = 'must-not-appear-in-logs';
    const ok = await postRegister(base, { userId, password, displayName: 'ログ' });
    expect(ok.status).toBe(201);
    const { recoveryCode } = (await ok.json()) as RegisterResponse;
    await postRegister(base, { userId, password, displayName: '重複' });
    await postRegister(base, { userId: 'x', password, displayName: '検証' });

    // 控える仕組みが働いていることを先に見る。空のまま「含まれない」を見ても意味が無い。
    expect(logger.lines.length).toBeGreaterThan(0);
    const all = logger.lines.join('\n');
    expect(all).not.toContain(password);
    expect(all).not.toContain(recoveryCode);
    expect(all).not.toContain(canonicalRecoveryCode(recoveryCode));
  });
});

describe('新規登録の停止（REGISTRATION_ENABLED=false。要件定義書 5.1）', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    container = await startMigratedPostgres();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('REDIS_URL', UNREACHABLE_REDIS_URL);
    vi.stubEnv('TRUST_PROXY_HOPS', '1');
    vi.stubEnv('REGISTRATION_ENABLED', 'false');
    ({ app, base } = await startApp(new CapturingLogger()));
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('403 を返し、行を作らない', async () => {
    const userId = uniqueUserId();
    const res = await postRegister(base, {
      userId,
      password: 'disabled-password',
      displayName: '停止中',
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponse).code).toBe('registration_disabled');
    expect(await app.get(PrismaService).user.count()).toBe(0);
  });
});

// 想定外の失敗（DB に繋がらない等）では、Nest が例外をログに出す。
// **DB の例外のメッセージは、書き込もうとした値（パスワードのハッシュ）を含みうる。**
// 成功・検証の失敗・重複のログだけを見ていると、この経路を見逃す。
describe('DB に繋がらないとき', () => {
  let app: INestApplication;
  let base: string;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:9/unused');
    vi.stubEnv('REDIS_URL', UNREACHABLE_REDIS_URL);
    vi.stubEnv('TRUST_PROXY_HOPS', '1');
    vi.stubEnv('REGISTRATION_ENABLED', undefined);
    ({ app, base } = await startApp(logger));
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('500 を返し、ログにも応答にもパスワード・そのハッシュ・リカバリーコードのハッシュが出ない', async () => {
    const password = 'db-down-password';
    const res = await postRegister(base, {
      userId: uniqueUserId(),
      password,
      displayName: '繋がらない',
    });
    const text = await res.text();

    expect(res.status).toBe(500);
    // 例外がログに出ていることを先に見る。出ていなければ「含まれない」を見ても意味が無い。
    expect(logger.lines.some((line) => line.startsWith('error '))).toBe(true);
    const all = `${logger.lines.join('\n')}\n${text}`;
    expect(all).not.toContain(password);
    expect(all).not.toContain('$argon2');
  });
});

/** 新規登録のレート制限の上限（機能一覧 1.1。発信元単位で1時間に10回）。 */
const REGISTER_LIMIT = 10;

function registerBody(): { userId: string; password: string; displayName: string } {
  return { userId: uniqueUserId(), password: 'rate-limit-password', displayName: '制限' };
}

// 機能一覧 1.1「新規登録に発信元単位のレート制限がかかる」。状態は Valkey に置き、タスクをまたいで数える。
describe('新規登録のレート制限（発信元単位）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let taskA: { app: INestApplication; base: string };
  let taskB: { app: INestApplication; base: string };

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    const started = await startValkey();
    valkey = started.container;
    vi.stubEnv('DATABASE_URL', postgres.getConnectionUri());
    vi.stubEnv('REDIS_URL', started.url);
    vi.stubEnv('TRUST_PROXY_HOPS', '1');
    vi.stubEnv('API_TASK_COUNT', '2');
    vi.stubEnv('REGISTRATION_ENABLED', undefined);
    // 同じ Valkey に繋ぐ2つのアプリ。本番の2タスク（tech-stack.md）の代わり。
    taskA = await startApp(new CapturingLogger());
    taskB = await startApp(new CapturingLogger());
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await taskA?.app.close();
    await taskB?.app.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  it('同じ発信元から上限を超えると 429（too_many_requests）と Retry-After（秒）を返し、行を作らない', async () => {
    const ip = nextIp();
    for (let i = 0; i < REGISTER_LIMIT; i++) {
      expect((await postRegister(taskA.base, registerBody(), ip)).status).toBe(201);
    }
    const body = registerBody();
    const res = await postRegister(taskA.base, body, ip);

    expect(res.status).toBe(429);
    expect(((await res.json()) as ErrorResponse).code).toBe('too_many_requests');
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(await taskA.app.get(PrismaService).user.count({ where: { loginId: body.userId } })).toBe(
      0,
    );
  });

  it('別の発信元は止めない', async () => {
    const blocked = nextIp();
    for (let i = 0; i <= REGISTER_LIMIT; i++)
      await postRegister(taskA.base, registerBody(), blocked);
    expect((await postRegister(taskA.base, registerBody(), nextIp())).status).toBe(201);
  });

  // Valkey に置く理由。各タスクのメモリで数えると、ALB の振り分けで上限が「上限 × タスク数」になる。
  it('タスクをまたいで数える', async () => {
    const ip = nextIp();
    for (let i = 0; i < REGISTER_LIMIT; i++) {
      const task = i % 2 === 0 ? taskA : taskB;
      expect((await postRegister(task.base, registerBody(), ip)).status).toBe(201);
    }
    expect((await postRegister(taskA.base, registerBody(), ip)).status).toBe(429);
    expect((await postRegister(taskB.base, registerBody(), ip)).status).toBe(429);
  });
});

// Valkey が止まっている間は、各タスクのメモリで数える（決定・2026-09-11・依頼側）。止めずに、上限をタスク数で割る。
describe('Valkey に繋がらないときの新規登録のレート制限', () => {
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let base: string;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    vi.stubEnv('DATABASE_URL', postgres.getConnectionUri());
    vi.stubEnv('REDIS_URL', UNREACHABLE_REDIS_URL);
    vi.stubEnv('TRUST_PROXY_HOPS', '1');
    vi.stubEnv('API_TASK_COUNT', '2');
    vi.stubEnv('REGISTRATION_ENABLED', undefined);
    ({ app, base } = await startApp(logger));
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    vi.unstubAllEnvs();
  });

  it('登録は止めずに、上限をタスク数で割って数え、切り替えたことを1回だけログに残す', async () => {
    const ip = nextIp();
    const perTask = REGISTER_LIMIT / 2;
    for (let i = 0; i < perTask; i++) {
      expect((await postRegister(base, registerBody(), ip)).status).toBe(201);
    }
    const res = await postRegister(base, registerBody(), ip);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(3600);

    // 起動時に繋がらなかったことと、要求で迂回に切り替えたことを、それぞれ1回だけ残す。
    const atStartup = logger.lines.filter((line) =>
      line.includes('Valkey に接続できないまま起動する'),
    );
    const switched = logger.lines.filter((line) => line.includes('Valkey に書けないため'));
    expect(atStartup).toHaveLength(1);
    expect(switched).toHaveLength(1);
    expect(atStartup[0]?.startsWith('warn ')).toBe(true);
    expect(switched[0]?.startsWith('warn ')).toBe(true);
  });
});
