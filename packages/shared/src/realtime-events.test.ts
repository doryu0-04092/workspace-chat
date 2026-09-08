import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REALTIME_EVENT_KINDS,
  REALTIME_EVENT_NAMES,
  type RealtimeEventName,
} from './realtime-events';

/**
 * **文書を実際に読む。** 以前はテストの中にリテラルで写した並びと比べていたが、
 * それでは「コード内の写しどうし」を比べているだけで、
 * **文書と型定義が両方そろってずれても緑のまま通った**（#65）。
 *
 * 出所は要件定義書 4.1「リアルタイム配信の対象イベント」。
 * **表はここ1つだけである**（#9 で機能一覧 5.1 の重複を消した）。
 */
/**
 * リポジトリのルートからの相対パスで、実体を探す。
 *
 * **`import.meta.url` は使えない。** このパッケージは CommonJS で型検査しており
 * （`packages/shared/tsconfig.json` の `module`）、TS1343 で落ちる。
 * **`process.cwd()` を直に使うのも避ける**——リポジトリのルートから実行するか
 * `packages/shared` から実行するかで変わる。上へ辿って、**見つからなければ落とす。**
 */
function findRepoFile(relative: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`${relative} が見つからない（探索の起点: ${process.cwd()}）`);
    }
    dir = parent;
  }
}

const docPath = findRepoFile('docs/requirements.md');
const EVENT_TABLE_HEADING = '#### リアルタイム配信の対象イベント';

/**
 * 表の1列目を、行ごとにイベント名の配列として返す。
 *
 * 1行が複数の名前を持つことがある（`typing:start` / `typing:stop`）。
 * **行が「種類」、名前が「イベント名」である。** 文書が「N種類」と数えているのは行のほう。
 */
function readEventRows(): string[][] {
  const lines = readFileSync(docPath, 'utf8').split('\n');
  const start = lines.indexOf(EVENT_TABLE_HEADING);
  // **見つからないことを失敗にする。** 空を返すと「表が無い」と「見出しが変わった」が
  // 区別できず、下の比較が空配列どうしで通りかねない（偽の緑）。
  if (start < 0) {
    throw new Error(
      `要件定義書に見出し「${EVENT_TABLE_HEADING}」が無い。` +
        '見出しを変えたなら、この定数も併せて直すこと',
    );
  }
  const rows: string[][] = [];
  // **表の本文行を、別に数える。** 下の読み取りはコード書式（`…`）で始まる行だけを拾うため、
  // **書式を付け忘れた行は黙って読み飛ばされる。** 行が1つ増えても rows は変わらず、
  // 文書の「N種類」の宣言とも一致してしまうため、**表と型定義と宣言がすべて緑のままずれる。**
  let tableLines = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break; // 次の見出しで打ち切る
    if (line.startsWith('|')) tableLines += 1;
    if (!line.startsWith('| `')) continue; // 表の本文行だけを拾う（見出し行と区切り行を除く）
    const cell = line.split('|')[1]!.trim();
    rows.push([...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
  }
  // ヘッダ行と区切り行の2行を除いた本文の数が、読み取れた数と一致するはず。
  // **表が丸ごと無い場合は、ここでは判定しない。** tableLines が 0 だと bodyLines が -2 になり、
  // 「本文 -2 行」という原因を取り違えさせる失敗になって、下の「1行も読み取れない」に到達しない。
  // scripts/check-docs.sh も、表が無い場合を同じ形でガードしている。
  // **同じなのはここだけである**——見出しの一致条件は違う（あちらは `^#+ ` で見出しレベルを問わず、
  // こちらは行全体の完全一致）。見出しレベルを変えると、あちらは通りこちらだけが落ちる。
  const bodyLines = tableLines - 2;
  if (tableLines > 2 && bodyLines !== rows.length) {
    throw new Error(
      `要件定義書のイベント表に読み取れない行がある（本文 ${bodyLines} 行 / 読み取り ${rows.length} 行）。` +
        'イベント名はコード書式（`…`）で書くこと',
    );
  }
  if (rows.length === 0) {
    throw new Error('要件定義書のイベント表から1行も読み取れない（表の書式が変わった可能性）');
  }
  return rows;
}

/** 1行から種類を導く。名前が1つならそれ自体、複数なら `:` の前が種類である。 */
function kindOf(names: string[]): string {
  if (names.length === 1) return names[0]!;
  const prefixes = new Set(names.map((n) => n.split(':')[0]!));
  expect(prefixes.size, `1行に複数の名前があるのに前半が揃っていない: ${names.join(' / ')}`).toBe(
    1,
  );
  return [...prefixes][0]!;
}

describe('リアルタイム配信のイベント定義', () => {
  const rows = readEventRows();

  // **文書の表と突き合わせる。** テストの中に並びを写さない。
  it('種類の並びが、要件定義書 4.1 の表と一致する', () => {
    expect([...REALTIME_EVENT_KINDS]).toEqual(rows.map(kindOf));
  });

  it('イベント名の並びが、要件定義書 4.1 の表と一致する', () => {
    expect([...REALTIME_EVENT_NAMES]).toEqual(rows.flat());
  });

  // 文書は「N種類」と宣言している。その数がこの表の行数と一致することは
  // scripts/check-docs.sh の検査5 が見ている。ここでは型定義との一致だけを見る。
  it('種類の数が、表の行数と一致する', () => {
    expect(REALTIME_EVENT_KINDS).toHaveLength(rows.length);
  });

  // 入力中インジケータだけが start / stop の2つに分かれるため、名前は種類より多くなる。
  it('typing だけが2つに分かれる', () => {
    expect(REALTIME_EVENT_NAMES.filter((n) => n.startsWith('typing:'))).toEqual([
      'typing:start',
      'typing:stop',
    ]);
  });

  it('typing 以外の種類は、そのままイベント名になっている', () => {
    for (const kind of REALTIME_EVENT_KINDS.filter((k) => k !== 'typing')) {
      expect(REALTIME_EVENT_NAMES).toContain(kind as RealtimeEventName);
    }
  });

  it('イベント名が重複していない', () => {
    expect(new Set(REALTIME_EVENT_NAMES).size).toBe(REALTIME_EVENT_NAMES.length);
  });
});
