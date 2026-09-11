# ローカル DB の復旧

`.env` の `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` が、起動済みのコンテナや
ボリュームの中身とずれてしまったとき、**手元のデータを捨てずに**直す手順である。
捨ててよい場合の最短経路は [README](../README.md) を参照。

**このファイル名は `.env.example` の3箇所から参照されている。** 移動・改名するときは
`.env.example` 側も直す。

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

**分かれ目はコンテナの有無ではなく、書き戻す値が作成時と同じかどうかである。**

**値を変えるなら、コンテナが残っていても `docker start` を使わない。**
`docker start` は**コンテナを作り直さないので、中の環境変数は作成時のまま**である。
下の復旧手順は `$POSTGRES_USER` / `$POSTGRES_DB` を**コンテナの中で**展開するため、
**`.env` を直しても古い値のまま実行される。**

> **実行して確認した。** `.env` を `olduser` から `newuser` に書き換えて `docker start` したところ、
> コンテナの中は `POSTGRES_USER=olduser` のままで、**ヘルスチェックは終始 `healthy` だった。**
> その状態で利用者名の改名を叩くと、`ALTER ROLE "olduser" RENAME TO "olduser"` になり
> **`ERROR: role "olduser" already exists` で落ちる。**
> `.env` を直したのに何も変わらず、**赤にもならない。**
> これは本書がずっと潰してきた「ずれが緑のまま隠れる」形そのものである。

**値を変える場合**（3つのどれかを別の値にする。復旧手順を踏むのはこの場合である）。
**`.env` を書き戻してから作り直す。**

```
docker compose up -d
```

**値は作成時と同じで、ただ止めただけの場合**（`docker stop` しただけで `.env` も変えていない）。
このときだけ `docker start` でよい。

```
docker start workspace-chat-db-1
```

**コンテナを失っている場合**（`docker rm -f` を通った。この節の本来の前提）は
`docker start` が `Error: No such container` になる。上の `docker compose up -d` に進む。

**`.env` が無いと `up` も止まる**（`${VAR:?...}` は compose の読み込み時に評価されるため、
`build` / `down` / `ps` と同じく止まる）。
**`docker compose up -d` に書き戻すのは、これから使いたい新しい値でよい。**
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
