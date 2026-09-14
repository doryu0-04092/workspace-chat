import { REALTIME_PATH, REALTIME_TRANSPORTS } from '@workspace-chat/shared';
import { describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('socket.io-client', () => ({ io }));

const { connectRealtime } = await import('./connect');

describe('本番のリアルタイムの接続の組み立て（F-16。機能一覧 5.2）', () => {
  it('同じ origin に、パスは /api/socket.io/・WebSocket だけで、自分からは繋がず、auth には呼ぶたびにいまのトークンを載せる', () => {
    let current: string | null = 't1';
    connectRealtime(() => current);

    expect(io).toHaveBeenCalledTimes(1);
    const args = io.mock.calls[0] as unknown[];
    expect(args).toHaveLength(1);
    const options = args[0] as Record<string, unknown>;
    expect(options.path).toBe(REALTIME_PATH);
    expect(options.transports).toEqual([...REALTIME_TRANSPORTS]);
    expect(options.autoConnect).toBe(false);

    const auth = options.auth as (callback: (data: object) => void) => void;
    const seen: object[] = [];
    auth((data) => seen.push(data));
    current = 't2';
    auth((data) => seen.push(data));
    expect(seen).toEqual([{ token: 't1' }, { token: 't2' }]);
  });
});
