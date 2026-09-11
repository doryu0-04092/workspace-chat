import { describe, expect, it, vi } from 'vitest';
import { resolveApiConfig } from './api-config';

// 起動の失敗はログに出る。値に秘密（資格情報・鍵）が入る設定は、resolve 関数が値をメッセージに埋めても漏らさない。
// いまの resolve 関数は空のときしか落ちず、値を埋める経路が無い。**値を埋める resolve 関数に差し替え、
// 集約（resolveApiConfig）の側で止まることを確かめる**——次に形式の検証を足した人が値を埋めても漏れないように。
vi.mock('./database-url', () => ({
  resolveDatabaseUrl: (raw: string | undefined) => {
    throw new Error(`DATABASE_URL の値が不正です: ${raw}`);
  },
}));
vi.mock('../rate-limit/rate-limit-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rate-limit/rate-limit-config')>()),
  resolveRedisUrl: (raw: string | undefined) => {
    throw new Error(`REDIS_URL の値が不正です: ${raw}`);
  },
}));

const ENV = {
  DATABASE_URL: 'postgresql://app:db-password-9x@db.internal:5432/chat',
  REDIS_URL: 'rediss://:redis-password-9x@cache.internal:6379',
  TRUST_PROXY_HOPS: '0',
};

function messageOf(env: Record<string, string | undefined>): string {
  try {
    resolveApiConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('resolveApiConfig が落ちなかった');
}

describe('起動の設定の失敗のメッセージと秘密', () => {
  it.each([
    ['DATABASE_URL', 'db-password-9x', 'db.internal'],
    ['REDIS_URL', 'redis-password-9x', 'cache.internal'],
  ])('%s の値が不正でも、名前だけを示し、値（%s・%s）を載せない', (name, password, host) => {
    const message = messageOf(ENV);
    expect(message).toContain(name);
    expect(message).not.toContain(password);
    expect(message).not.toContain(host);
  });

  // 未設定・空のときは載せる値が無いため、resolve 関数のメッセージ（何を渡せばよいか）をそのまま出す。
  it('値が空なら、resolve 関数のメッセージをそのまま出す', () => {
    expect(messageOf({ ...ENV, DATABASE_URL: '' })).toContain('DATABASE_URL の値が不正です: ');
  });
});
