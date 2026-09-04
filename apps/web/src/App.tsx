import { REALTIME_EVENT_KINDS } from '@workspace-chat/shared';

/**
 * 雛形の画面。**要件にある画面ではない。**
 *
 * 共有パッケージの値を描画しているのは、フロントとバックが同じ定義を参照して
 * いることをビルドとテストの両方で確かめるためである（CLAUDE.md 3）。
 * 最初の機能を実装する時点で置き換える。
 */
export function App() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">workspace-chat</h1>
      <p className="mt-2 text-slate-600">
        リアルタイム配信のイベントは {REALTIME_EVENT_KINDS.length} 種類。
      </p>
    </main>
  );
}
