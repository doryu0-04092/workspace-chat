// CloudFront Functions のコード（infra/production/functions/）を、Node の vm で読み込んで確かめる。
// CloudFront Functions の実行環境は Node ではなく、コードはモジュールではなく大域の handler を持つ1つのスクリプトである。
// 使い方: node scripts/cloudfront-functions.test.mjs（scripts/terraform.test.sh から呼ぶ）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/** 関数のファイルを読み込み、大域の handler を返す（無ければ落とす）。 */
function load(file) {
  const source = readFileSync(
    join(import.meta.dirname, '../infra/production/functions', file),
    'utf8',
  );
  const context = {};
  runInNewContext(source, context);
  if (typeof context.handler !== 'function') {
    console.error(`NG: ${file} に大域の handler が無い`);
    process.exit(1);
  }
  return context.handler;
}

let failed = 0;
let total = 0;

/** handler に uri を渡した結果を、期待（書き換えた先の uri か、`{ statusCode }` の応答）と比べる。 */
function check(file, handler, uri, expected) {
  total++;
  const result = handler({ request: { uri, method: 'GET', headers: {} } });
  const actual = 'statusCode' in result ? `応答 ${result.statusCode}` : result.uri;
  const wanted = typeof expected === 'string' ? expected : `応答 ${expected.statusCode}`;
  if (actual !== wanted) {
    console.error(`NG: ${file}: ${uri} → ${actual}（期待は ${wanted}）`);
    failed++;
  }
}

const spaRewrite = load('spa-rewrite.js');
for (const [uri, expected] of [
  ['/', '/index.html'],
  ['/login', '/index.html'],
  [
    '/workspaces/0190a1b2-0000-7000-8000-000000000001/channels/0190a1b2-0000-7000-8000-000000000002',
    '/index.html',
  ],
  ['/index.html', '/index.html'],
  ['/assets/index-3f9a1c.js', '/assets/index-3f9a1c.js'],
  ['/favicon.ico', '/favicon.ico'],
]) {
  check('spa-rewrite.js', spaRewrite, uri, expected);
}

// /files を剥がし、S3 のキーと同じ形にする（要件定義書 4.3）。配信用のキーの形に当たらない URI は剥がさず 404 にする
// （「確かめる URL の形」: ドットセグメント・多重スラッシュ・符号化したドットとスラッシュ。要件定義書 4.3）。
const stripFilesPrefix = load('strip-files-prefix.js');
const key =
  'workspace/0190a1b2-0000-7000-8000-000000000001/channel/0190a1b2-0000-7000-8000-000000000002/0190a1b2-0000-7000-8000-000000000003';
const notFound = { statusCode: 404 };
for (const [uri, expected] of [
  [`/files/${key}/report.pdf`, `/${key}/report.pdf`],
  [`/files/${key}/_env.txt`, `/${key}/_env.txt`],
  [`/files/${key}/a..b.tar-gz_1.zip`, `/${key}/a..b.tar-gz_1.zip`],
  [`/files/${key}/../../channel/0190a1b2-0000-7000-8000-000000000009/x/y.png`, notFound],
  [`/files/${key}/./y.png`, notFound],
  [`/files/${key}/..`, notFound],
  [`/files//quarantine/${key}/y.png`, notFound],
  [`/files/${key}//y.png`, notFound],
  [`/files/${key}/%2E%2E/y.png`, notFound],
  [`/files/${key}/%2e%2e%2fy.png`, notFound],
  [`/files/${key}%2F..%2Fy.png`, notFound],
  [`/files/${key}/y.png/`, notFound],
  [`/files/${key}/y\\..\\z.png`, notFound],
  [`/files/${key}/.hidden`, notFound],
  ['/files/', notFound],
  ['/files', notFound],
  [`/avatars/../files/${key}/y.png`, notFound],
  [`/filesx/${key}/y.png`, notFound],
]) {
  check('strip-files-prefix.js', stripFilesPrefix, uri, expected);
}

if (failed > 0) process.exit(1);
console.log(`CloudFront Functions の検査を通過した（${total} 件）`);
