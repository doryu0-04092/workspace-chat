// @testing-library/react の自動クリーンアップは、グローバルの afterEach が
// 存在するときにだけ登録される。この設定では globals を使っていないため、
// 明示的に登録する。登録しないと、前のテストが描画した DOM が次に残る。
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

// jsdom は要素の scrollBy を持たない。react-virtuoso は先頭に行を足したとき（firstItemIndex を減らしたとき）に呼ぶため、
// 無いとメッセージの一覧の検査が例外で落ちる。位置の検査は行の data-item-index で行い、スクロールの量は見ない。
HTMLElement.prototype.scrollBy = () => undefined;
