import { vi } from 'vitest';

/**
 * 標準出力・標準エラーに書かれた内容を控える部品。ログと EMF のメトリクスは標準出力に書かれるため、
 * 実際に書かれた行で確かめる。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 *
 * 書き込みは既定で元の `write` へ通す。`passThrough: false` で握る（起動の失敗のスタックをテストの出力に混ぜない bootstrap.test.ts）。
 */
export function captureOutput(
  name: 'stdout' | 'stderr' = 'stdout',
  options: { passThrough?: boolean } = {},
): CapturedOutput {
  const passThrough = options.passThrough ?? true;
  const stream = process[name];
  const chunks: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, 'write').mockImplementation(((
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    chunks.push(String(chunk));
    return passThrough ? (original as (...args: unknown[]) => boolean)(chunk, ...rest) : true;
  }) as typeof stream.write);
  return {
    chunks,
    jsonLines<T>(): T[] {
      return chunks
        .flatMap((chunk) => chunk.split('\n'))
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as T);
    },
    restore(): void {
      spy.mockRestore();
    },
  };
}

export type CapturedOutput = {
  /** 書かれたままの断片。 */
  readonly chunks: readonly string[];
  /** 書かれた行のうち JSON として読めるもの。Vitest 自身の出力が混ざるため、JSON の行だけを拾う。 */
  jsonLines<T>(): T[];
  restore(): void;
};
