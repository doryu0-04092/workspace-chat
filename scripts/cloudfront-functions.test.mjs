// CloudFront Functions のコード（infra/production/functions/）を、Node の vm で読み込んで確かめる。
// CloudFront Functions の実行環境は Node ではなく、コードはモジュールではなく大域の handler を持つ1つのスクリプトである。
// 使い方: node scripts/cloudfront-functions.test.mjs（scripts/terraform.test.sh から呼ぶ）
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../infra/production/functions/spa-rewrite.js', import.meta.url), 'utf8');
const context = {};
runInNewContext(source, context);
if (typeof context.handler !== 'function') {
  console.error('NG: spa-rewrite.js に大域の handler が無い');
  process.exit(1);
}

const cases = [
  ['/', '/index.html'],
  ['/login', '/index.html'],
  ['/workspaces/0190a1b2-0000-7000-8000-000000000001/channels/0190a1b2-0000-7000-8000-000000000002', '/index.html'],
  ['/index.html', '/index.html'],
  ['/assets/index-3f9a1c.js', '/assets/index-3f9a1c.js'],
  ['/favicon.ico', '/favicon.ico'],
];

let failed = 0;
for (const [uri, expected] of cases) {
  const actual = context.handler({ request: { uri, method: 'GET', headers: {} } }).uri;
  if (actual !== expected) {
    console.error(`NG: ${uri} → ${actual}（期待は ${expected}）`);
    failed++;
  }
}
if (failed > 0) process.exit(1);
console.log(`CloudFront Functions の検査を通過した（${cases.length} 件）`);
