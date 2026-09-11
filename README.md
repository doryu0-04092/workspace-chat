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
| 依存の脆弱性検査 | **完了**（[audit.yml](.github/workflows/audit.yml)。**脆弱性に気づく経路はこれだけである**） |
| **秘密の値の検査** | **完了**（[audit.yml](.github/workflows/audit.yml) の gitleaks。**中身を見るのはこれだけである**——`scripts/check-docs.test.sh` の 0c はファイル名しか見ない） |
| 依存の更新方針 | **完了**（[dependabot.yml](.github/dependabot.yml)。**npm の版は固定し、GitHub Actions の更新のみ受け取る**。脆弱性検査ではない）。**固定するのは「新しい版が出たから上げる」だけであり、脆弱性を塞ぐ更新は取り込む**（下記「依存の版を上げない方針」） |
| プロジェクトの雛形 | **完了**（apps/api / apps/web / packages/shared） |
| 開発環境の Docker（DB・Redis） | **完了**（[compose.yaml](compose.yaml)。pg_bigm 入りの PostgreSQL 17 と Valkey。**サービス名は `redis` のまま**（下記「開発環境のミドルウェア」）） |
| Prisma のスキーマとマイグレーション | **完了**（[prisma.config.ts](prisma.config.ts) / `apps/api/prisma/`。#42） |
| 実装 | 未着手（次の作業） |

**開発方式はテスト駆動開発（TDD）。** 実装より先にテストを書き、失敗を確認してから実装する
（[要件定義書](docs/requirements.md) 4.8）。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [要件定義書](docs/requirements.md) | 目的・スコープ・非機能要件・**実装しない機能とその理由**・**法令上の位置づけ** |
| [機能一覧](docs/features.md) | 全機能の一覧と受け入れ条件。**要件の出所（要求 / 派生 / 提案・承認済）を区分表記** |
| [技術スタック](docs/tech-stack.md) | 採用技術とバージョン、選定理由、LTS の根拠、**リソースのサイジング** |
| [コードレビュー観点](REVIEW.md) | AI・人間の双方が使うレビュー観点。重大度の定義と、報告しないことの明示 |
| [判定基準の作り直しの記録](docs/review-criteria-record.md) | 上の観点を**なぜそう決めたか**。実測の数字と経緯。**規則そのものは置かない**（ただし**規則文書へ移していない取り決めが残っている**。#156） |
| [ローカル DB の復旧](docs/local-db-recovery.md) | `.env` の値が起動済みのコンテナ・ボリュームとずれたときに、**データを捨てずに**直す手順（#54） |

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

**全 39 件**（要求 19 / 派生 10 / 提案・承認済 10）。各機能の受け入れ条件は
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
> **確認済み（2026-09-04）。** 「Dependabot が自前の環境で依存を解決できず、
> PR を出さないまま静かに止まる」ことを懸念していたが（#19）、
> **Dependabot は実際に PR #21 を作成した。** この設定が原因で止まってはいない。

```
npm ci          依存を入れる（package-lock.json のとおりに入る）
npm run build   3つのワークスペースを順に組む
npm test        テストを実行する
```

CI が回すのと同じ検査を手元で通すには次を順に実行する。

```
rm -f packages/shared/src/api.gen.ts && npm run generate:api && git ls-files --error-unmatch packages/shared/src/api.gen.ts && git diff --exit-code -- packages/shared/src/api.gen.ts
npm run lint
bash scripts/lint-scope.test.sh
npm run format:check
npm run typecheck
npm run build
npm test
bash scripts/check-audit.test.sh
npm audit --json > audit-report.json || true
node scripts/check-audit.mjs audit-report.json
shellcheck scripts/*.sh
bash scripts/check-docs.sh
bash scripts/check-docs.test.sh
```

（`shellcheck` は CI の ubuntu には既定で入っている。手元に無ければ
この1行だけ飛ばす）

`scripts/lint-scope.test.sh` が見るのは**走査範囲だけではない**。次の2つを確かめる。

