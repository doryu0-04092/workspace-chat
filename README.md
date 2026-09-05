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
| ドキュメント検査の CI | **完了**（[docs.yml](.github/workflows/docs.yml)） |
| lint・型チェック・ビルド・テストの CI | **完了**（[ci.yml](.github/workflows/ci.yml)） |
| 依存の脆弱性検査 | **完了**（[audit.yml](.github/workflows/audit.yml) と [dependabot.yml](.github/dependabot.yml)） |
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

> **代償。** この設定は**依存パッケージが宣言する `engines` にも効く**。
> 依存の1つが合わない範囲を宣言していると、その時点でインストールが止まる。
> 止まったときは設定を外して回避するのではなく、**なぜその依存が合わないのか**を先に確かめる。
>
> **未確認の懸念。** Dependabot は自前の環境で依存を解決する。その Node が
> `engines`（`>=24 <25`）に合わないと、この設定により解決が失敗し、
> **Dependabot は PR を出さないまま静かに止まる。**
> マージ後に初回の実行を確認する（#19）。先回りして外すと、この設定を入れた
> 目的（README の記述を事実にする）が失われるため、確かめてから決める。

```
npm ci          依存を入れる（package-lock.json のとおりに入る）
npm run build   3つのワークスペースを順に組む
npm test        テストを実行する
```

CI が回すのと同じ検査を手元で通すには次を順に実行する。

```
npm run lint
bash scripts/lint-scope.test.sh
npm run format:check
npm run typecheck
npm run build
npm test
npm audit --audit-level=high
shellcheck scripts/*.sh
bash scripts/check-docs.sh
bash scripts/check-docs.test.sh
```

（`shellcheck` は CI の ubuntu には既定で入っている。手元に無ければ
この1行だけ飛ばす）

`scripts/lint-scope.test.sh` は、ESLint と Prettier が `.claude/`（エージェントが作る
git のワークツリーが入る）を走査しないことを確かめる。

`.claude/` は CI のチェックアウトに無い。そのため除外が消えても、
**`npm run lint` と `npm run format:check` は CI では緑のまま**で、手元でだけ落ちる。
この検査は probe を自分で `.claude/` の下に置いてから道具を走らせるので、
**CI でも欠落を検出できる**（だから [ci.yml](.github/workflows/ci.yml) で回している）。
手元で回す意味は、**症状（自分の環境で lint が落ちる）が出るより先に、
原因（除外が消えた）に気づけること**にある。

このほかに CI は次を回す。

| ワークフロー | 内容 |
|---|---|
| [docs.yml](.github/workflows/docs.yml) | ドキュメントの検査（`scripts/check-docs.sh`）と、**その検査自身が壊れたら落ちることの確認**（`scripts/check-docs.test.sh`、28通り） |
| [audit.yml](.github/workflows/audit.yml) | 依存の脆弱性検査。PR・push に加えて**毎週月曜に定期実行する**（要件定義書 4.3 の「継続的に」） |
| [claude_code_review.yml](.github/workflows/claude_code_review.yml) | AI コードレビュー（下記） |

依存の更新は [dependabot.yml](.github/dependabot.yml) が毎週提案する。
**メジャー更新を止めているのは、[技術スタック](docs/tech-stack.md) が理由を書いて版を
選んでいるものだけ**（TypeScript / Vite / React / Tailwind / NestJS）。
移行は文書を直す作業と一体で行う。

それ以外のメジャーは受け取る。**すべて止めると、メジャー版でしか修正されない
脆弱性が出たときに、Dependabot が PR を出さない一方で監査は落ち続け、
自動で直す経路が無いままマージが塞がる。**

### 動かす

**先に `npm run build` を1度通す。** `packages/shared` は `dist/` を公開しており、
`dist/` は追跡していない。組んでいない状態で起動すると
`@workspace-chat/shared` が解決できずに落ちる。

| 対象 | 手順 |
|---|---|
| フロントエンド | `npm run dev -w @workspace-chat/web` |
| バックエンド | **端末を2つ使う。** 片方で `npm run build:watch -w @workspace-chat/api`、もう片方で `npm run dev -w @workspace-chat/api` |

**`packages/shared` を編集するなら、もう1つ端末を開いて
`npm run build:watch -w @workspace-chat/shared` を回す。**
api の `build:watch` が見ているのは api の `src` だけで、
**共有パッケージを直しても api も web も古い `dist` を読み続ける。**
「直したはずの型が反映されない」の原因はたいていこれである。

1回だけ組み直すなら `npm run build -w @workspace-chat/shared`。

バックエンドが2端末なのは、**ビルドと実行を分けているため**である。
NestJS 11 は CommonJS で、TypeScript をそのまま実行しない。
1コマンドにまとめるには監視ツールを足すことになるので、**依存を増やさない側に倒している。**

待ち受けポートは `PORT` で変えられる。**未設定なら 3000。**
受け付けるのは 1〜65535 の10進の数字だけで、**それ以外は起動時に落ちる。**

**`PORT=` と空のまま渡した場合も落ちる。** 未設定とは区別する。
`.env` や ECS のタスク定義で空のまま渡す事故は現実に起きるが、
そこで既定値に落とすと、**8080 のつもりが黙って 3000 で待ち受ける**ことになる。

10進に限っているのは、`Number()` が期待より広く受理するためである。
`Number('abc')` は `NaN` を返し、`listen(NaN)` は**任意の空きポートで待ち受けてしまう**。
加えて `Number()` は `0x1F8`（504）・`0b101`（5）・`1e3`（1000）・前後の空白付き（` 80 `）も
受理するため、**結果だけを見ていると設定ミスを取り逃がす。**

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
| **このワークフロー自身を変える PR ではレビューが動かない** | ワークフローの内容が既定ブランチと一字一句同じでないと、トークン交換の時点で中断する。**導入 PR も、後からこのファイルを直す PR も同じ**。マージすれば次の PR から動く。**このファイルの変更は他の変更と混ぜず、単独の PR にする** |
| **トークン消費が大きい** | レビューはセッション履歴を持たないため、毎回 PR 差分・`CLAUDE.md`・`REVIEW.md` を読み直す |

## ライセンス

学習目的のため未設定。
