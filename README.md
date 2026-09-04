# workspace-chat

Slack 風のチャットアプリケーション。スクール課題として作成する。

ワークスペース単位でチャンネルを持ち、スレッド・リアクション・メンション・検索を備えた
リアルタイムチャットを提供する。

## 現在の状態

**要件定義フェーズは完了。** 実装は未着手。

| フェーズ | 状態 |
|---|---|
| 要件定義 | **完了**（2026-09-04） |
| AI コードレビューの観点 | **完了**（[REVIEW.md](REVIEW.md)） |
| AI コードレビューの設定 | **完了**（[claude_code_review.yml](.github/workflows/claude_code_review.yml)） |
| ドキュメント検査の CI | **完了**（docs.yml） |
| lint・型チェック・ビルド・テストの CI | **完了**（ci.yml） |
| プロジェクトの雛形 | **完了**（apps/api / apps/web / packages/shared） |
| 開発環境の Docker（DB・Redis） | 未着手（次の作業） |
| 実装 | 未着手 |

**開発方式はテスト駆動開発（TDD）。** 実装より先にテストを書き、失敗を確認してから実装する
（[要件定義書](docs/requirements.md) 4.8）。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [要件定義書](docs/requirements.md) | 目的・スコープ・非機能要件・**実装しない機能とその理由**・**法令上の位置づけ** |
| [機能一覧](docs/features.md) | 全機能の一覧と受け入れ条件。**要件の出所（要求 / 派生 / 提案・承認済）を区分表記** |
| [技術スタック](docs/tech-stack.md) | 採用技術とバージョン、選定理由、LTS の根拠、**リソースのサイジング** |
| [コードレビュー観点](REVIEW.md) | AI・人間の双方が使うレビュー観点。重大度の定義と、報告しないことの明示 |

## 技術スタック（概要）

```
フロントエンド  React 19.2 + Vite 7 + TypeScript 5 + Tailwind CSS 4
バックエンド    Node.js 24 LTS + NestJS 11 + Socket.IO 4 + Prisma
データベース    PostgreSQL 17 + pg_bigm（日本語全文検索）
インフラ        AWS（CloudFront / S3 / ALB / ECS Fargate / RDS / ElastiCache）+ Terraform
```

詳細と選定理由は [技術スタック](docs/tech-stack.md) を参照。

## 主な機能

- ワークスペースとチャンネル（パブリック / プライベート）
- リアルタイムのメッセージ送受信（WebSocket）
- スレッド返信
- 絵文字リアクション
- メンション（個人 / `@here` / `@channel`）
- ダイレクトメッセージ（1対1）
- 画像・動画・ファイルの添付
- メッセージ検索（日本語全文検索 + 絞り込み演算子）
- 未読管理とブラウザ通知
- Markdown 表示とコードスニペット
- チャンネルのアーカイブと復元（削除ではなく、取り返しのつく形にする）
- アカウントの削除と、リカバリーコードによるパスワード復旧

**全 38 件**（要求 19 / 派生 9 / 提案・承認済 10）。各機能の受け入れ条件は
[機能一覧](docs/features.md) を参照。
**実装しない機能**は [要件定義書](docs/requirements.md) の 3.4 に理由とともに記載する。

## 開発の始め方

**Node.js 24 が要る。** `package.json` の `engines` に加えて `.npmrc` で
`engine-strict=true` を設定しているため、**合わない Node ではインストールが止まる**
（既定では警告が出るだけで通ってしまう）。

```
npm ci          依存を入れる（package-lock.json のとおりに入る）
npm run build   3つのワークスペースを順に組む
npm test        テストを実行する
```

CI が回すのと同じ検査を手元で通すには次を順に実行する。

```
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
```

### 動かす

**先に `npm run build` を1度通す。** `packages/shared` は `dist/` を公開しており、
`dist/` は追跡していない。組んでいない状態で起動すると
`@workspace-chat/shared` が解決できずに落ちる。

| 対象 | 手順 |
|---|---|
| フロントエンド | `npm run dev -w @workspace-chat/web` |
| バックエンド | **端末を2つ使う。** 片方で `npm run build:watch -w @workspace-chat/api`、もう片方で `npm run dev -w @workspace-chat/api` |

**`packages/shared` を編集したら `npm run build -w @workspace-chat/shared` を実行する。**
api の `build:watch` が見ているのは api の `src` だけで、
**共有パッケージを直しても api も web も古い `dist` を読み続ける。**
「直したはずの型が反映されない」の原因はたいていこれである。

バックエンドが2端末なのは、**ビルドと実行を分けているため**である。
NestJS 11 は CommonJS で、TypeScript をそのまま実行しない。
1コマンドにまとめるには監視ツールを足すことになるので、**依存を増やさない側に倒している。**

待ち受けポートは `PORT` で変えられる。**不正な値を渡すと起動時に落ちる**
（`Number()` は不正な文字列に `NaN` を返し、`listen(NaN)` は任意の空きポートで
待ち受けてしまうため）。

## AI コードレビュー

PR の作成時と、その PR のブランチへの push 時に、Claude Code が
[コードレビュー観点](REVIEW.md) に沿ってレビューし、PR にコメントする
（[claude_code_review.yml](.github/workflows/claude_code_review.yml)）。

**AI レビューは指摘するだけであり、承認の責任は持たない。** マージの可否は人間が判断する。

### 動かすために必要な設定

| # | 作業 | 場所 |
|---|---|---|
| 1 | Claude GitHub App をこのリポジトリにインストールする | https://github.com/apps/claude |
| 2 | `claude setup-token` で OAuth トークンを発行する | ローカルのターミナル |
| 3 | 発行した値を Secret `CLAUDE_CODE_OAUTH_TOKEN` に登録する | Settings → Secrets and variables → Actions |

**1 を省略すると動かない。** ワークフローはトークンを直接使わず、GitHub Actions の OIDC トークンを
Claude GitHub App のトークンに交換する経路を通るため、App が入っていないと交換に失敗する。
これが `id-token: write` を付けている理由でもある。

**Anthropic の API キーを代わりに渡してはいけない。** 動きはするが、Pro / Max プランの
対象外となり API 利用料として別途課金される。

### 既知の制約

| 制約 | 内容 |
|---|---|
| **fork からの PR では動かない** | パブリックリポジトリでは fork からの PR に Secrets が渡らない。**外部の PR にレビューが付かない**代わりに、外部から本人のトークンを消費されない |
| **導入 PR 自体はレビューされない** | ワークフローは既定ブランチに存在しないと動かない。トークン交換の時点で `workflow_not_found_on_default_branch` として警告付きで中断する |
| **トークン消費が大きい** | レビューはセッション履歴を持たないため、毎回 PR 差分・`CLAUDE.md`・`REVIEW.md` を読み直す |

## ライセンス

学習目的のため未設定。
