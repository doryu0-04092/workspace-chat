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
| 開発環境の Docker（DB・Redis） | **完了**（[compose.yaml](compose.yaml)。pg_bigm 入りの PostgreSQL 17 と Redis） |
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

### 開発環境のミドルウェア（DB・Redis）

**Docker で動かすのはミドルウェアだけである。** api と web はホストの Node で動かす
（[compose.yaml](compose.yaml)）。ホットリロードとデバッグのしやすさを優先した。

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

**`.env` に触る前に、いまの `POSTGRES_USER` と `POSTGRES_DB` を控える。**
`POSTGRES_USER` / `POSTGRES_DB` を変えたあと**データを捨てずに直す**には古い名前が要る（後述）。
`.env` を書き換えれば `.env` 側から消え、`docker compose down` や `up` による作り直しで
コンテナからも消える（`down` はコンテナを削除するので `exec` の相手が無くなる）。

```
docker compose exec db sh -c 'echo "$POSTGRES_USER"; echo "$POSTGRES_DB"'
```

**`<古い名前>` を引数に取るのは、利用者名とデータベース名を直す手順の2つである。**
**パスワードは控えなくてよい**（`\password` で上書きするため）。
`env` や `docker inspect` を丸ごと出すとパスワードまで平文で出るので、変数を名指しする。

**控えそこねても、コンテナがまだ残っているなら `docker inspect` から引ける。**
`docker inspect` は compose を通らないため、**`.env` が空でも動く**
（`.env` を空にすると `exec` は通らないが、これは通る。どちらも実行して確認した）。

```
docker inspect workspace-chat-db-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^POSTGRES_(USER|DB)='
```

**`grep` で絞るのは、丸ごと出すとパスワードまで平文で出るためである**（上と同じ理由）。

**引けるのは「そのコンテナが持っている値」であり、古い値とは限らない。**
`up` はコンテナを作り直すので、**新しい値で `up` を通したあとに叩いても新しい値しか返らない**
（実行して確認した）。`down` と `docker rm -f` でも消える。**残っているうちに引く。**

**コンテナも失っても、ボリュームが残っていれば引ける。** 通常の接続では繋げない
（公式イメージが作るログイン可能なロールは `POSTGRES_USER` の1つだけで、
その名前が分からないと繋げないため。後述）が、**単一ユーザーモードは認証を通らない。**

**コンテナがまだ残っているなら、叩く前に必ず止める。**

```
docker stop workspace-chat-db-1
```

**`Error: No such container` が出たらそのまま次へ進んでよい。**
コンテナが無いのがこの手順の前提であり、止めるものが無いだけである。
（コンテナが残っているなら、まずは上の `docker inspect` のほうが早い）

**残っている場合でも `docker compose down` は使わない。** compose を通るため
`.env` を失っている状況では実行できず、通る状況でも**コンテナごと消えるので、
上の `docker inspect` からの取得経路が同時に失われる。** 止めるだけでよい。

> **止め忘れても PostgreSQL は拒んでくれない。確かめた。**
> db を `healthy` のまま動かした状態で下のコマンドを叩いたところ、
> **単一ユーザーモードは何の警告もなく起動し、問い合わせを実行し、
> 稼働中のデータ領域に対してチェックポイントまで書いた。**
> **理由は「PID が見つからないから」ではない。**
> 公式イメージはエントリポイントの最後で `exec postgres` するため、
> **db の postmaster はコンテナの中で PID 1 になる**
> （`docker compose exec db head -1 /var/lib/postgresql/data/postmaster.pid` が `1` を返す。確認した）。
> 下の単一ユーザーモード（`docker run --single`）も**新しいコンテナの中で PID 1** である。
> **記録されている PID と、検査する側の PID が一致してしまう。**
> PostgreSQL はそれを自分自身の残骸と見なしてロックを引き継ぐ。
> **PID が見えていれば拒んでくれる、ということにはならない。**
> ここで守ろうとしているのは、その時点で値の唯一の複製であるデータ領域である。
> **止め忘れると、救うつもりで壊す。**

止めたら叩く。

