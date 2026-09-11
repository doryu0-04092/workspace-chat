import { describe, expect, it, vi } from 'vitest';

const start = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./bootstrap', () => ({ start }));

// main.ts は起動の入口であり、組み立ては bootstrap.ts の start が持つ。ここでは start を通ることだけを見る。
describe('main.ts', () => {
  it('読み込むと start を1回呼ぶ', async () => {
    await import('./main');
    expect(start).toHaveBeenCalledOnce();
  });
});