**1. 走査範囲** — ESLint と Prettier が `.claude/`（エージェントが作る git のワークツリーが
入る）を走査しないこと。

`.claude/` は CI のチェックアウトに無い。そのため除外が消えても、
**`npm run lint` と `npm run format:check` は CI では緑のまま**で、手元でだけ落ちる。
この検査は probe を自分で `.claude/` の下に置いてから道具を走らせるので、
**CI でも欠落を検出できる**（だから [ci.yml](.github/workflows/ci.yml) で回している）。
手元で回す意味は、**症状（自分の環境で lint が落ちる）が出るより先に、
原因（除外が消えた）に気づけること**にある。

**2. react-hooks のルールが実際に効いていること** — `react-hooks/rules-of-hooks` と
`react-hooks/exhaustive-deps` が配線されており、**重大度が `error` であること**。

`eslint.config.js` の `files` のパターンが壊れても、走査範囲の判定は他のルール
（`any`・未使用変数）で変わらず緑のまま通る。**そのため、hooks の配線が外れたときに
落ちるのは `npm run lint` ではなくこの検査である。** 重大度まで見るのは、
`exhaustive-deps` だけを `warn` に戻しても `rules-of-hooks` の error で
`npm run lint` の終了コードが 1 のままになり、ルール ID の有無だけでは
区別できないためである。

**この2つ目があるため、このスクリプトが落ちた原因は走査範囲とは限らない。**
出力の見出し（`1. ESLint` / `2. Prettier` / `3. react-hooks のルール`）で切り分ける。

このほかに CI は次を回す。

| ワークフロー | 内容 |
|---|---|
| [docs.yml](.github/workflows/docs.yml) | ドキュメントの検査（`scripts/check-docs.sh`）と、**その検査自身が壊れたら落ちることの確認**（`scripts/check-docs.test.sh`、73通り） |
| [audit.yml](.github/workflows/audit.yml) | 依存の脆弱性検査と、**秘密の値がソースに書かれていないかの検査**（gitleaks）。PR・push に加えて**毎週月曜に定期実行する**（**gitleaks が全履歴を見るのは、この定期実行と手動実行だけである。PR と push では差分しか見ない**）（要件定義書 4.3 の「継続的に」） |
| [claude_code_review.yml](.github/workflows/claude_code_review.yml) | AI コードレビュー（下記） |

### 依存の版を上げない方針（2026-09-04 決定）

**npm の依存は、動くことを確かめた組み合わせで固定する。**
[dependabot.yml](.github/dependabot.yml) の npm 側は版更新の PR を出さない設定にしている。

> **この方針が却下するのは「新しい版が出たから上げる」だけである。**
> **脆弱性を塞ぐための更新は、この方針の対象ではない。取り込む。**
> 下の3件の根拠はすべて「新しい版が出たから上げる」型の提案であり、
> **脆弱性を理由にしたものは1件も無い。**
> **[audit.yml](.github/workflows/audit.yml) は「脆弱性に気づく経路はこれだけである」**
> （[CLAUDE.md](CLAUDE.md)）**として置いてある。気づいた後に上げないなら、その経路を作った意味が消える。**

判断は**一度きり**である。最初に選んだ版は互いに噛み合うことを確かめた組み合わせであり、
**1つだけ動かすと噛み合わなくなる**。

根拠は PR #21 で実際に起きたことである。開発依存3件がまとめて提案され、**CI は3件とも緑だった**が、
**3件すべてが受け入れてはいけないものだった。**

| 提案 | 判断 |
|---|---|
| `@types/node` 24 → 26 | **却下。** ランタイムは Node 24 に固定している。Node 26 の型を入れると、**存在しない API を書いても型検査が通り、実行して初めて落ちる** |
| `@vitejs/plugin-react` 5 → 6 | **却下。** `vite@^8` を要求する。Vite 7 では入らない |
| `jsdom` 28 → 30 | **却下。** ルートに巻き上げられず `apps/web/node_modules` に入る。vitest はルートから探すため、**web のテストが1本まるごと起動に失敗する** |

