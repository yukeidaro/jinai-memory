# Renderへのデプロイ手順（Yu向け）

依存パッケージのインストールやビルドコマンドは不要です。RenderがDockerfileを使い、Node 24で `node src/server.js` を実行します。同じサービスがMCPと画面を配信します。

**事前条件：この作業ブランチには現在 `public/` がありません（T3b待ち）。** Claude側でT3bの画面と今回の4ファイルを統合し、GitHub上のデプロイ対象ブランチに `public/index.html` があることを確認してから進めてください。無いままだと `COPY public ./public` でDockerビルドが失敗します。空ディレクトリだけではGitに保存されません。このPCにはDockerが無いため、イメージのビルドは未確認です。

## 手順

1. **Renderのアカウント作成とGitHub連携**

   [Renderの登録画面](https://dashboard.render.com/register)でアカウントを作成し、[Dashboard](https://dashboard.render.com)を開きます。GitHubアカウントを連携し、RenderのGitHub Appに `yukeidaro/jinai-memory` へのアクセスを許可してください。非公開リポジトリの場合も、このリポジトリを許可対象にします。

2. **New → Blueprintでリポジトリを選ぶ**

   Dashboard右上の **New → Blueprint** を選び、`yukeidaro/jinai-memory` の **Connect** を押します。Blueprint名を入力し、**Branch** に統合済みのブランチを選びます。**Blueprint Path** はルートの `render.yaml` のままにします。YAMLには `branch` を固定していないため、このサービスもBlueprintと同じブランチを使います。

   FalkorDB Cloudは **GCP `us-central1`（アイオワ）** にあるため、`render.yaml` は最も近いRenderの **Ohio (`ohio`)** を指定しています。DBとの通信遅延を抑えるため、作成画面でもOhioが選ばれていることを確認してください。**作成後のリージョン変更にはサービスの作り直しが必要**です。

3. **秘密値を確認し、Deploy Blueprintを押す**

   `MEMORY_TOKEN` はRenderが自動生成します。複数ユーザーで使う場合は、下の「デモとYuの記憶を分ける」に従い `MEMORY_USERS` も設定してください。

   | 環境変数 | 設定方法 |
   | --- | --- |
   | `FALKORDB_URL` | 自分のPCのPowerShellで下のコマンドを実行し、表示された値を自分でRenderの入力欄へ貼り付けます。空欄のままデプロイしないでください。 |
   | `OPENAI_API_KEY` | 既定の `fake` では不要です。入力欄を空にできれば空欄、入力必須の場合はダミーの `not-used-with-fake` を入れます。実際のAPIキーは必要ありません。 |
   | `MEMORY_TOKEN` | `generateValue: true` により自動生成。デプロイ後に手順4で確認します。 |
   | `MEMORY_USERS` | 複数ユーザー用の任意設定。設定すると `MEMORY_TOKEN` と `MEMORY_USER` より優先されます。単一ユーザーで使う場合は変数自体を未設定にしてください。空文字として保存された場合は **Environment** から削除します。 |

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
   | `MEMORY_USERS ...` で起動しない | JSONオブジェクト、ユーザー名、24文字以上の非空トークン、トークンの重複を確認する。単一ユーザーに戻す場合は変数自体を削除する。値をログやチャットに貼らない。 |
   | `Server startup failed` / Liveにならない | **Logs** と **Environment**。DBの接続先・認証・稼働状態、FalkorDB Cloudの接続許可設定、埋め込みの次元と既存インデックスが一致しているかを確認する。 |
   | `/healthz` が応答しない | **Events** の状態、**Logs**、Freeの復帰待ちかどうか、サービスURLの誤記を確認する。 |
   | `/healthz` は正常だが画面が404 | `public/index.html` の有無を確認する。サーバーは画面ファイルが無くても起動できる。 |
   | 画面のデータ取得やコネクタが失敗 | トークン、URLエンコード、末尾の `-claude` / `-chatgpt` を確認する。`/healthz` が正常でもDB接続やクライアント互換性は別途確認が必要。 |
   | 記憶が再起動で消える | 起動ログが `store: falkordb` か。`store: memory` なら `FALKORDB_URL` が未設定または空。 |

## デモとYuの記憶を分ける

`MEMORY_USERS` は `{"demo":"<demo-token>","yu":"<yu-token>"}` のJSONオブジェクトです。設定すると従来の `MEMORY_TOKEN` と `MEMORY_USER` は無視され、トークンごとに `memory:demo` / `memory:yu` を読み書きします。MCP、画面の `/api/graph`、通知の `/events` はすべて同じユーザーで分離されます。既存の `memory:demo` はそのまま使われ、データの移動や複製は行いません。

1. **URL変換が不要なトークンを2つ作る**

   PowerShell 7の自分の端末で次の1行を2回実行し、それぞれデモ用・Yu用として秘密の場所へ控えます。暗号的に安全な乱数から48桁の16進文字列を作るため、`+` `/` `=` のURL変換は不要です。出力をチャットやリポジトリへ貼らないでください。

   ```powershell
   [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLower()
   ```

2. **RenderのEnvironmentで設定し、Save and deployする**

   サービスの **Environment → Environment Variables** に `MEMORY_USERS` を追加し、`{"demo":"<demo-token>","yu":"<yu-token>"}` の各プレースホルダーを実際の別々のトークンに置き換えます。ユーザー名は英数字・`_`・`-` の1〜40文字、トークンは24文字以上の非空文字列で、重複は不可です。JSON全体をさらに引用符で囲まないでください。

   **Save and deploy** を選び、**Live** になってから、起動ログに `users: demo, yu` と出ることを確認します。トークンは起動ログへ出しません。不正な設定は起動エラーとなり、従来のトークンへ自動で戻ることはありません。単一ユーザーへ戻す場合は `MEMORY_USERS` 自体を削除して再デプロイします。

3. **各コネクタと画面のURLを貼り直す**

   以前の `MEMORY_TOKEN` を含むURLは使えなくなります。Claude / ChatGPTの各コネクタで次のURLを登録し直し、画面も対応するトークンで開き直します。

   | 用途 | URLの形 |
   | --- | --- |
   | デモ用Claude | `https://<サービス>.onrender.com/mcp/<demo-token>-claude` |
   | デモ用ChatGPT | `https://<サービス>.onrender.com/mcp/<demo-token>-chatgpt` |
   | 審査員用画面 | `https://<サービス>.onrender.com/?token=<demo-token>` |
   | Yu用Claude | `https://<サービス>.onrender.com/mcp/<yu-token>-claude` |
   | Yu用ChatGPT | `https://<サービス>.onrender.com/mcp/<yu-token>-chatgpt` |
   | Yu用画面 | `https://<サービス>.onrender.com/?token=<yu-token>` |

   審査員にはデモ用だけを渡し、Yu用URLを録画・画面共有・配布資料に含めないでください。各トークンで別の架空の記憶を保存し、対応する画面とコネクタにだけ表示されることを確認します。既存のURL変換が必要なトークンを使う場合も起動できますが、警告に従ってトークン部分だけをURLエンコードしてください。この分離はDBとの通信を暗号化するものではありません。

## 必ず守る注意

今回使うFalkorDB接続の `redis://` は**暗号化されない通信**です。公開HTTPSはブラウザ／コネクタとRenderの間だけを保護し、RenderとDB間の平文通信は保護しません。**デモ用データだけ**を入れ、個人情報・実ユーザーデータ・機密情報を保存しないでください。リージョンを合わせても暗号化にはなりません。

`MEMORY_TOKEN`、または `MEMORY_USERS` の各トークンは、同じユーザーの画面とコネクタで共有する秘密です。トークン付きURLを公開しないでください。録画のアドレスバー、ブラウザ履歴、画面共有、チャット、issueにも注意してください。漏えいした場合は **Environment** で該当トークンを交換して **Save and deploy** し、そのユーザーの全コネクタと画面URLを更新します。`FALKORDB_URL` と `OPENAI_API_KEY` も同様に秘密として扱います。`.env.example` は説明用であり、本物の値を書き込んでコミットしないでください。

## 確認した公式仕様

- [Render Blueprint YAML Reference](https://render.com/docs/blueprint-spec)：`runtime: docker`、`plan: free`、`region`、`healthCheckPath`、`envVars`、`generateValue: true`、`sync: false`。指定の `autoDeploy: true` は現在非推奨ですが、有効で `autoDeployTrigger: commit` と同義です。
- [Blueprintの作成画面と手順](https://render.com/docs/infrastructure-as-code)
- [環境変数の表示・変更](https://render.com/docs/configure-environment-variables)
- [リージョンと作成後の変更制限](https://render.com/docs/regions)
- [Freeのスリープと制限](https://render.com/docs/free)
- [RenderのDockerデプロイ](https://render.com/docs/docker)
- [Docker Hub公式Nodeイメージの `24-slim` タグ](https://hub.docker.com/layers/library/node/24-slim/images)：公式APIでもタグの実在とLinux amd64イメージが `active` であることを確認済み。
