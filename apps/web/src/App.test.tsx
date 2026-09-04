import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REALTIME_EVENT_KINDS } from '@workspace-chat/shared';
import { App } from './App';

describe('App', () => {
  it('描画され、共有パッケージから読んだ種類数を表示する', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'workspace-chat' })).toBeDefined();
    expect(screen.getByText(new RegExp(`${REALTIME_EVENT_KINDS.length} 種類`))).toBeDefined();
  });
});
