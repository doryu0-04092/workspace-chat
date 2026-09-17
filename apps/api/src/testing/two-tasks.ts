import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import type { StartedTestContainer } from 'testcontainers';
import { expect, vi } from 'vitest';
import { createApp } from '../app-setup';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { stubApiEnv } from './api-env';
import { startMigratedPostgres } from './postgres';
import { connectRealtime } from './realtime-client';
import { startValkey } from './valkey';

/**
 * タスクを2つに見立てた api（同じ PostgreSQL と Valkey を使う）と、利用者・ワークスペース・チャンネルを用意する部品。
 * **製品コードから読み込まない**（tsconfig.build.json が外す）。Redis アダプタを通さないと落ちない性質（他のタスクの接続）を確かめるときに使う。
 */
export type Workspace =
  paths['/workspaces']['post']['responses'][201]['content']['application/json'];

export type LoggedIn = { authorization: string; token: string; id: string };

export type TwoTasks = {
  readonly first: INestApplication;
  readonly second: INestApplication;
  readonly firstBase: string;
  readonly secondBase: string;
  readonly prisma: PrismaService;
  readonly valkey: StartedTestContainer;
  login(): Promise<LoggedIn>;
  send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    by: LoggedIn,
    body?: unknown,
  ): Promise<Response>;
  workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace>;
  channelRow(
    workspaceId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
    archived?: boolean,
  ): Promise<string>;
  open(base: string, user: LoggedIn): Promise<Socket>;
  closeSockets(): void;
  stop(): Promise<void>;
};

async function listen(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * `ipPrefix` はテストのファイルごとに変える（ログインのレート制限を発信元で数えるため、同じファイルの中で重ねない）。
 * `logger` を渡すと、2つのタスクのログをそこへ出す（渡さなければ出さない）。
 */
export async function startTwoTasks(
  ipPrefix: string,
  options: { logger?: LoggerService } = {},
): Promise<TwoTasks> {
  const postgres: StartedPostgreSqlContainer = await startMigratedPostgres();
  const started = await startValkey();
  stubApiEnv({
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: started.url,
    TRUST_PROXY_HOPS: '1',
  });
  // 調査用（マージしない）: アプリの warn と error を CI のログに出す
  const diagnostic = (task: string): LoggerService => ({
    log: () => undefined,
    warn: (message: unknown, ...rest: unknown[]) =>
      console.warn(
        `[two-tasks ${ipPrefix} ${task}] warn`,
        JSON.stringify(message),
        JSON.stringify(rest),
      ),
    error: (message: unknown, ...rest: unknown[]) =>
      console.error(
        `[two-tasks ${ipPrefix} ${task}] error`,
        JSON.stringify(message),
        JSON.stringify(rest),
      ),
  });
  const first = await createApp({ logger: options.logger ?? diagnostic('first') });
  const second = await createApp({ logger: options.logger ?? diagnostic('second') });
  const firstBase = await listen(first);
  const secondBase = await listen(second);
  // 調査用（マージしない）: タスク間の経路（serverSideEmit）が繋がるまでの時間を測る。
  // 繋がらなければ、在席の通知も部屋から外す処理も届かない（#618 の落ち方と一致するか見る）
  await probeCrossTask(first, second, ipPrefix);
  const prisma = first.get(PrismaService);
  const opened: Socket[] = [];
  let sequence = 0;

  const send: TwoTasks['send'] = (method, path, by, body) =>
    fetch(`${firstBase}/api${path}`, {
      method,
      headers: {
        authorization: by.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    first,
    second,
    firstBase,
    secondBase,
    prisma,
    valkey: started.container,
    send,

    async login() {
      sequence += 1;
      const loginId = `Two_${Date.now().toString(36)}_${sequence}`;
      const user = await prisma.user.create({
        data: {
          loginId,
          displayName: `利用者${sequence}`,
          passwordHash: await hashSecret('two-tasks-password'),
        },
      });
      const res = await fetch(`${firstBase}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `2001:db8::${ipPrefix}:${sequence.toString(16)}`,
        },
        body: JSON.stringify({ userId: loginId, password: 'two-tasks-password' }),
      });
      expect(res.status).toBe(200);
      const { accessToken } = (await res.json()) as { accessToken: string };
      return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id };
    },

    async workspaceWith(owner, ...members) {
      const res = await send('POST', '/workspaces', owner, { name: '部屋の場所' });
      expect(res.status).toBe(201);
      const workspace = (await res.json()) as Workspace;
      for (const member of members) {
        await prisma.membership.create({
          data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
        });
      }
      return workspace;
    },

    /** API を通さずにチャンネルを作る（参加者の組み合わせ・アーカイブ済みを自由に用意するため）。 */
    async channelRow(workspaceId, visibility, participants, archived = false) {
      sequence += 1;
      const name = `room-${sequence}`;
      const channel = await prisma.channel.create({
        data: archived
          ? {
              workspaceId,
              name: `${name}-1`,
              baseName: name,
              visibility,
              archivedAt: new Date(),
              archiveSequence: 1,
            }
          : { workspaceId, name, baseName: name, visibility },
      });
      for (const participant of participants) {
        await prisma.channelMember.create({
          data: { channelId: channel.id, workspaceId, userId: participant.id },
        });
      }
      return channel.id;
    },

    async open(base, user) {
      const { socket, error } = await connectRealtime(base, { token: user.token });
      expect(error).toBeUndefined();
      opened.push(socket);
      return socket;
    },

    closeSockets() {
      for (const socket of opened.splice(0)) socket.close();
    },

    async stop() {
      await first.close();
      await second.close();
      await postgres.stop();
      await started.container.stop().catch(() => undefined);
      vi.unstubAllEnvs();
    },
  };
}

/** 調査用（マージしない）: 片方のタスクから serverSideEmit を送り、もう片方が答えるまでの時間を測って出す（#618）。 */
async function probeCrossTask(
  first: INestApplication,
  second: INestApplication,
  ipPrefix: string,
): Promise<void> {
  const firstServer = first.get(RealtimeGateway).server;
  const secondServer = second.get(RealtimeGateway).server;
  secondServer.on(
    'two-tasks-probe' as never,
    ((ack: (value: string) => void) => {
      ack('second');
    }) as never,
  );
  const started = Date.now();
  const deadline = started + 20_000;
  for (let attempt = 1; ; attempt += 1) {
    const answered = await new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), 1_000);
      firstServer.serverSideEmit(
        'two-tasks-probe' as never,
        ((error: unknown, responses: string[]) => {
          clearTimeout(timer);
          resolve(error ? [] : responses);
        }) as never,
      );
    });
    if (answered.length > 0) {
      console.warn(
        `[two-tasks ${ipPrefix} probe] 繋がった`,
        JSON.stringify({ ms: Date.now() - started, attempt }),
      );
      return;
    }
    if (Date.now() > deadline) {
      console.error(
        `[two-tasks ${ipPrefix} probe] 20 秒たっても繋がらない`,
        JSON.stringify({ attempt }),
      );
      return;
    }
  }
}
