type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;

/**
 * 検査で使う偽の Socket.IO のソケット。画面が呼ぶもの（connect・disconnect・on・off・emit）を記録し、
 * サーバーの側の出来事（接続の受け入れ・断り・切断・配信）を検査から起こす。
 */
export class FakeSocket {
  connected = false;
  active = false;
  connects = 0;
  disconnects = 0;
  readonly sent: { event: string; body: unknown }[] = [];
  /** 要求への acknowledgement。既定は入れた（在席は空）。 */
  acknowledge: (event: string, body: unknown) => unknown = () => ({ ok: true, present: [] });
  private readonly listeners = new Map<string, Set<Listener>>();

  /** `token` は、画面が接続に渡した「いまのアクセストークン」を読む関数。 */
  constructor(readonly token: () => string | null) {}

  connect(): this {
    this.connects += 1;
    this.active = true;
    return this;
  }

  disconnect(): this {
    this.disconnects += 1;
    this.connected = false;
    this.active = false;
    return this;
  }

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, body: unknown, ack?: Ack): this {
    this.sent.push({ event, body });
    if (ack) queueMicrotask(() => ack(this.acknowledge(event, body)));
    return this;
  }

  sentCount(event: string): number {
    return this.sent.filter((s) => s.event === event).length;
  }

  /** サーバーが接続を受け入れた。初回も再接続も `connect` が届く（Socket.IO の文書「upon connection and reconnection」）。 */
  open(): void {
    this.connected = true;
    this.active = true;
    this.fire('connect');
  }

  /** ミドルウェアが断った。自動では繋ぎ直さない（`active` が false になる）。 */
  refuse(code: string): void {
    this.connected = false;
    this.active = false;
    this.fire('connect_error', Object.assign(new Error(code), { data: { code } }));
  }

  /** 通信が切れた。自動で繋ぎ直す側の切断（`active` のまま）。 */
  drop(): void {
    this.connected = false;
    this.fire('disconnect', 'transport close');
  }

  /** サーバーが配った。 */
  deliver(event: string, payload: unknown): void {
    this.fire(event, payload);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}