```
printf "SELECT rolname FROM pg_authid WHERE rolcanlogin;\nSELECT datname FROM pg_database WHERE datname NOT IN ('template0','template1');\n" \
  | docker run --rm -i -v workspace-chat_db-data:/var/lib/postgresql/data \
      --user postgres --entrypoint postgres workspace-chat-db:local \
      --single -D /var/lib/postgresql/data template1
```

出力は起動ログに混ざって `rolname = "<利用者名>"` / `datname = "<データベース名>"` の形で出る。

**最後の引数の `template1` は接続先のデータベースである。**
復旧手順の他の行と同じ理由でこれを使う（後述。`POSTGRES_DB` に何を選んでいても存在する）。

**`postgres` も出力に出る。** initdb が `POSTGRES_DB` の値によらず作るためである。
**それが `POSTGRES_DB` の値だった可能性もある**（公式イメージの既定がこの名前である）。
**除外していないのはそのためである。** 除外すると、その設定にしていた人には
**エラーではなく無出力**が返り、「引けなかった」と読み違えて初期化からやり直すことになる。

**組み込みロールは `rolcanlogin` で落ちる**（`pg_` で始まる定義済みロールはすべて `NOLOGIN`）。

**`rolname` が2行返ることがある。** 利用者名の改名手順（後述）の3行目を叩き忘れると、
`SUPERUSER LOGIN` の `tmp_rename` が残り、**これは `rolcanlogin` で落ちない。**
その場合は OID で一意に決まる。

```
SELECT rolname FROM pg_authid WHERE oid = 10;
```

`POSTGRES_USER` は **initdb が作るブートストラップ superuser であり、OID は 10** である。
（実行して確認した。`tmp_rename` を残した状態で `rolcanlogin` は2行返り、
`oid = 10` は `POSTGRES_USER` の側だけを返した）

**ただし `oid >= 16384` で絞ろうとしないこと。** OID が 10 である以上、
**利用者が作ったロールの範囲には入らない**ため空振りする（実際に叩いて空振りした）。

**`workspace-chat-db:local` が手元に無ければ、土台の `postgres:17-bookworm` に置き換えてよい。**
この手順が読むのは `pg_authid` と `pg_database` だけで、**pg_bigm は要らない**
（`shared_preload_libraries` を渡しているのは `compose.yaml` の `command` であり、
データ領域の `postgresql.conf` には入っていない）。

**置き換えが要る場面は実際にある。** `workspace-chat-db:local` はレジストリに存在しないため、
手元から消えていると `docker run` はプルを試みて `pull access denied` で止まる。
`docker system prune -a` は使っていないイメージを消す一方、名前付きボリュームは
`--volumes` を付けない限り残す。**この手順が想定しているのはコンテナを失った状況であり、
コンテナの無いイメージはまさに prune の対象である。**
そのうえ `.env` を失っていれば `docker compose build db` も compose の読み込みで止まる。

（**上のコマンドをそのままの形で実行して確認した。** コンテナを `docker rm -f` で消し
`.env` も消した状態から、ボリュームだけで利用者名とデータベース名を引けた。
返ったのは `rolname` が1行、`datname` が `postgres` と利用者のデータベース名の2行である。
**`workspace-chat-db:local` と `postgres:17-bookworm` の両方で、同じ結果になった**）

**値を引いたら、db を動く状態に戻す。** 下の復旧手順はどれも `docker compose exec` を使うので、
**止まったままでは繋がらない**（`service "db" is not running`。実行して確認した）。
**どちらの状態にいるかで手が違う。**

**コンテナが残っている場合**（上で `docker stop` しただけ）。**先に `.env` を書き戻す。**

```
docker start workspace-chat-db-1
```

`docker start` は compose を通らないので `.env` が無くても動くが、
**この先の `docker compose exec` は止まる**（後述）。書き戻しはここで済ませる。

**コンテナを失っている場合**（`docker rm -f` を通った。この節の本来の前提）。
`docker start` は `Error: No such container` になる。**先に `.env` を書き戻してから**作り直す。

```
docker compose up -d
```

