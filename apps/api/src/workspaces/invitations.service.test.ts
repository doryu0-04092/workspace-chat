import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { InvitationsService } from './invitations.service';

/**
 * 一意制約違反（Prisma の P2002）を捕まえて 409 にする経路を、DB の応答を差し替えて決まった形で起こす。
 * 実際の DB を使う検査は、作成の前に SELECT で確かめる形へ変えても、要求が重ならなければ落ちない
 * （session.service.test.ts・channels.service.test.ts と同じ形。#355）。
 */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

const OWNER = {
  role: 'OWNER' as const,
  workspace: { id: 'workspace-1', name: 'ワークスペース', createdAt: new Date() },
  user: { id: 'owner-1', userId: 'owner', displayName: 'オーナー' },
};
const INVITEE_ROW = { id: 'invitee-1' };

describe('InvitationsService.invite（一意制約違反。#355）', () => {
  /** 招待の作成で一意制約違反を起こす DB に差し替えた InvitationsService（宛先は解決でき、既存のメンバーでもない）。 */
  function createService() {
    const prisma = {
      $queryRaw: vi.fn(async () => [INVITEE_ROW]),
      membership: { findUnique: vi.fn(async () => null) },
      invitation: { create: vi.fn(async () => Promise.reject(uniqueViolation())) },
    };
    const realtime = { toUsers: vi.fn() };
    const workspaces = { ownerMembershipOf: vi.fn(async () => OWNER) };
    return {
      service: new InvitationsService(prisma as never, realtime as never, workspaces as never),
      prisma,
      realtime,
    };
  }

  it('招待の作成で一意制約違反（P2002）を捕まえたら 409（already_invited）', async () => {
    const { service, realtime } = createService();

    await expect(
      service.invite('owner-1', 'workspace-1', { userId: 'invitee' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'already_invited', message: 'この利用者は既に招待しています' },
    });
    // 書き込みが確定する前なので、招待された利用者への通知も送らない。
    expect(realtime.toUsers).not.toHaveBeenCalled();
  });
});

describe('InvitationsService.accept（一意制約違反。#355）', () => {
  /**
   * 承諾のトランザクション中（Membership の作成）で一意制約違反を起こす DB に差し替えた InvitationsService。
   * 招待の行は見つかり、消す行も1件ある（招待の後に別の経路で既にメンバーになっていた場合に当たる）。
   */
  function createService() {
    const tx = {
      invitation: {
        findFirst: vi.fn(async () => ({
          workspace: { id: 'workspace-1', name: 'ワークスペース', createdAt: new Date() },
        })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      membership: { create: vi.fn(async () => Promise.reject(uniqueViolation())) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const realtime = { toUsers: vi.fn() };
    const workspaces = {};
    return {
      service: new InvitationsService(prisma as never, realtime as never, workspaces as never),
      tx,
    };
  }

  it('参加（Membership）の作成で一意制約違反（P2002）を捕まえたら 409（already_member）', async () => {
    const { service } = createService();

    await expect(service.accept('invitee-1', 'invitation-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'already_member', message: 'この利用者は既にメンバーです' },
    });
  });
});
