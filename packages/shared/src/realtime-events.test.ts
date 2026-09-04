import { describe, expect, it } from 'vitest';
import {
  REALTIME_EVENT_KINDS,
  REALTIME_EVENT_NAMES,
  type RealtimeEventName,
} from './realtime-events';

describe('リアルタイム配信のイベント定義', () => {
  // 文書（要件定義書 4.1 / 機能一覧 5.1）が「7種類」と宣言している。
  // ここが黙って増減すると、その宣言と実装がずれる。
  it('種類は文書のとおり7つである', () => {
    expect(REALTIME_EVENT_KINDS).toHaveLength(7);
  });

  it('種類の並びが文書の表と一致する', () => {
    expect([...REALTIME_EVENT_KINDS]).toEqual([
      'message:new',
      'message:updated',
      'message:deleted',
      'reaction:changed',
      'unread:updated',
      'typing',
      'presence:changed',
    ]);
  });

  // 入力中インジケータだけが start / stop の2つに分かれるため、名前は8つになる。
  it('イベント名は8つで、typing だけが2つに分かれる', () => {
    expect(REALTIME_EVENT_NAMES).toHaveLength(8);
    expect(REALTIME_EVENT_NAMES.filter((n) => n.startsWith('typing:'))).toEqual([
      'typing:start',
      'typing:stop',
    ]);
  });

  it('typing 以外の種類は、そのままイベント名になっている', () => {
    const namesFromKinds = REALTIME_EVENT_KINDS.filter((k) => k !== 'typing');
    for (const kind of namesFromKinds) {
      expect(REALTIME_EVENT_NAMES).toContain(kind as RealtimeEventName);
    }
  });

  it('イベント名が重複していない', () => {
    expect(new Set(REALTIME_EVENT_NAMES).size).toBe(REALTIME_EVENT_NAMES.length);
  });
});