**`.env` が無いと `up` も止まる**（`${VAR:?...}` は compose の読み込み時に評価されるため、
`build` / `down` / `ps` と同じく止まる）。**書き戻すのは、これから使いたい新しい値でよい。**
引いた古い値は `.env` ではなく、下の手順の `<古い名前>` に使う。

**`docker compose up -d` の側は `--wait` を付けない。** 作り直したコンテナには
新しい値が入るので、**値がずれている間は `--wait` が `unhealthy` で失敗する**（前述）。
直すのはこれからであり、失敗して当然の段階である。

**代わりに、接続を受け付けるようになるまで待つ。**
`--wait` を外した以上、`up -d` も `start` も**起動の完了を待たずに戻る。**
待たずに次へ進むと、**まだ初期化中の DB に繋ごうとして
`the database system is starting up` で落ちる。**

```
docker compose exec db pg_isready -h 127.0.0.1
```

`accepting connections` が返れば進んでよい（実行して確認した）。
**この場面では `pg_isready` が適している。** 利用者名もデータベース名もパスワードも
検証しないという性質（後述）が、**値がずれている前提のここでは利点になる。**
`psql` で確かめようとすると、直す前なので必ず落ちる。
**`docker start` の側でも、この待ち合わせは同じように要る。**

**`docker start` に `--wait` という選択肢がそもそも無いだけである**
（`docker start --help` に無い。確認した）。**待たなくてよいという意味ではない。**
なお `start` の側は、**緑になるか赤になるかが、
そのコンテナが持っている環境変数と DB の中身が一致しているかで決まる**（後述）。
`stop` しただけなら作成時の値を保っているので、**`up` をまだ通していなければ緑になる。**

**ボリュームまで失ったら、そこで終わりである。**
残るのは `.env.example` から `.env` を作り直し、`up -d --wait` で初期化からやり直すことだけになる。
**古い値は要らない**（データ領域が空なので初期化処理が走り、`.env` の値がそのまま入る）。
**データは戻らない。**

**この場合に `down -v` は要らない。** 消す対象がもう無いうえ、
`.env` を失っているなら `down` 自体が通らない（下記）。

**ここまでが、値を引けなくなった場合の話である。** 以下は状態が違う。

**コンテナがまだ動いていて、これから `.env` を書き換える場合**（値を控えた直後）は、
**`.env` を作り直す前に `docker compose down` を済ませる。**
`${VAR:?...}` が評価されるのは compose がファイルを読む時点であり、
**`up` だけでなく `down` / `ps` / `logs` / `exec` もすべて止まる**（実行して確認した）。
値を消してから片付けようとすると、**コンテナもボリュームも compose では消せなくなる。**

**避けたいのはコンテナを片付けられなくなることであり、`-v` は要らない。**
名前付きボリューム `db-data` は残る。**初回と同じ3つの値を書き戻したなら**、
`up -d --wait` でそのまま繋がり、**中のデータもそのまま残る**（実行して確認した）。
**違う値を書いたら繋がらない。** その場合は下の「後から変えたら」に従う。
**`docker compose down -v` を使うのは、手元のデータも捨ててよい場合だけである。**

**値を消したまま `down` も叩けなくなったら**（上の、compose がファイルを読めない状態）、
**`down` を叩く前に、上の `docker inspect` で `POSTGRES_USER` と `POSTGRES_DB` を引いておく。**
`down` はコンテナを消すので、**この経路も同時に失われる**（下の `docker rm -f` と同じ理由）。
書き戻す値が古い値と違うなら、そのあと残るのは単一ユーザーモードだけになる。

**`.env` に値を書き戻してから `down` を叩くのが最も短い**（データも捨てるなら `down -v`）。
中身が正しい必要はない。compose が読めればよい。
**ただしこれは `down` を通すための条件であって、`up` の条件ではない。**
適当な値のまま `up -d --wait` すると `unhealthy` で失敗する（実行して確認した）。
**`up` まで通すには、初回と同じ3つの値に戻すか、下の「後から変えたら」に従う。**

`.env` を戻せない場合は、**コンテナを直接消す。脱出に要るのはこれだけである。**

