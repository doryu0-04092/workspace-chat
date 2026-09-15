import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import type { RealtimePresence } from './realtime-presence';
import type { RealtimeValkeyClients } from './realtime-valkey';
import type { RealtimeGateway } from './realtime.gateway';
import { ROOM_RECONCILE_INTERVAL_MS, RoomMembershipReconciler } from './room-membership-reconciler';

// publish が来ないタスクでは、5分ごとの照合が、参加者でなくなった接続を部屋から外す唯一の経路になる
// （機能一覧 9.2 の代償「publish が無ければ次の5分ごとの照合まで」。#369）。登録そのものを、DB を使わずに確かめる。
describe('照合の5分ごとの契機', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('起動で5分ごとの照合を登録し、止めた後は照合しない', async () => {
    vi.useFakeTimers();
    const valkey = { onPublishRecovered: vi.fn() } as unknown as RealtimeValkeyClients;
    const reconciler = new RoomMembershipReconciler(
      {} as RealtimeGateway,
      {} as PrismaService,
      {} as RealtimePresence,
      valkey,
    );
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue();

    reconciler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(ROOM_RECONCILE_INTERVAL_MS - 1);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ROOM_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(2);

    reconciler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(ROOM_RECONCILE_INTERVAL_MS * 2);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
