// @testing-library/react の自動クリーンアップは、グローバルの afterEach が
// 存在するときにだけ登録される。この設定では globals を使っていないため、
// 明示的に登録する。登録しないと、前のテストが描画した DOM が次に残る。
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);
