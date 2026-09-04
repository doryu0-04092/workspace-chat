import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';

// 共有パッケージを差し替える。実数（7）を期待値にすると、App が数値を直書きしても
// テストが通ってしまい、「共有パッケージから読んでいる」ことを検証できない。
// 差し替えた値が画面に出れば、参照が生きていることの証明になる。
vi.mock('@workspace-chat/shared', () => ({
  REALTIME_EVENT_KINDS: ['a', 'b', 'c'],
}));

describe('App', () => {
  it('描画される', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'workspace-chat' })).toBeDefined();
  });

  it('種類数を共有パッケージから読んでいる', () => {
    render(<App />);
    expect(screen.getByText(/3 種類/)).toBeDefined();
  });
});
