# Renderへのデプロイ手順（Yu向け）

依存パッケージのインストールやビルドコマンドは不要です。RenderがDockerfileを使い、Node 24で `node src/server.js` を実行します。同じサービスがMCPと画面を配信します。

**事前条件：この作業ブランチには現在 `public/` がありません（T3b待ち）。** Claude側でT3bの画面と今回の4ファイルを統合し、GitHub上のデプロイ対象ブランチに `public/index.html` があることを確認してから進めてください。無いままだと `COPY public ./public` でDockerビルドが失敗します。空ディレクトリだけではGitに保存されません。このPCにはDockerが無いため、イメージのビルドは未確認です。

## 手順

1. **Renderのアカウント作成とGitHub連携**

   [Renderの登録画面](https://dashboard.render.com/register)でアカウントを作成し、[Dashboard](https://dashboard.render.com)を開きます。GitHubアカウントを連携し、RenderのGitHub Appに `yukeidaro/jinai-memory` へのアクセスを許可してください。非公開リポジトリの場合も、このリポジトリを許可対象にします。

2. **New → Blueprintでリポジトリを選ぶ**

   Dashboard右上の **New → Blueprint** を選び、`yukeidaro/jinai-memory` の **Connect** を押します。Blueprint名を入力し、**Branch** に統合済みのブランチを選びます。**Blueprint Path** はルートの `render.yaml` のままにします。YAMLには `branch` を固定していないため、このサービスもBlueprintと同じブランチを使います。

   FalkorDB Cloudは **GCP `us-central1`（アイオワ）** にあるため、`render.yaml` は最も近いRenderの **Ohio (`ohio`)** を指定しています。DBとの通信遅延を抑えるため、作成画面でもOhioが選ばれていることを確認してください。**作成後のリージョン変更にはサービスの作り直しが必要**です。

3. **秘密値の3項目を確認し、Deploy Blueprintを押す**

   手入力するのは次の2欄です。`MEMORY_TOKEN` はRenderが自動生成するため、3項目すべてを手入力する必要はありません。

   | 環境変数 | 設定方法 |
   | --- | --- |
   | `FALKORDB_URL` | 自分のPCのPowerShellで下のコマンドを実行し、表示された値を自分でRenderの入力欄へ貼り付けます。空欄のままデプロイしないでください。 |
   | `OPENAI_API_KEY` | 既定の `fake` では不要です。入力欄を空にできれば空欄、入力必須の場合はダミーの `not-used-with-fake` を入れます。実際のAPIキーは必要ありません。 |
   | `MEMORY_TOKEN` | `generateValue: true` により自動生成。デプロイ後に手順4で確認します。 |

   ```powershell
   [Environment]::GetEnvironmentVariable('FALKORDB_URL','User')
   ```

   **このコマンドはYuが自分の端末で実行するものです。出力をチャット・issue・PR・スクリーンショットに貼らないでください。** 値が空なら中断し、FalkorDB Cloudの管理画面で接続情報を確認してください。ローカルの `localhost` ではなく、Renderから到達可能なCloudの接続先が必要です。

   `EMBEDDINGS_PROVIDER=fake` と `MEMORY_USER=demo` はBlueprintで設定済みです。`EMBED_DIM` は追加しなければ `128` です。`PORT` はRenderが渡すので設定不要です。**Free** / **Docker** / **Health Check Path: /healthz** を確認し、**Deploy Blueprint** を押します。`sync: false` の入力要求は初回作成時だけです。

   OpenAIを使う場合だけ、実際の `OPENAI_API_KEY` を秘密として入力し、Blueprintの `EMBEDDINGS_PROVIDER` も `openai` に変更してください。`EMBED_DIM` を省略した場合は `1536` になります。既存の128次元インデックスとは互換性が無いため、新しいデモ用 `MEMORY_USER` をBlueprintに設定するなど、既存データと分けてください。Blueprintの固定値は次の同期で再適用されるため、Dashboardだけで `fake` を変更しないでください。

4. **デプロイ完了、公開URL、MEMORY_TOKENを確認する**

   Blueprintから作成された **jinai-memory** サービスを開き、**Events** でデプロイが **Live** になるまで待ちます。サービス画面上部の公開URL（`https://<サービス>.onrender.com`）を控えます。実際のサブドメインは画面に表示されたものを使ってください。

   左メニュー **Environment → Environment Variables** で `MEMORY_TOKEN` の値を表示して、自分だけが使う場所へ控えます。後から接続情報を修正する場合もここを開き、保存時に **Save and deploy** を選びます。**Save only** では次のデプロイまで実行中サービスに反映されません。

   ブラウザで `https://<サービス>.onrender.com/healthz` を開き、`{"ok":true}` が返ることを確認します。このURLにはトークンは不要です。これはHTTPサーバーの稼働確認であり、DBの継続的な疎通確認ではありません。

5. **Claude / ChatGPTのコネクタと画面を開く**

   それぞれのカスタムMCPコネクタのサーバーURL欄に、次の形で登録します。利用プランや設定画面でカスタムMCPの追加が有効になっている必要があります。

   | 用途 | URLの形 |
   | --- | --- |
   | Claude | `https://<サービス>.onrender.com/mcp/<MEMORY_TOKEN>-claude` |
   | ChatGPT | `https://<サービス>.onrender.com/mcp/<MEMORY_TOKEN>-chatgpt` |
   | 画面 | `https://<サービス>.onrender.com/?token=<MEMORY_TOKEN>` |

   **トークン部分だけをURLエンコードして置き換えてください。** Renderの生成値はBase64なので `+`、`/`、`=` を含む場合があります。特に画面URLで未変換の `+` は空白として解釈され、認証に失敗します。ブラウザの `encodeURIComponent` 相当で `+` → `%2B`、`/` → `%2F`、`=` → `%3D` と変換します。サービスの **Environment** に保存する値自体は変換しません。エンコードした値も秘密です。

   このサーバーはURL中の共有トークンで認証し、OAuthは提供しません。コネクタに認証方式の選択肢があれば **認証なし / No authentication** を選びます（URL内のトークンによる保護は必要です）。MCPはPOST用なので、MCPのURLをブラウザで直接開いたときの **405** は異常ではありません。コネクタの初期化・ツール一覧取得を行い、片方で保存したデモ記憶がもう片方と画面で見えることまで確認してください。

6. **録画前にスリープから起こす**

   FreeのWebサービスは受信通信が約15分無いとスリープし、次のアクセスからの復帰に約1分かかることがあります。録画の数分前に画面URLと `/healthz` を開き、画面が表示され、`{"ok":true}` が返ってからコネクタを接続してください。待機画面や初回タイムアウトの場合は、起動を待って再試行します。外部の常時監視サービスを追加する必要はありません。

   Freeはデモ用です。月間無料稼働時間などの上限や一時停止にも注意してください。`FALKORDB_URL` が空だとメモリ内保存になり、スリープ・再起動・再デプロイで記憶が消えます。

7. **うまくいかないときに見る場所**

   サービスの **Events** で失敗したデプロイを開き、ビルドログを確認します。起動後のログは左メニューの **Logs** で見ます。ログを共有する場合も、URL・トークン・APIキーが含まれていないか自分で確認してください。

   | 症状 | 確認箇所 |
   | --- | --- |
   | `COPY public` で失敗 | 選んだGitHubブランチにT3bの `public/index.html` が統合されているか。T3b待ちならデプロイを待つ。 |
   | `MEMORY_TOKEN is required` | **Environment** に非空の自動生成値があるか。修正後にデプロイしたか。 |
   | `Server startup failed` / Liveにならない | **Logs** と **Environment**。DBの接続先・認証・稼働状態、FalkorDB Cloudの接続許可設定、埋め込みの次元と既存インデックスが一致しているかを確認する。 |
   | `/healthz` が応答しない | **Events** の状態、**Logs**、Freeの復帰待ちかどうか、サービスURLの誤記を確認する。 |
   | `/healthz` は正常だが画面が404 | `public/index.html` の有無を確認する。サーバーは画面ファイルが無くても起動できる。 |
   | 画面のデータ取得やコネクタが失敗 | トークン、URLエンコード、末尾の `-claude` / `-chatgpt` を確認する。`/healthz` が正常でもDB接続やクライアント互換性は別途確認が必要。 |
   | 記憶が再起動で消える | 起動ログが `store: falkordb` か。`store: memory` なら `FALKORDB_URL` が未設定または空。 |

## 必ず守る注意

今回使うFalkorDB接続の `redis://` は**暗号化されない通信**です。公開HTTPSはブラウザ／コネクタとRenderの間だけを保護し、RenderとDB間の平文通信は保護しません。**デモ用データだけ**を入れ、個人情報・実ユーザーデータ・機密情報を保存しないでください。リージョンを合わせても暗号化にはなりません。

`MEMORY_TOKEN` は画面と全コネクタで共有する秘密です。トークン付きURLを公開しないでください。録画のアドレスバー、ブラウザ履歴、画面共有、チャット、issueにも注意してください。漏えいした場合は **Environment** でトークンを交換して **Save and deploy** し、全コネクタと画面URLを更新します。`FALKORDB_URL` と `OPENAI_API_KEY` も同様に秘密として扱います。`.env.example` は説明用であり、本物の値を書き込んでコミットしないでください。

## 確認した公式仕様

- [Render Blueprint YAML Reference](https://render.com/docs/blueprint-spec)：`runtime: docker`、`plan: free`、`region`、`healthCheckPath`、`envVars`、`generateValue: true`、`sync: false`。指定の `autoDeploy: true` は現在非推奨ですが、有効で `autoDeployTrigger: commit` と同義です。
- [Blueprintの作成画面と手順](https://render.com/docs/infrastructure-as-code)
- [環境変数の表示・変更](https://render.com/docs/configure-environment-variables)
- [リージョンと作成後の変更制限](https://render.com/docs/regions)
- [Freeのスリープと制限](https://render.com/docs/free)
- [RenderのDockerデプロイ](https://render.com/docs/docker)
- [Docker Hub公式Nodeイメージの `24-slim` タグ](https://hub.docker.com/layers/library/node/24-slim/images)：公式APIでもタグの実在とLinux amd64イメージが `active` であることを確認済み。
