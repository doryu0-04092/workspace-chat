/**
 * 本文のメンション（機能一覧 9.1。実装時に決めた値）。`@` に続くユーザーID（英数字とアンダースコアの 3〜30 文字。1.1）で、
 * **前が英数字・アンダースコアでなく、後ろに英数字・アンダースコアが続かない**もの（`mail@alice` や、31 文字以上の綴りの先頭は拾わない）。
 *
 * **api（投稿時に解決して保存する）と web（表示する）で同じものを使う**——2箇所に書くと、保存した対象と画面で拾う `@` が食い違う。
 * api はコードの中の `@` も拾い、web はコードとリンクの文字の中を置き換えない（機能一覧 9.1 に代償を書いた）。
 *
 * **踏むと壊れる: `g` を持つ共有のインスタンスである。`matchAll` 以外（`test`・`exec`）で使わない**——
 * `lastIndex` が呼び出しをまたいで持ち越され、同じ本文でも結果が交互に変わる（`matchAll` は内部で写しを作るため持ち越さない）。
 */
export const MENTION_PATTERN = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{3,30})(?![A-Za-z0-9_])/g;

/**
 * 入力欄のカーソルの直前で書きかけのメンション（補完候補を出す。機能一覧 9.1）。前の文字の境界は `MENTION_PATTERN` と同じで、
 * 書きかけのため長さは 0〜30 文字（`@` だけでも当たる）。**カーソルの前の文字列の末尾に当てる**（`exec` で使う）。
 */
export const MENTION_BEING_TYPED = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{0,30})$/;

/** 本文に現れたユーザーID を、小文字にして、最初に現れた順に重複なく返す（照合は大文字小文字によらない。機能一覧 1.1）。 */
export function mentionedLoginIds(body: string): string[] {
  const found: string[] = [];
  for (const [, loginId] of body.matchAll(MENTION_PATTERN)) {
    if (loginId !== undefined) found.push(loginId.toLowerCase());
  }
  return [...new Set(found)];
}