**消す前に、上の `docker inspect` で `POSTGRES_USER` と `POSTGRES_DB` を引いておく。**
`.env` も失っているこの状況では、**そのコンテナが最も手軽な取得元である。**
下のコマンドはそれを消す。

**消したあとでも詰みではない。** ボリュームが残っていれば、上の単一ユーザーモードで引ける
（手間はかかる）。**戻せなくなるのはボリュームまで消したときである。**

```
docker rm -f workspace-chat-db-1 workspace-chat-redis-1
```

**ボリュームを消すのは、手元のデータを捨てる場合だけである。**
消すなら、**コンテナを先に消してからにする。**

```
docker volume rm workspace-chat_db-data
```

**順序を逆にすると `volume is in use` で失敗する**（実行して確認した）。
コンテナが停止していても、参照している限り消せない。

（`compose.yaml` が `name: workspace-chat` を固定しているため、
コンテナ名もボリューム名も作業ツリーの置き場所によらずこの名前になる）

**`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` を後から変えたら、
`up -d --wait` を通し直す。** これらを読むのは公式イメージの初期化処理で、
**走るのはデータ領域が空のときだけ**である。ボリュームができたあとに `.env` を直しても、
**DB の中の利用者名・パスワード・データベース名は初回の値のまま変わらない。3つともである。**

**古い値を控えていないなら、先に引く。** ここから先の「消さずに直す」は
`<古い名前>` を引数に取る。**控えそこねても、引く経路は2つある**（上に書いた）。

**この時点で使えるのは単一ユーザーモードのほうである。**
`docker inspect` は**そのコンテナが持っている値**を返すので、
`up` を通してコンテナが作り直された後は**新しい値しか返らない。**
`up` を通す前に気づいたなら `docker inspect` のほうが早い。

このとき `up -d --wait` は**ヘルスチェックが通らずに失敗する**。
**3つとも検知する**（パスワードだけずらした場合も含めて実行して確かめた）。
`.env` を直したのに直らない、という形にはなるが、**黙って動くよりは良い**という判断である。
ヘルスチェックが `pg_isready` ではなく `psql` で実際に問い合わせているのはこのためである。

**ただし、検知が働くのは `up` を通った場合だけである。**
`docker compose restart` と `start` は**コンテナを作り直さず、`.env` を読み直さない**
（実行して確認した。`restart` のあとも古い値が焼き付いたままだった）。
ヘルスチェックが見ているのは**コンテナの環境変数と DB の中身の一致**であり、
`.env` と DB の一致ではない。両者が揃うのはコンテナが作り直されたときだけである。

**`.env` を変えたら `restart` ではなく `up -d --wait` を使う。**
`restart` で済ませると、**ヘルスチェックは緑のまま、新しい値で繋ぐアプリだけが落ちる。**

**直し方は2つある。どちらを選ぶかは、手元のデータを捨ててよいかで決める。**

- **捨ててよいなら `docker compose down -v` して `up -d --wait`。** 初期化からやり直す
- **捨てたくないなら、下の表のとおり DB 側を直す。3つとも消さずに直せる**

下はすべて実際に実行して確かめた結果である。

**直す対象そのものに繋げない手順**——利用者名の改名とデータベース名の改名——は、
**接続先を `-d template1` に揃えてある。** 別のデータベースを作業台にする必要があるためで、
`template1` を選ぶのは次の3つを同時に満たすからである。

- **必ず存在する。** initdb が作り、`POSTGRES_DB` の値に左右されない
- **名前が動かない。** 復旧の対象にならないので、手順の途中で消えたり改名されたりしない
- **接続を許している**（`datallowconn` が真。実行して確認した）

`postgres` も initdb が作るが、**`POSTGRES_DB=postgres` にしていると直す対象と同じものになり、
`ERROR: current database cannot be renamed` で止まる**（実行して確認した）。
`template1` に揃えておけば、`POSTGRES_DB` に何を選んでいてもこの衝突が起きない。