`jsdom` の実測:

| | 配置 | `npm test` の終了コード |
|---|---|---|
| 28（現在） | `node_modules/jsdom` | **0** |
| 30（提案） | `apps/web/node_modules/jsdom` | **1** |

**3件目は、CI が緑のままテストが1本走っていなかった**という形である。

#### 代償

**1. 依存の版は自動では上がらない。** 上げるのは必要が生じたときの手作業になる。

**2. 脆弱性を直す更新も自動では PR にならない。**
Dependabot の「security updates」は版更新とは別の仕組みで、`dependabot.yml` では
制御できず、`open-pull-requests-limit: 0` の影響も受けない。
**ただしこのリポジトリでは Dependabot のアラート自体が無効である**
（API で確認した。有効なら 204 が返るところ、404 が返る）。
アラートが無ければ security updates も動かないため、**自動で来る経路は無い。**

**気づく経路は [audit.yml](.github/workflows/audit.yml) だけであり、気づいたら塞ぐ。**
**塞ぎ方は毎回同じとは限らない。**

| 状況 | 採る手 |
|---|---|
| 直接の依存に修正版がある | その依存を上げる |
| **依存の依存**に修正版がある | `package.json` の `overrides` で差し替える。**ただし root 直下の依存に限る**——workspace 配下（`apps/api` 等）には届かない（2026-09-09 の実測。#166） |
| **上流がまだ直していない** | **その版では塞げない。** イシューに記録し、**`scripts/audit-allowlist.json` に**その advisory だけを一時的に通す行を足す。**行には `id` / `package` / `until`（期限）/ `issue`（イシュー参照）が必須である**——1つでも欠けると `scripts/check-audit.mjs` が exit 2 で落とす（実例: #166） |

> **通すときは advisory を名指しする。** `--audit-level` を下げる形は採らない——
> **その1件だけでなく、次に来る件も一緒に見逃す。**
>
> **ただし `npm audit` 自体には「この1件だけ無視する」指定が無い**
> （npm 11.13.0 の `--help` で確認。あるのは `--audit-level` による閾値だけである）。
> **そのため `--json` の出力を自前で判定している**——`scripts/check-audit.mjs`（仕組み）と
> `scripts/audit-allowlist.json`（通す対象）に分けてある。
> **道具を足す形（`audit-ci` 等）は、依存を増やすため採っていない。**

**通すときの落とし方は2つある。片方だけでは足りない。**

| 落とす条件 | 何を防ぐか |
|---|---|
| 許可していない high 以上が残っている | **通した1件のついでに、次に来た件を見逃すこと** |
| **許可した id が1件も出なくなった** | **上流が直ったのに、通したまま忘れること** |

**期限は日付で書かない。出口で書く**（例: 「サーバーが multipart を受け取る経路を実装するまで」）。
**日付は延長を誘発する。** 出口なら、そこへ着いた時点で必ず突き当たる。

> **これはリポジトリの設定であり、`dependabot.yml` には現れない。**
> 「設定として残す」というこの方針が、security updates 側には及んでいない。
> 有効にするかどうかは別途判断する（#36）。

**3. `moderate` 以下は誰も知らせてくれない。**
[audit.yml](.github/workflows/audit.yml) が落とすのは **high 以上**（`scripts/check-audit.mjs` の
`BLOCKING`）であり、`moderate` 以下では失敗しない。かつては「Dependabot の PR で追う」としていたが、
**その経路は無くなった。** 代わりに、audit.yml の「全件表示」ステップの出力を
定期実行のログで人が読む。**読む先は1箇所に定めてある。**

**4. 60日間リポジトリに活動が無いと、GitHub が週次実行を自動で無効化する。**
パブリックリポジトリの `schedule` ワークフローの仕様である。
**そして無効化されるのは、この方針が守ろうとした状況そのものである** —
「コードが動かない期間に公表された脆弱性を拾う」ために定期実行を置いたのに、
**コードが動かない期間が続くと、その定期実行が止まる。**

