import type { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

/** Socket.IO のアダプタが使う Valkey の接続（配信の publish と、他のタスクからの配信の subscribe）。 */
export type RealtimeValkeyClients = {
  readonly publisher: Redis;
  readonly subscriber: Redis;
  onPublishRecovered(listener: () => void): void;
  notifyPublishRecovered(): void;
};

/** 上の接続を注入するトークン。 */
export const REALTIME_VALKEY_CLIENTS = Symbol('REALTIME_VALKEY_CLIENTS');

/**
 * アダプタ用の接続を作る。**Valkey が止まっている間は、接続を保ったままタスク間の配信共有だけが止まる**（要件定義書 4.2 の代償）。
 *
 * - **`@socket.io/redis-adapter` はコマンドの Promise を待たずに捨てる**（配信の `publish`、終了時の `unsubscribe` など）。
 *   Valkey が止まっている・接続を閉じたときにそれらが reject すると未処理の reject になり、Node の既定ではプロセスが落ちる。
 *   **両方の接続で、コマンドの Promise に失敗の受け手を付けてから渡す**（呼んだ側が待てば、失敗はそのまま届く）。
 *   同じタスクの中の配信は publish の前に済んでいるので、publish が失敗しても届く
 * - publish はレート制限と同じ接続（止まっていればすぐ失敗する）を使う
 * - **subscribe は専用の接続にし、繋がるまで溜める**（`enableOfflineQueue: true`）。アダプタは作ったときに1回だけ subscribe するため、
 *   起動の時点で繋がっていないと購読が失われる。購読は ioredis が再接続のたびにやり直す（`autoResubscribe` の既定）
 */
export function createRealtimeValkeyClients(base: Redis, logger: Logger): RealtimeValkeyClients {
  const subscriber = base.duplicate({
    enableOfflineQueue: true,
    commandTimeout: undefined,
    maxRetriesPerRequest: null,
  });
  subscriber.on('error', () => undefined);

  const recoveredListeners: (() => void)[] = [];
  const notifyPublishRecovered = () => {
    for (const listener of recoveredListeners) listener();
  };

  let failing = false;
  const publisher = withHandledRejections(base, (command, succeeded) => {
    if (command !== 'publish') return;
    if (succeeded && failing) {
      logger.log('Valkey に戻ったため、タスクをまたいで配信する');
      notifyPublishRecovered();
    }
    if (!succeeded && !failing) {
      logger.warn(
        'Valkey に publish できないため、タスクをまたぐ配信を止める（同じタスクの中には届く）',
      );
    }
    failing = !succeeded;
  });
  return {
    publisher,
    subscriber: withHandledRejections(subscriber),
    onPublishRecovered: (listener) => {
      recoveredListeners.push(listener);
    },
    notifyPublishRecovered,
  };
}

/** コマンドが返す Promise に失敗の受け手を付けた接続。`onSettled` は、コマンドの名前と成否を受け取る。 */
function withHandledRejections(
  client: Redis,
  onSettled: (command: string, succeeded: boolean) => void = () => undefined,
): Redis {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          result.then(
            () => onSettled(String(property), true),
            () => onSettled(String(property), false),
          );
        }
        return result;
      };
    },
  });
}