**パスワードの手順だけは `template1` に寄せない。** `\password` は
**対象のデータベースに繋いだままロールのパスワードを変えられる**ので、作業台が要らない。
`-d "$POSTGRES_DB"` で繋ぐのはそのためであり、**下の順序が要る理由もここにある**
（DB 名を先に直しておかないと、その名前で繋げない）。

**2つ以上ずれている場合は `POSTGRES_USER` → `POSTGRES_DB` → `POSTGRES_PASSWORD` の順に直す。
下の表も、そのあとの手順も、この順に並べてある。上から順に叩けばよい。**

各手順は**残りが一致していることを前提に繋ぐ**ためである。
利用者名の改名だけが `-U <古い名前>` を直接指定するため、前提を持たない。
`ALTER DATABASE` は `-U "$POSTGRES_USER"` で繋ぐので利用者名が要る。
`\password` は `-U "$POSTGRES_USER" -d "$POSTGRES_DB"` で繋ぐので利用者名と DB 名の両方が要る。

**`.env` を `.env.example` から作り直した場合は3つとも新しい値になる**ので、この順序が要る。
逆順に叩くと、最初の1つで `FATAL: role "<新しい利用者名>" does not exist` になる
（実行して確認した。パスワード・DB 名のどちらから始めても同じところで止まった）。

| ずれた値 | 消さずに直す方法 |
|---|---|
| `POSTGRES_USER` | 下記の**一時ロールを作ってから** `ALTER ROLE ... RENAME TO`（自分自身は改名できない） |
| `POSTGRES_DB` | 下記の `ALTER DATABASE ... RENAME TO`（**その DB への接続が1本でも残っていると実行できない。** 自分は `-d template1` で繋ぐ） |
| `POSTGRES_PASSWORD` | 下記の `\password`（`ALTER ROLE ... PASSWORD '<平文>'` は使わない） |

**利用者名**は一時ロールを作ってから改名する。

```
docker compose exec db psql -U <古い名前> -d template1 -c 'CREATE ROLE tmp_rename SUPERUSER LOGIN;'
docker compose exec db sh -c 'psql -U tmp_rename -d template1 -c "ALTER ROLE \"<古い名前>\" RENAME TO \"$POSTGRES_USER\";"'
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d template1 -c "DROP ROLE tmp_rename;"'
```

**一時ロールが要るのは、`ALTER ROLE ... RENAME TO` が
`session user cannot be renamed` で自分自身の改名だけを拒むためである。**
公式イメージは `POSTGRES_USER` の1つしかログイン可能なロールを作らないので、
**改名する側のロールを自分で用意する。**

**新しいロールを作って乗り換えるのではなく、旧ロール自身を改名する。**
乗り換えると既存の表の所有者は古いロールのままだが、改名ならロールの識別子が変わらないため
**所有権も権限も付いて回る。** パスワードも残る（PostgreSQL 17 の既定は `scram-sha-256` で、
検証子に利用者名を含まない。`md5` なら壊れるが、このイメージは使っていない）。

**一時ロールにパスワードを設けないのは、`docker compose exec` からの接続が
Unix ドメインソケット（`local all all trust`）を通るためである。**
公開ポート経由では入れない。使い終わったら `DROP ROLE` する。

**2行目が失敗したら、3行目も必ず失敗する。** 3行目は `-U "$POSTGRES_USER"`（**新しい**名前）で
繋ぐが、改名が済んでいないその名前はまだ存在しないためである。
**パスワードを持たない `SUPERUSER` ロール `tmp_rename` が残る。**
そのまま1行目から叩き直すと `ERROR: role "tmp_rename" already exists` で落ちる。

**この場合は、古い名前で繋いで消す。**

```
docker compose exec db psql -U <古い名前> -d template1 -c 'DROP ROLE tmp_rename;'
```

**`-U tmp_rename` では消せない**（`ERROR: current user cannot be dropped`）。
消してから1行目に戻る。

**ヘルスチェックが緑になっても、3行目は必ず叩く。**
緑になるのは2行目（改名）が済んだ時点であり、**後始末が済んだ証拠ではない。**
3行目を忘れても、落としても、**緑のままパスワードを持たない `SUPERUSER` が残る。**

