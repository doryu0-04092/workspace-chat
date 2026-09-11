import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';

type LogLine = { level?: string; message?: unknown; context?: string; requestId?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 要件定義書 4.6「ログは構造化 JSON を標準出力にのみ出す」「リクエストごとに ID を発行し、そのリクエスト中の全ログに付与する」（#250）。
// 既定のロガー（createApp が組み立てるもの）を、実際に標準出力へ書かれた行で確かめる。
describe('構造化ログとリクエスト ID', () => {
  let app: INestApplication;
  let base: string;
  const written: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };

  /** 書かれた行のうち JSON として読めるもの。Vitest 自身の出力が混ざるため、JSON の行だけを拾う。 */
  function jsonLines(stream: 'stdout' | 'stderr' = 'stdout'): LogLine[] {
    return written[stream]
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as LogLine);
  }

  beforeAll(async () => {
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = process[name];
      const original = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        written[name].push(String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    // DB に繋がらない宛先にし、新規登録で想定外の失敗（500）を起こしてログを出させる。
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:9/unused');
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:9');
    vi.stubEnv('TRUST_PROXY_HOPS', '0');
    vi.stubEnv('REGISTRATION_ENABLED', undefined);
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('ログは1行1件の JSON で、level と message を持つ', () => {
    const lines = jsonLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line.level).toBe('string');
      expect(line.message).toBeDefined();
    }
  });

  it('要求の外のログ（起動時）にはリクエスト ID が付かない', () => {
    const startup = jsonLines().filter((line) => line.context === 'NestApplication');
    expect(startup.length).toBeGreaterThan(0);
    expect(startup.every((line) => line.requestId === undefined)).toBe(true);
  });

  it('要求ごとに違うリクエスト ID を振り、応答の X-Request-Id で返す', async () => {
    const first = (await fetch(`${base}/api/health`)).headers.get('x-request-id');
    const second = (await fetch(`${base}/api/health`)).headers.get('x-request-id');
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
  });

  it('要求の中で出たログに、その要求の X-Request-Id と同じリクエスト ID が付く', async () => {
    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'log_probe',
        password: 'log-probe-password',
        displayName: 'ログ',
      }),
    });
    expect(res.status).toBe(500);
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toMatch(UUID);

    const errors = jsonLines().filter((line) => line.level === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((line) => line.requestId === requestId)).toBe(true);
  });

  // 4.6「標準出力にのみ」。ConsoleLogger は既定で error を標準エラーへ書く。
  it('error を含むすべてのログを標準出力に出し、標準エラーには JSON の行を出さない', () => {
    expect(jsonLines('stdout').some((line) => line.level === 'error')).toBe(true);
    expect(jsonLines('stderr')).toHaveLength(0);
  });

  // #251: 本番の終了（ECS の SIGTERM）で Valkey と Prisma の片づけを走らせる。テストだけが app.close() を呼ぶ形にしない。
  it('終了のシグナルを購読し、close で外す', async () => {
    const before = process.listenerCount('SIGTERM');
    const another = await createApp({ logger: false });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await another.close();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
