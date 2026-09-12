import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeValkeyClients } from './realtime-valkey';

/** publish の成否を順に返す偽の接続。 */
function fakeRedis(outcomes: boolean[]): Redis {
  const client = {
    publish: vi.fn(async () => {
      if (outcomes.shift() === false) throw new Error('Valkey に繋がらない');
      return 1;
    }),
    duplicate: vi.fn(() => ({ on: vi.fn() })),
  };
  return client as unknown as Redis;
}

/** 失敗の受け手（then）が走り終わるまで待つ。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 決定・2026-09-13・依頼側: Valkey が止まっている間のキック・退出で外し損ねた接続は、publish が戻ったときにも照合して外す。
describe('Valkey への publish が戻ったときの知らせ', () => {
  afterEach(() => vi.restoreAllMocks());

  async function publishInOrder(outcomes: boolean[]) {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const clients = createRealtimeValkeyClients(fakeRedis([...outcomes]), new Logger('test'));
    const recovered = vi.fn();
    clients.onPublishRecovered(recovered);
    for (let remaining = outcomes.length; remaining > 0; remaining -= 1) {
      await clients.publisher.publish('channel', 'message').catch(() => undefined);
      await settle();
    }
    return recovered;
  }

  it('失敗の後に成功したときに1回だけ知らせる', async () => {
    expect(await publishInOrder([false, false, true, true])).toHaveBeenCalledTimes(1);
  });

  it('失敗が無ければ知らせない（最初の成功も、成功が続くときも）', async () => {
    expect(await publishInOrder([true, true, true])).not.toHaveBeenCalled();
  });

  it('止まって戻るたびに知らせる', async () => {
    expect(await publishInOrder([false, true, false, true])).toHaveBeenCalledTimes(2);
  });
});
