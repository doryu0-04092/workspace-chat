/**
 * 待ち受けポートを決める。
 *
 * Number() は不正な文字列に対して NaN を返し、listen(NaN) は
 * **任意の空きポートで待ち受ける**。設定を間違えたまま起動してしまい、
 * 「繋がらない」の原因が分からなくなる。ここで落とす。
 *
 * main.ts から独立させているのは、main.ts を読み込むと bootstrap() が
 * 走ってしまい、テストからは呼べないためである。
 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 3000;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT の値が不正です（1〜65535 の整数を指定してください）: ${raw}`);
  }
  return port;
}
