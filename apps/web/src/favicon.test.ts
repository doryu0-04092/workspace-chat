import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// 本番のブラウザが /favicon.ico を読みに行き、S3 に無いため 403 がコンソールに出ていた（2026-09-18 の本番の確認。#627）。
// 画面の入口に自前のアイコンを示し、そのファイルがビルドの成果物に入る置き場（public）にあることを確かめる。
describe('ページのアイコン（#627）', () => {
  it('index.html が public に置いたアイコンを指している', () => {
    const html = readFileSync(join(webRoot, 'index.html'), 'utf8');
    const href = /<link\s+rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBe('/favicon.svg');
    const file = join(webRoot, 'public', href!.slice(1));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('<svg');
  });
});
