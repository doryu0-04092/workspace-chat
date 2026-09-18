import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { foreignKeyViolation, uniqueViolation } from '../testing/prisma-violations';
import { ChannelMembershipService } from './channel-membership.service';

// 規則は testing/prisma-violations.ts。

const CHANNEL_INVITEE_NOT_FOUND = {
  code: 'invitee_not_found',
  message: 'その利用者はこのワークスペースのメンバーではありません',
};

const ALREADY_CHANNEL_MEMBER = {
  code: 'already_channel_member',
  message: '既にこのチャンネルの参加者です',
};

/**
 * 参加の作成で一意制約違反を起こす DB に差し替えた ChannelMembershipService。
 * 読んだ時点では参加しておらず（参加の場合）、宛先はワークスペースのメンバーである（招待の場合）。
 * 参加の作成がトランザクションの中でも外でも、同じ差し替えが応答する。
 */
function createService(
  channel: { visibility: 'PUBLIC' | 'PRIVATE'; members: { id: string }[] },
  violation: () => Error = uniqueViolation,
) {
  const client = {
    $queryRaw: vi.fn(async () => []),
    channel: { findFirst: vi.fn(async () => ({ ...channel, archivedAt: null })) },
    membership: { findFirst: vi.fn(async () => ({ id: 'membership-2' })) },
    channelMember: { create: vi.fn(async () => Promise.reject(violation())) },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client)),
  };
  const workspaces = { membershipOf: vi.fn(async () => ({})) };
  const rooms = { removeFromChannels: vi.fn() };
  return new ChannelMembershipService(prisma as never, workspaces as never, rooms as never);
}

describe('ChannelMembershipService（一意制約違反・外部キーの違反。#355・#358）', () => {
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

  // 事前の判定の後、参加を書く間にワークスペースから外れた（参加は Membership への外部キーを持つ）。#358
  it('パブリックチャンネルへの参加の作成で外部キーの違反（P2003）を捕まえたら 404', async () => {
    const service = createService({ visibility: 'PUBLIC', members: [] }, foreignKeyViolation);

    await expect(service.join('user-1', 'workspace-1', 'channel-1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('プライベートチャンネルへの招待の作成で外部キーの違反（P2003）を捕まえたら 422（invitee_not_found）', async () => {
    const service = createService(
      { visibility: 'PRIVATE', members: [{ id: 'member-row-1' }] },
      foreignKeyViolation,
    );

    await expect(
      service.invite('user-1', 'workspace-1', 'channel-1', 'user-2'),
    ).rejects.toMatchObject({ status: 422, response: CHANNEL_INVITEE_NOT_FOUND });
  });
});
