#!/usr/bin/env node
// `npm audit --json` の出力を判定する。
//
// **なぜ `npm audit --audit-level=high` をそのまま使わないか。**
// 修正版が公開されていない high 以上が1件でも出ると、全 PR のマージ経路が塞がる。
// npm audit には「この1件だけ無視する」指定が無い（npm 11.13.0 の --help で確認）。
// 閾値（--audit-level）を下げる形は採らない——その1件だけでなく、
// **次に来る件も一緒に見逃す**ためである。
//
// **落とす条件は2つある。片方だけでは足りない。**
//   1. 許可していない high 以上が残っている  → 塞ぐか、許可に載せる判断をする
//   2. 許可した id が1件も出なくなった        → **上流が直った合図。** 許可の行を消す
//
// 2 が無いと、許可は消えないまま残り続ける。**「通している」ことを忘れる。**
//
// **汎用化するときは、このファイルだけを持っていく。**
// リポジトリ固有の事実は scripts/audit-allowlist.json 側にある。
// ただし `npm audit --json` の形は npm 固有であり、pnpm / yarn では
// readReport() を差し替える必要がある。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCKING = new Set(['high', 'critical']);

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('使い方: node scripts/check-audit.mjs <npm audit --json の出力ファイル>');
  process.exit(2);
}

// **JSON として読めなければ落とす。** registry の応答が壊れたときに
// 「脆弱性ゼロ」と読み違えるのを避ける。
function readJson(path, what) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`${what}を読めない: ${path}\n  ${e.message}`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`${what}が JSON として読めない: ${path}\n  ${e.message}`);
    console.error('--- 先頭 500 文字 ---');
    console.error(raw.slice(0, 500));
    process.exit(2);
  }
}

const report = readJson(reportPath, 'npm audit の出力');
const allowlist = readJson(join(HERE, 'audit-allowlist.json'), '許可一覧');

// npm の出力（auditReportVersion 2）から、high 以上の advisory を集める。
// via には文字列（別のパッケージ経由）と物（advisory 本体）が混ざる。
// 物の側だけを見る。
function collectFindings(rep) {
  const found = new Map(); // id -> { id, severity, title, packages:Set }
  for (const [pkg, v] of Object.entries(rep.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      if (!id) continue;
      const cur = found.get(id) ?? {
        id,
        severity: via.severity,
        title: via.title,
        packages: new Set(),
      };
      cur.packages.add(via.name ?? pkg);
      found.set(id, cur);
    }
  }
  return found;
}

const found = collectFindings(report);
const allowed = new Map(allowlist.allow.map((a) => [a.id, a]));

const blocking = [...found.values()].filter((f) => BLOCKING.has(f.severity));
const notAllowed = blocking.filter((f) => !allowed.has(f.id));
const stale = [...allowed.values()].filter((a) => !found.has(a.id));
const inEffect = blocking.filter((f) => allowed.has(f.id));

if (inEffect.length > 0) {
  console.log('通している advisory（塞いだのではない）:');
  for (const f of inEffect) {
    const a = allowed.get(f.id);
    console.log(`  ${f.id}  ${a.package}  ${f.severity}`);
    console.log(`    期限: ${a.until}`);
    console.log(`    記録: #${a.issue}`);
  }
  console.log('');
}

let failed = false;

if (notAllowed.length > 0) {
  failed = true;
  console.error(`許可していない high 以上が ${notAllowed.length} 件ある。`);
  for (const f of notAllowed) {
    console.error(`  ${f.id}  ${[...f.packages].join(', ')}  ${f.severity}`);
    console.error(`    ${f.title}`);
  }
  console.error('');
  console.error('塞ぎ方は README「依存の版を上げない方針」の表による。');
  console.error('塞げないと判断したときだけ scripts/audit-allowlist.json に足す。');
  console.error('**閾値を下げる形は採らない。**');
  console.error('');
}

if (stale.length > 0) {
  failed = true;
  console.error(`許可した advisory が ${stale.length} 件、出力に現れない。`);
  console.error('**上流が直ったか、その依存が消えた合図である。**');
  for (const a of stale) {
    console.error(`  ${a.id}  ${a.package}  （#${a.issue}）`);
  }
  console.error('');
  console.error('scripts/audit-allowlist.json から該当の行を消す。');
  console.error('上流が直っているなら、その版を取り込む。');
  console.error('');
}

if (failed) process.exit(1);

console.log(
  `high 以上のうち、許可していないものは無い（検出 ${found.size} 件 / うち high 以上 ${blocking.length} 件）。`,
);
