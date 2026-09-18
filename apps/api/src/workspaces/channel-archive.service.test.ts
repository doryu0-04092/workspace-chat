import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import { uniqueViolation } from '../testing/prisma-violations';
import { ChannelArchiveService } from './channel-archive.service';
import type { WorkspacesService } from './workspaces.service';

// 機能一覧 3.2: 並行して同じ名前が作られたら、一意制約の違反を捕まえて採番をやり直す（上限 5 回。#360）。
// 実際の DB では要求が重ならないと踏めないため、トランザクションを決まった回数だけ違反で失敗させる。
function serviceFailing(times: number) {
  let calls = 0;
  const $transaction = vi.fn(async () => {
    calls += 1;
    if (calls <= times) throw uniqueViolation();
    return { id: 'channel-1' };
  });
  const workspaces = { ownerMembershipOf: vi.fn(async () => ({ role: 'OWNER' as const })) };
  const service = new ChannelArchiveService(
    { $transaction } as unknown as PrismaService,
    workspaces as unknown as WorkspacesService,
  );
  return { service, $transaction };
}

describe('アーカイブの採番のやり直し', () => {
  it('名前の一意制約の違反では採番をやり直し、通った結果を返す', async () => {
    const { service, $transaction } = serviceFailing(4);

    await expect(service.archive('owner-1', 'workspace-1', 'channel-1')).resolves.toEqual({
      id: 'channel-1',
    });
    expect($transaction).toHaveBeenCalledTimes(5);
  });

  it('5 回続けて違反したら、それ以上やり直さずに違反を投げる', async () => {
    const { service, $transaction } = serviceFailing(5);

    await expect(service.archive('owner-1', 'workspace-1', 'channel-1')).rejects.toMatchObject({
      code: 'P2002',
    });
    expect($transaction).toHaveBeenCalledTimes(5);
  });
});
