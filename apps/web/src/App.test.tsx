import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';

// 共有パッケージのうち、この画面が読んでいる値だけを差し替える。
// 実数（7）を期待値にすると、App が数値を直書きしてもテストが通ってしまい、
// 「共有パッケージから読んでいる」ことを検証できない。
//
// モジュール全体を置き換えず、元の中身を広げてから1つだけ上書きする。
// 全体を置き換えると、共有パッケージに export が増えたときに
// それらが undefined になり、この画面と関係のない理由で落ちる。
vi.mock('@workspace-chat/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace-chat/shared')>()),
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