> 止まっても通知は来ない。**Actions の画面から手動で再有効化する。**
> 実装が長く止まる見込みなら、活動に依存しない経路を別途考える。

**検知そのものは [audit.yml](.github/workflows/audit.yml) が毎週続ける。**
`high` 以上なら落ちる。落ちたら、そのとき直す版を人が選ぶ——
**塞げる版が無い場合の扱いは、上の「塞ぎ方」の表による。**

**GitHub Actions 側は止めていない。** こちらのメジャーは実行環境（Node 20 → 24）の
移行を含み、放置すると非推奨のランタイムで動き続ける。実際に PR #4 のレビューで
`checkout` が Node 20 のまま取り残されていた。**機械に見張らせる価値が npm とは別にある。**

### 開発環境のミドルウェア（DB・Redis）

**Docker で動かすのはミドルウェアだけである。** api と web はホストの Node で動かす
（[compose.yaml](compose.yaml)）。ホットリロードとデバッグのしやすさを優先した。

**`redis` サービスのイメージは Valkey である**（`valkey/valkey:8-alpine`。#24）。
ElastiCache for Redis から ElastiCache for Valkey へ移す決定を受けたもので、
**サービス名・環境変数名（`REDIS_PORT`）はこの決定の範囲外とし、変えていない。**
理由・価格の根拠・代償は [技術スタック](docs/tech-stack.md)「Valkey の版（ローカル）」に記す。

> **代償。** ローカルとデプロイ先（ECS Fargate）で Node の動作環境が揃わない。
> 「手元では動くが ECS で動かない」がありうる。**CI（ubuntu / Node 24）がその差を先に踏む。**

**先に `.env` を用意する。** compose は値を持たず、すべて `.env` から読む。

```
cp .env.example .env    変数名だけが入っている。値を書き込む
```

**Docker Compose v2 が要る。**

```
docker compose version
```

**このリポジトリの手順は、確認用の上の1行も下の操作表も、すべて `docker compose`
（v2 の CLI プラグイン）で書いてある。`docker-compose` に読み替えないこと。**

確かめたのは、**操作表が使う `up --wait` が v2 の機能である**ことだけである
（`docker compose up --help` に出る）。
**旧来の v1（`docker-compose`）がどう振る舞うかは確認していない**
——`compose.yaml` を探索対象に含めるか、読み替えたときにどの文言で止まるかは、
手元に v1 が無く叩けなかった。**最低のマイナー版も特定していない。**

**変数を1つでも空のままにすると起動が止まる。** 既定値には落とさない。
落とすと設定の書き忘れが「動いてしまう」形で隠れる。
**空文字を既定値に落とさない点は後述の `PORT` と同じだが、未設定の扱いは違う。**
`PORT` は未設定なら 3000 に落ちる。compose の `${VAR:?...}` は**未設定でも止める。**

**`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` は英数字だけにする。3つともである。**
どれも下の接続 URL に組み込むため、`@` `/` `?` `#` `%` `:` は区切りとして解釈される。
**特に `@` は別の宛先に繋ごうとする**形になり、「認証に失敗する」より原因を追いにくい。
記号を使うなら URL エンコードが要る。


| 操作 | コマンド |
|---|---|
| 起動する | `docker compose up -d --wait` |
| **イメージを作り直す** | `docker compose up -d --build --wait` |
| **土台ごと新しくする（db）** | `docker compose build --pull db` のあと `docker compose up -d --wait` |
| **イメージを取り直す（redis）** | `docker compose pull redis` のあと `docker compose up -d --wait` |
| 状態を見る | `docker compose ps` |
| ログを見る | `docker compose logs -f db` |
| 止める（**データは残る**） | `docker compose down` |
| **止めてデータも消す** | `docker compose down -v` |

`--wait` を付けるとヘルスチェックが通るまで戻らない。付けないと、
**まだ初期化中の DB に接続しようとして落ちる。**

