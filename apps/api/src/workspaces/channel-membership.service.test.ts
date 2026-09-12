import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { ChannelMembershipService } from './channel-membership.service';

/**
 * 一意制約違反（Prisma の P2002）を捕まえて 409 にする経路を、DB の応答を差し替えて決まった形で起こす。
 * 実際の DB を使う検査は、作成の前に SELECT で確かめる形へ変えても、要求が重ならなければ落ちない。参加は既に作成の前に
 * 参加済みかを確かめており、逐次の2件目は違反の経路を踏まない（channels.service.test.ts・invitations.service.test.ts と同じ形。#355）。
 */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

const ALREADY_CHANNEL_MEMBER = {
  code: 'already_channel_member',
  message: '既にこのチャンネルの参加者です',
};

/**
 * 参加の作成で一意制約違反を起こす DB に差し替えた ChannelMembershipService。
 * 読んだ時点では参加しておらず（参加の場合）、宛先はワークスペースのメンバーである（招待の場合）。
 * 参加の作成がトランザクションの中でも外でも、同じ差し替えが応答する。
 */
function createService(channel: { visibility: 'PUBLIC' | 'PRIVATE'; members: { id: string }[] }) {
  const client = {
    $queryRaw: vi.fn(async () => []),
    channel: { findFirst: vi.fn(async () => ({ ...channel, archivedAt: null })) },
    membership: { findFirst: vi.fn(async () => ({ id: 'membership-2' })) },
    channelMember: { create: vi.fn(async () => Promise.reject(uniqueViolation())) },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client)),
  };
  const workspaces = { membershipOf: vi.fn(async () => ({})) };
  return new ChannelMembershipService(prisma as never, workspaces as never);
}

describe('ChannelMembershipService（一意制約違反。#355）', () => {
  it('パブリックチャンネルへの参加の作成で一意制約違反（P2002）を捕まえたら 409（already_channel_member）', async () => {
    const service = createService({ visibility: 'PUBLIC', members: [] });

    await expect(service.join('user-1', 'workspace-1', 'channel-1')).rejects.toMatchObject({
      status: 409,
      response: ALREADY_CHANNEL_MEMBER,
    });
  });

  it('プライベートチャンネルへの招待の作成で一意制約違反（P2002）を捕まえたら 409（already_channel_member）', async () => {
    const service = createService({ visibility: 'PRIVATE', members: [{ id: 'member-row-1' }] });

    await expect(
      service.invite('user-1', 'workspace-1', 'channel-1', 'user-2'),
    ).rejects.toMatchObject({ status: 409, response: ALREADY_CHANNEL_MEMBER });
  });
});
