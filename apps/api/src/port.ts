/**
 * 待ち受けポートを決める。
 *
 * **10進の数字だけを受け付ける。** Number() は不正な文字列に NaN を返し、
 * listen(NaN) は任意の空きポートで待ち受ける。加えて Number() は
 * 16進（0x1F8 → 504）・2進（0b101 → 5）・指数（1e3 → 1000）・前後の空白も
 * 受理するため、Number() の結果だけを見ると設定ミスを取り逃がす。
 *
 * main.ts から独立させているのは、main.ts を読み込むと bootstrap() が
 * 走ってしまい、テストからは呼べないためである。
 *
 * **web の開発サーバーの中継（apps/web/vite.config.ts の server.proxy）も、この関数で
 * 中継先のポートを決める。** 規則を変えると api と web の両方に効く。
 * **vite.config.ts を評価するものは、すべてこの関数を通る**——開発サーバーのほか、
 * web のビルド（vite build）と、ルートの vitest.config.ts が web のプロジェクトで
 * extends するテスト（npm test）である。PORT が不正な値だと、設定を読む時点で
 * 例外になり、api の起動だけでなく web のビルドとテストも落ちる。
 * api と web は別プロセスで環境変数を共有しないため、**両方の端末に同じ PORT を渡す**
 * （README「動かす」）。片方にだけ渡すと、web は 3000 に繋ぎに行き、api のログには何も出ない。
 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined) {
    return 3000;
  }
  // PORT= と空のまま渡す事故は .env や ECS のタスク定義で現実に起きる。
  // 既定値に落とすと、8080 のつもりが黙って 3000 で待ち受ける。
  // この関数の目的は設定ミスを起動時に落とすことなので、空も落とす。
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`PORT の値が不正です（10進の整数を指定してください）: ${raw}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`PORT の値が範囲外です（1〜65535 を指定してください）: ${raw}`);
  }
  return port;
}