**`.env` の3つの値がずれてヘルスチェックが `unhealthy` になったときの最短経路。**
手元のデータを捨ててよいなら `docker compose down -v` してから `docker compose up -d --wait`
すれば、初期化からやり直せる。

**捨てたくない場合は、[ローカル DB の復旧](docs/local-db-recovery.md) を読む。**
コンテナやボリュームから古い値を引いて、消さずに直す手順を記す。

**`--build` が要るのは、`up` が既にあるイメージを作り直さないためである。**
[Dockerfile](docker/postgres/Dockerfile) は pg_bigm の版を `ARG` で固定しており、
更新は手で上げる。**その変更を pull しても `up` だけでは古い pg_bigm のまま動く。**

**さらに `--build` だけでは、土台の `postgres:17-bookworm` は取り直されない。**
Docker は同じ名前のイメージが手元にあればレジストリを見ない。
`--pull` を付けたときだけ取り直す。**実際に確かめた**（手元のタグを 17.2 に付け替えると、
`--build` だけのビルドは 17.2 で出来上がり、`build --pull` では 17.11 に戻った）。

**PostgreSQL のマイナー修正を受け取るのは `--pull` を付けたときだけである。**
土台をダイジェストで固定していない理由は [Dockerfile](docker/postgres/Dockerfile) に記した。

**redis は `build --pull` の対象にならない。** `build` が触るのは `build:` を持つサービスだけで、
redis は既製のイメージをそのまま使う。**`docker compose pull redis` が要る。**
これを叩かない限り、**最初に `up` した日の 7.2.x のまま動き続ける。**

**接続先の組み立て方**（`DATABASE_URL` を含め、以後この形式を「接続先の組み立て方」として参照する）。
`.env` に書いた値から組み立てる。

```
postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:<POSTGRES_PORT>/<POSTGRES_DB>
redis://127.0.0.1:<REDIS_PORT>
```

**どちらも `127.0.0.1` にだけ結び付けている。** 省略すると全インターフェースで待ち受け、
同じネットワーク上の端末から開発用の DB に届く。

**`localhost` と書かない。** 多くの環境で `localhost` は `::1` を先に返すが、
束縛しているのは IPv4 の `127.0.0.1` だけである。IPv4 に落ちないクライアントは繋がらない。

**この経路は実際に叩いて確かめた。** ヘルスチェックはコンテナの中から見ているだけで、
**公開ポートを通らない。** api が使うのはこちらだけなので、別に確認した。

**ここでの `127.0.0.1` はホスト側である。** `compose.yaml` のヘルスチェックが避けている
「ループバック宛はパスワードを検証しない」は**コンテナの中の `127.0.0.1`** の話で、別物である。
ホストからの接続は Docker の NAT を通るため、下のとおりパスワードが検証される。

| 確かめたこと | 結果 |
|---|---|
| ホストの `127.0.0.1:<POSTGRES_PORT>` / `<REDIS_PORT>` に TCP が通る | 両方とも通った |
| 上の接続 URL の形で `SELECT version()` | `PostgreSQL 17.x` が返った（**確認した時点は 17.11**。土台はタグ指定なので `--pull` で動く） |
| Redis に `ping` | `PONG` |
| **パスワードを誤った接続 URL** | `password authentication failed` で**拒否された** |

#### pg_bigm

公式の `postgres:17` に pg_bigm は入っておらず、**PGDG の apt リポジトリにも無い**。
そのため [docker/postgres/Dockerfile](docker/postgres/Dockerfile) で
ソースからビルドしている。初回の `up` はそのぶん遅い。

**`CREATE EXTENSION pg_bigm` はこの compose では自動実行しない。**
拡張を作るのは Prisma のマイグレーションの役目とする。
初期化スクリプトで作ると、**ローカルだけ拡張があり、RDS には無い**状態が生まれ、
「手元では検索できるのに本番で落ちる」という形で後から露見する。

> **代償。** マイグレーションを書くまで、起動しただけの DB に pg_bigm は入っていない。
> 手で確かめるには次を実行する。

