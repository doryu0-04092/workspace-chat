import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { uniqueViolation } from '../testing/prisma-violations';
import { ChannelsService } from './channels.service';

// 規則は testing/prisma-violations.ts。

/** 作成のトランザクション中に一意制約違反を起こす DB に差し替えた ChannelsService。 */
function createService() {
  const tx = {
    channel: { create: vi.fn(async () => Promise.reject(uniqueViolation())) },
    channelMember: { create: vi.fn(async () => undefined) },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const workspaces = {
    ownerMembershipOf: vi.fn(async () => ({
      role: 'OWNER' as const,
      workspace: { id: 'workspace-1', name: 'ワークスペース', createdAt: new Date() },
      user: { id: 'owner-1', userId: 'owner', displayName: 'オーナー' },
    })),
  };
  return { service: new ChannelsService(prisma as never, workspaces as never), prisma, tx };
}

describe('ChannelsService.create（一意制約違反。#355）', () => {
  it('作成で一意制約違反（P2002）を捕まえたら 409（channel_name_taken）', async () => {
    const { service, tx } = createService();

    await expect(
      service.create('owner-1', 'workspace-1', { name: 'general', visibility: 'PUBLIC' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'channel_name_taken', message: 'この名前のチャンネルは既にあります' },
    });
    expect(tx.channelMember.create).not.toHaveBeenCalled();
  });
});
