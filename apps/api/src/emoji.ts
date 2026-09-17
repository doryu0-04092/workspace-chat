/**
 * 絵文字1つ（Unicode の RGI_Emoji に当たる列1つ。肌の色・ZWJ で繋いだ列・国旗も1つ）。
 * プロフィールのステータス（F-04。機能一覧 1.3）とリアクション（F-18。機能一覧 7）が使う。
 * JSON Schema の pattern（Unicode の `u` フラグ）では文字列の性質を書けないため、仕様ではなくここで確かめる。
 * 文字列の性質には `v` フラグが要る。tsconfig.base.json の target（ES2022）ではリテラルに書けないため、コンストラクタで作る（実行する Node 24 は扱える）。
 */
const SINGLE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

export function isSingleEmoji(value: string): boolean {
  return SINGLE_EMOJI.test(value);
}
