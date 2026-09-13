/**
 * ログに書く失敗の種類。**code があれば code だけを書く**——接続の失敗は code を持ち、メッセージには接続先が入りうる。
 * code が無いときに何を書くかは呼び出し側が選ぶ: `name` は種類の名前だけ、`message` はメッセージ
 * （**メッセージは、その経路の拒否のメッセージが接続先を含まない決まった文字列だと確かめたときだけ選ぶ**）。
 */
export function errorKind(error: unknown, fallback: 'name' | 'message'): string {
  if (!(error instanceof Error)) return 'unknown';
  return (
    (error as NodeJS.ErrnoException).code ?? (fallback === 'name' ? error.name : error.message)
  );
}
