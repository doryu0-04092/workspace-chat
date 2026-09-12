import { describe, expect, it, vi } from 'vitest';
import { METRIC_NAMESPACE, MetricsWriter, emfDocument } from './metrics';

// CloudWatch の埋め込みメトリクス形式（EMF）の仕様（AWS の文書「Specification: Embedded metric format」）に沿った1行を作る。
describe('EMF の文書', () => {
  it('_aws（Timestamp・Namespace・Dimensions・Metrics）と、Name と同じ名前の最上位の数値を持つ', () => {
    const doc = emfDocument(
      [
        { name: 'WebSocketConnections', unit: 'Count', value: 3 },
        { name: 'WebSocketConnects', unit: 'Count', value: 1 },
      ],
      1700000000000,
    ) as Record<string, unknown> & { _aws: Record<string, unknown> };

    expect(doc._aws).toEqual({
      Timestamp: 1700000000000,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: [
            { Name: 'WebSocketConnections', Unit: 'Count' },
            { Name: 'WebSocketConnects', Unit: 'Count' },
          ],
        },
      ],
    });
    expect(doc.WebSocketConnections).toBe(3);
    expect(doc.WebSocketConnects).toBe(1);
    // 要件定義書 4.6「ログは構造化 JSON」。ログの行と同じく level と message を持つ（logging.test.ts が全行に求める）。
    expect(typeof doc.level).toBe('string');
    expect(doc.message).toBeDefined();
  });
});

describe('MetricsWriter', () => {
  it('標準出力に1行の JSON として書き、末尾に改行を付ける', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      new MetricsWriter().write([{ name: 'WebSocketConnections', unit: 'Count', value: 0 }]);
    } finally {
      spy.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(written[0]!.endsWith('\n')).toBe(true);
    expect(written[0]!.slice(0, -1)).not.toContain('\n');
    const parsed = JSON.parse(written[0]!) as { _aws: unknown; WebSocketConnections: number };
    expect(parsed._aws).toBeDefined();
    expect(parsed.WebSocketConnections).toBe(0);
  });
});
