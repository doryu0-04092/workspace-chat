import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_REFRESH_INTERVAL_MS, PresenceRegistry } from './presence-registry';
import type { RealtimeGateway } from './realtime.gateway';

/** 部屋に入っている接続を返す偽のサーバー（fetchSockets の形だけを持つ）。 */
function fakeGateway(fetchSockets: () => Promise<unknown[]>) {
  const rooms: string[] = [];
  const server = {
    in: (room: string) => {
      rooms.push(room);
      return { fetchSockets };
    },
  };
  return { gateway: { server } as unknown as RealtimeGateway, rooms };
}

function socketOf(id: string, userId: string) {
  return { id, data: { user: { id: userId } } };
}

// 機能一覧 9.2「タスクをまたぐ在席」: 各タスクは5分ごとに一覧を取り直す（fetchSockets で全タスクへ問い合わせる）。
describe('在席の一覧（PresenceRegistry）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('利用者ごとに接続を数え、最初の1本と最後の1本でだけ在席が変わったと返す', () => {
    const registry = new PresenceRegistry(fakeGateway(async () => []).gateway);

    expect(registry.add('c1', 'u1', 's1')).toBe(true);
    expect(registry.add('c1', 'u1', 's2')).toBe(false);
    expect(registry.remove('c1', 'u1', 's1')).toBe(false);
    expect(registry.usersIn('c1')).toEqual(['u1']);
    expect(registry.remove('c1', 'u1', 's2')).toBe(true);
    expect(registry.usersIn('c1')).toEqual([]);
    expect(registry.remove('c1', 'u1', 's2')).toBe(false);
  });

  it('利用者をまとめて外すと、在席していた場合にだけ変わったと返す', () => {
    const registry = new PresenceRegistry(fakeGateway(async () => []).gateway);
    registry.add('c1', 'u1', 's1');
    registry.add('c1', 'u1', 's2');

    expect(registry.removeUser('c1', 'u1')).toBe(true);
    expect(registry.usersIn('c1')).toEqual([]);
    expect(registry.removeUser('c1', 'u1')).toBe(false);
  });

  it('5分ごとに、一覧にあるチャンネルの部屋へ問い合わせて一覧を置き換える', async () => {
    vi.useFakeTimers();
    const fetchSockets = vi.fn(async () => [socketOf('s9', 'u2')]);
    const { gateway, rooms } = fakeGateway(fetchSockets);
    const registry = new PresenceRegistry(gateway);
    registry.add('c1', 'u1', 's1');
    registry.onApplicationBootstrap();
    try {
      await vi.advanceTimersByTimeAsync(PRESENCE_REFRESH_INTERVAL_MS - 1);
      expect(fetchSockets).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(rooms).toEqual(['channel:c1']);
      expect(registry.usersIn('c1')).toEqual(['u2']);
      expect(PRESENCE_REFRESH_INTERVAL_MS).toBe(5 * 60 * 1000);
    } finally {
      registry.onModuleDestroy();
    }
  });

  it('取り直しに失敗したチャンネルは今の一覧を残し、例外にせず warn を残す', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new PresenceRegistry(
      fakeGateway(async () => {
        throw new Error('timeout reached while waiting for fetchSockets response');
      }).gateway,
    );
    registry.add('c1', 'u1', 's1');

    await expect(registry.refresh()).resolves.toBeUndefined();

    expect(registry.usersIn('c1')).toEqual(['u1']);
    expect(warned).toHaveBeenCalledTimes(1);
  });
});
