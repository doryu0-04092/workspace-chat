/**
 * 起動時の復元の時限（`createSessionStore` の `timeoutSignal`）を、時間を待たずに手で切れるようにする。
 * 求められた時限のミリ秒を作られた順に `requested` に並べ、`fire(i)` で i 番目を打ち切る。
 */
export function manualTimeouts() {
  const controllers: AbortController[] = [];
  const requested: number[] = [];
  return {
    requested,
    timeoutSignal: (ms: number): AbortSignal => {
      const controller = new AbortController();
      controllers.push(controller);
      requested.push(ms);
      return controller.signal;
    },
    fire: (index: number): void => {
      const controller = controllers[index];
      if (!controller) throw new Error(`${index} 番目の時限は作られていない`);
      controller.abort(new DOMException('timed out', 'TimeoutError'));
    },
  };
}

/** 打ち切られるまで返らない応答。本物の fetch と同じく、`signal` が打ち切られたら断る。 */
export function hang(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init.signal;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}