```
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION pg_bigm; DROP EXTENSION pg_bigm;"'
```

**同じ1行で `DROP` まで済ませるのは、確認が状態を変えないようにするためである。**
作ったまま放置すると、**この手順を実行した人の DB にだけ拡張が残る。**
すぐ上に書いた「起動しただけの DB に pg_bigm は入っていない」という前提が、
**手順に従った直後に、その人の手元でだけ崩れる。** 再現しない差が最も厄介である。

**`sh -c` で包むのは、変数をコンテナの中で展開させるためである。**
`.env` を読むのは compose であって手元のシェルではない。
`docker compose exec db psql -U "$POSTGRES_USER"` と書くと、
**手元のシェルが空文字に展開してから** `docker` に渡す。

#### DATABASE_URL（Prisma。#42）

**`prisma generate` を除くすべての `prisma` コマンド**（`migrate dev` / `migrate deploy` /
`migrate diff` / `db execute` 等）に、環境変数 `DATABASE_URL` が要る。

読むのは docker compose ではなく、根の [prisma.config.ts](prisma.config.ts) が
`process.loadEnvFile()` で直接読む。**`.env.example` にも値は書かない**（`.env.example` の
「Prisma」節を参照）。値は「接続先の組み立て方」と同じ形（`postgresql://` の URL）で
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_PORT` / `POSTGRES_DB` から組み立てる
（`127.0.0.1` に固定し `localhost` と書かない理由も「接続先の組み立て方」を参照）。

コピーした先の `.env` の `DATABASE_URL` に書き込む。**根で `prisma` の CLI を実行すること**
（[prisma.config.ts](prisma.config.ts) を根に置いているのは `prisma` をルートの開発依存として
入れているためであり、根で実行すれば `--schema` を毎回渡さずに済む。**`.env` の読み込み自体は
`prisma.config.ts` の位置から解決するため cwd には依存しない**が、CLI 自体の呼び出しは
根で行う前提の構成である）。

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


**api のパスはすべて `/api` で始まる**（#77）。本番は CloudFront が `/api/*` を ALB へ振り分け、
手元では web の開発サーバーが `/api` を api へ中継して同じ形を作る
（`apps/web/vite.config.ts` の `server.proxy`。WebSocket も同じ中継に載る）。

**`PORT` を変えるときは、web を起動する端末にも同じ `PORT` を渡す。**
web の中継先のポートは、**同じ環境変数 `PORT` から** api と同じ規則（`apps/api/src/port.ts`）で決まる。
**`.env` には書かない**——api は `.env` を読まず（`.env.example` の冒頭）、
Vite も設定ファイルを評価する時点では `.env` を読まず、その時点の環境変数だけが見える。
**片方の端末にだけ渡すと、web は 3000 に繋ぎに行き、リクエストが届かないため api のログには何も出ない。**

待ち受けポートは `PORT` で変えられる。**未設定なら 3000。**
受け付けるのは 1〜65535 の10進の数字だけで、**それ以外は起動時に落ちる。**

**`PORT=` と空のまま渡した場合も落ちる。** 未設定とは区別する。
`.env` や ECS のタスク定義で空のまま渡す事故は現実に起きるが、
そこで既定値に落とすと、**8080 のつもりが黙って 3000 で待ち受ける**ことになる。

10進に限っているのは、`Number()` が期待より広く受理するためである。
`Number('abc')` は `NaN` を返し、`listen(NaN)` は**任意の空きポートで待ち受けてしまう**。
加えて `Number()` は `0x1F8`（504）・`0b101`（5）・`1e3`（1000）・前後の空白付き（` 80 `）も
受理するため、**結果だけを見ていると設定ミスを取り逃がす。**

**api の起動には環境変数 `DATABASE_URL` が要る。** 未設定・空は起動時に落ちる（`apps/api/src/prisma.service.ts`）。
値は上の「DATABASE_URL（Prisma。#42）」で `.env` に書いたものと同じだが、**api は `.env` を読まない**ため、
`PORT` と同じく api を起動する端末の環境変数として渡す。

**api の起動には環境変数 `REDIS_URL`（Valkey の接続先）も要る。** 未設定・空は起動時に落ちる。
手元では `redis://127.0.0.1:<REDIS_PORT>`（`REDIS_PORT` は `.env` に書いた compose の値）。
**Valkey が動いていなくても api は起動し、レート制限は各タスクのメモリで数える**（起動時と切り替え時に warn のログが出る）。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `TRUST_PROXY_HOPS` | **必須**（未設定は起動時に落ちる） | 信頼する中継の段数（Express の `trust proxy`）。**レート制限の発信元はこれで決まる。** **手元で直接叩くなら `TRUST_PROXY_HOPS=0` を明示して渡す。** 必須にしているのは、本番で渡し忘れて 0 になると全員が ALB の IP で数えられ、エラーもログも出ないまま正規の利用者だけが 429 を受けるためである（決定・2026-09-11・依頼側。#252）。本番（CloudFront → ALB）は 2 で、**ALB に CloudFront を経ずに届く経路を塞いでいることが前提**（塞いでいないと X-Forwarded-For で発信元を偽れる）。多すぎると偽の発信元を名乗れ、少なすぎると全員が1つの発信元として数えられる |
| `API_TASK_COUNT` | 1 | api のタスク数。Valkey が止まっている間、各タスクのメモリで数えるときに上限をこの数で割る |

いずれも 0 以上（`API_TASK_COUNT` は 1 以上）の10進の整数だけを受け付け、それ以外は起動時に落ちる。
`API_TASK_COUNT` は未設定なら 1 である（Valkey が動いている間は使わないため）。

**`REGISTRATION_ENABLED=false` で新規登録を停止する**（[要件定義書](docs/requirements.md) 5.1）。
未設定なら開放する。**`true` / `false` 以外（`FALSE`・`0`・空を含む）は起動時に落ちる**——
止めるつもりの値が「開放」に倒れると、止まっていないことに気づけないためである。

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
| **このワークフロー自身を変える PR ではレビューが動かない** | ワークフローの内容が既定ブランチと一字一句同じでないと、トークン交換の時点で中断する。**導入 PR も、後からこのファイルを直す PR も同じ**。マージすれば次の PR から動く。**このファイルの変更は他の変更と混ぜず、単独の PR にする**。**マージした後は、その前に切られたブランチでも走らなくなる**——`main` を取り込むまで解消しない。**見分け方: `review` が `success` のまま 10 秒前後で終わり、コメントが投稿されない。**CI 4本の完走確認は緑のまま通るため、**一度もレビューされていない PR が「完走」として扱われる** |
| **ブランチ名に日本語を含む PR ではレビューが動かない** | `claude-code-action` が `Invalid branch name` を出して実行を拒否する（実測で確認。#210）。エラーメッセージが許可として挙げるのは、英数字と `/` `-` `_` `.` `#` `+` `,` `@` `(` `)` である。**ブランチ名は英数字と `/` `-` `#` だけで書く**（[CLAUDE.md](CLAUDE.md) 開発フロー 2。この許可集合の内側に収まる）。**見分け方: `review` が `fail` のまま 12〜14 秒で終わり、コメントが投稿されない。**「このワークフロー自身を変える PR ではレビューが動かない」とは **`success` か `fail` かで分かれる** |
| **トークン消費が大きい** | レビューはセッション履歴を持たないため、毎回 PR 差分・`CLAUDE.md`・`REVIEW.md` を読み直す |
| **PR の版の `CLAUDE.md` は読まれない** | ルートの `CLAUDE.md` は既定ブランチの版に差し替えられ、PR の版は `.claude-pr/CLAUDE.md` へ退避される（実測で確認。#46）。**レビュアーに効かせたい規則は `REVIEW.md` に書く。** `REVIEW.md` は PR の版がそのまま読まれる |

## ライセンス

学習目的のため未設定。