**最後に、残っていないことを数えて確かめる。**

```
docker compose exec db sh -c "psql -U \"\$POSTGRES_USER\" -d template1 -c \"SELECT count(*) FROM pg_roles WHERE rolname = 'tmp_rename'\""
```

（実行して確認した。`DROP ROLE` の前は 1、後は 0 になった）

（**この行と、後述の接続数を数える行の2つだけ** `sh -c` の外側が二重引用符である。
**SQL の中に単一引用符が要る**ためで、外側も単一引用符にすると閉じてしまう。
`$POSTGRES_USER` をコンテナの中で展開させる目的は他の行と同じで、`\$` で手元のシェルから逃がす）

（すべて実行して確認した。`<古い名前>` を打ち間違えて2行目を
`ERROR: role "..." does not exist` で落としたところ、3行目は
`FATAL: role "<新しい名前>" does not exist` で繋がらず、`tmp_rename` が
`rolsuper = t` / `rolcanlogin = t` のまま残った。上の1行で消えた）

**実行して確かめた結果**は次のとおりである。

```
表の所有者（改名前）: <古い名前>
.env を <新しい名前> に変えて up      → 想定どおり unhealthy
CREATE ROLE / ALTER ROLE / DROP ROLE  → いずれも成功
                                      → 10 秒後: healthy（コンテナは作り直していない）
表の所有者（改名後）: <新しい名前>
表の行数: 変わっていない
公開ポート経由（新しい名前とパスワード）: 繋がった
```

**データベース名**は `-d template1` に繋いで改名する。

```
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d template1 -c "ALTER DATABASE \"<古い名前>\" RENAME TO \"$POSTGRES_DB\";"'
```

**`-d "$POSTGRES_DB"` で繋いではいけない。** その値は**これから作ろうとしている新しい名前**であり、
まだ存在しない。改名したあとも、コンテナを作り直さずに緑に戻る
（実行して確認した。表も残っていた）。

**条件はもう1つある。旧データベースに他のセッションが1本でも繋いでいると失敗する。**
`-d template1` で繋いだかどうかとは別の話であり、**自分が対象の DB を避けていても止まる。**
別の端末で開いたままの `psql` や、止め忘れた `npm run dev -w @workspace-chat/api` が該当する。

```
ERROR:  database "<古い名前>" is being accessed by other users
DETAIL:  There is 1 other session using the database.
```

**改名の前に数えて確かめる。0 でなければ、その接続を閉じてから叩く。**

```
docker compose exec db sh -c "psql -U \"\$POSTGRES_USER\" -d template1 -c \"SELECT count(*) FROM pg_stat_activity WHERE datname = '<古い名前>'\""
```

（外側が二重引用符なのは、上の件数を数える行と同じ理由である）

（実行して確認した。接続を1本張ったまま叩くと上のエラーになり、閉じて 0 にしてから
叩き直すと `ALTER DATABASE` が通った。**`psql` のプロセスを手元で切っただけでは 0 にならない**
場合がある。数えるのはサーバー側の接続であり、こちらが確実である）

**パスワード**は `psql` に入って `\password` で変える。

```
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

```
<POSTGRES_DB の値>=# \password
```

**入力するのは `.env` に書いた `POSTGRES_PASSWORD` と同じ値である。**
別の値を入れると、DB は変わったのに**ヘルスチェックは赤のまま**になり、
「`\password` が効かなかった」と読み違える。

**正しく入力すれば、コンテナを作り直さずに次のヘルスチェックで緑に戻る**
（実行して確認した。10 秒後に `healthy`）。ずれているのは DB の中身だけで、
コンテナの環境変数は `up` の時点ですでに新しいためである。
**`restart` では直らない**（前述）のと逆の向きの話になる。

**`ALTER ROLE ... PASSWORD '<平文>'` を1行で叩かない。** 平文が手元のシェル履歴と
コンテナ内のプロセス引数に残る。`\password` は**入力を受け取ってから
クライアント側でハッシュに変換して送る**ため、どちらにも平文が残らない。

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

接続先は `.env` に書いた値から組み立てる。

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
