import { Injectable } from '@nestjs/common';

/**
 * アプリが出すメトリクス（要件定義書 4.6）。**CloudWatch の埋め込みメトリクス形式（EMF）の JSON を、ログと同じ標準出力に1行で出す**
 * （決定・2026-09-12・依頼側。#287。構造化ログとメトリクスの両方を出す）。
 *
 * - EMF は CloudWatch Logs が受け取った行から自動でメトリクスを取り出す仕様であり、SDK の呼び出しも依存の追加も要らない
 *   （AWS「Specification: Embedded metric format」。根の `_aws` に `Timestamp` と `CloudWatchMetrics`〔`Namespace`・`Dimensions`・`Metrics`〕を持ち、
 *   `Metrics[].Name` と同じ名前の最上位の数値が値になる。「The root node MAY contain any other members」）
 * - ログの行と同じく `level` と `message` を持たせる（要件定義書 4.6「ログは構造化 JSON」。logging.test.ts が全行に求める形）
 * - **次元（Dimensions）は置かない**（空の DimensionSet）。次元の組み合わせごとにメトリクスが増えて課金されるため（同仕様の注意）。
 *   タスクをまたいだ合計として見る
 * - **ログの出力先が CloudWatch Logs でないとメトリクスにならない**（手元では JSON の行が出るだけ）。ECS の awslogs ドライバが前提
 */

export const METRIC_NAMESPACE = 'workspace-chat/api';

/** CloudWatch の単位のうち、ここで使うもの。 */
export type MetricUnit = 'Count' | 'Milliseconds';

export type Metric = { readonly name: string; readonly unit: MetricUnit; readonly value: number };

/** EMF の1文書。`Metrics[].Name` と同じ名前の最上位の数値を持つ。 */
export function emfDocument(metrics: readonly Metric[], timestamp = Date.now()): object {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit })),
        },
      ],
    },
    ...Object.fromEntries(metrics.map(({ name, value }) => [name, value])),
    level: 'log',
    message: { event: 'metric', names: metrics.map(({ name }) => name) },
  };
}

/** メトリクスを標準出力に書く。**値以外（利用者の ID・トークン・本文）を載せない**——メトリクスの行も CloudWatch Logs に残る。 */
@Injectable()
export class MetricsWriter {
  write(metrics: readonly Metric[]): void {
    process.stdout.write(`${JSON.stringify(emfDocument(metrics))}\n`);
  }
}
