import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeValkeyClients } from './realtime-valkey';

/** publish の成否を順に返す偽の接続と、そこから作られる購読の接続（接続の遷移のイベントを出せる）。 */
function fakeRedis(outcomes: boolean[]): { redis: Redis; subscriber: EventEmitter } {
  const subscriber = new EventEmitter();
  const client = {
    publish: vi.fn(async () => {
      if (outcomes.shift() === false) throw new Error('Valkey に繋がらない');
      return 1;
    }),
    duplicate: vi.fn(() => subscriber),
  };
  return { redis: client as unknown as Redis, subscriber };
}

/** 失敗の受け手（then）が走り終わるまで待つ。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 決定・2026-09-13・依頼側: Valkey が止まっている間のキック・退出で外し損ねた接続は、publish が戻ったときにも照合して外す。
describe('Valkey への publish が戻ったときの知らせ', () => {
  afterEach(() => vi.restoreAllMocks());

  async function publishInOrder(outcomes: boolean[]) {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const clients = createRealtimeValkeyClients(fakeRedis([...outcomes]).redis, new Logger('test'));
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

// 購読の接続の遷移も残す（#288）。publish が戻っても、購読の接続が戻ったとは限らない。
describe('Valkey の購読の接続の遷移のログ', () => {
  afterEach(() => vi.restoreAllMocks());

  function subscribed() {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { redis, subscriber } = fakeRedis([]);
    createRealtimeValkeyClients(redis, new Logger('test'));
    return { warned, logged, subscriber };
  }

  it('最初に繋がったときはログを出さない', () => {
    const { warned, logged, subscriber } = subscribed();

    subscriber.emit('ready');

    expect(warned).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });

  it('切れて繋がり直そうとしている間は warn を1回だけ出し、戻ったら log を1回出し、また切れたら warn を出す', () => {
    const { warned, logged, subscriber } = subscribed();
    subscriber.emit('ready');

    subscriber.emit('reconnecting');
    subscriber.emit('reconnecting');
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0]?.[0])).toContain('購読の接続が切れた');

    subscriber.emit('ready');
    subscriber.emit('ready');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('購読の接続が戻った');

    subscriber.emit('reconnecting');
    expect(warned).toHaveBeenCalledTimes(2);
  });
});
