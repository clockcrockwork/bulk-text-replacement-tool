# GitHub App / Vercel の設定（V2: GitHub から追加）

`docs/github-import-v2.md` の実装が参照する設定値と、人が GitHub / Vercel の画面で
行う手順。コード側で決まっている名前・URL はここが正本。

対象は `main`（Vercel）だけ。`release/lolipop-v1` には何も設定しない。

## 決まっている値

| 項目 | 値 |
| --- | --- |
| 本番オリジン | `https://bulk-text-replacement-tool.vercel.app` |
| Callback URL（完全一致） | `https://bulk-text-replacement-tool.vercel.app/` （末尾の `/` まで一致させる） |
| トークン交換 | `POST /api/github/token`（`api/github/token.js`） |
| GitHub REST API の版 | 指定しない（GitHub の既定版。現在 `2022-11-28`）。`X-GitHub-Api-Version` は GitHub の CORS が許可していないため、ブラウザからは付けられない（`docs/github-import-v2.md` §6） |

callback をオリジン直下にしているのは、ビルドが相対パス（vite の `base: './'`）で、
下位のパスで開くと JS / CSS の参照が壊れるため。Vercel の一時的な Preview URL は
callback として登録しない（実 OAuth の確認は本番、または固定した検証用 URL で行う）。

## 1. GitHub App を作る

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
（Organization で持つなら Organization の Settings から）。

- **GitHub App name**: 任意。ここで決まる slug（URL の `github.com/apps/<slug>`）を控える
- **Homepage URL**: `https://bulk-text-replacement-tool.vercel.app/`
- **Callback URL**: `https://bulk-text-replacement-tool.vercel.app/` を1つだけ
- **Expire user authorization tokens**: オン（既定のまま）。**オフにすると接続できなくなる**
  （期限の無いトークンは、Function もブラウザも受け付けない）
- **Request user authorization (OAuth) during installation**: **オフ**
  （アプリが自分で state と PKCE を付けて認可を始めるため。オンにすると GitHub 側から
  state の無い認可が始まる）
- **Enable Device Flow**: オフ
- **Setup URL**: 空欄（Redirect on update もオフ）
- **Webhook**: **Active のチェックを外す**
- **Repository permissions**:
  - Contents: **Read-only**
  - Metadata: **Read-only**（Contents を選ぶと自動で付く）
  - それ以外はすべて No access
- **Organization permissions / Account permissions**: すべて No access
- **Where can this GitHub App be installed?**: 自分だけで使うなら Only on this account、
  他の人にも使ってもらうなら Any account

作成後、App の設定画面で **Client ID** を控え、**Generate a new client secret** で
secret を作る（secret は一度しか表示されない）。

## 2. Vercel の環境変数

Project `bulk-text-replacement-tool` → Settings → Environment Variables。
Environment は **Production** にだけ設定する（Preview の URL は callback に登録しないため）。

| 名前 | 値 | 使う場所 |
| --- | --- | --- |
| `VITE_GITHUB_APP_CLIENT_ID` | App の Client ID | ブラウザ（ビルド時に埋め込み）と Function |
| `VITE_GITHUB_APP_SLUG` | App の slug | ブラウザ（インストール画面への案内） |
| `GITHUB_APP_CLIENT_SECRET` | App の client secret（**Sensitive** にする） | Function だけ |
| `GITHUB_OAUTH_ALLOWED_ORIGINS` | `https://bulk-text-replacement-tool.vercel.app` | Function だけ |
| `GITHUB_OAUTH_REDIRECT_URIS` | `https://bulk-text-replacement-tool.vercel.app/` | Function だけ |

- `VITE_` で始まる2つは公開値で、ビルドに埋め込まれる。未設定のビルドでは
  「GitHubから追加」ボタンが無効になる
- **どの変数も、変えたら再デプロイが必要**（`VITE_` だけでなく、secret と許可リストも）。
  Vercel の環境変数は新しいデプロイにしか反映されない。再デプロイを忘れると、本番の
  Function は古い値のまま動く
- 許可リストはカンマ区切りで複数書ける。独自ドメインを足すときは両方に足し、
  GitHub App の Callback URL にも同じ URL を追加する
- **2つの許可リストは末尾の `/` の要否が逆**。取り違えやすいので、形が崩れていると
  Function は設定なし（503 `not_configured`）として断り、どの変数が崩れているかを
  Function のログに出す
  - `GITHUB_OAUTH_ALLOWED_ORIGINS`：オリジンそのもの。**`/` を付けない**（`https://example.com`）
  - `GITHUB_OAUTH_REDIRECT_URIS`：オリジン直下の callback。**`/` を付ける**（`https://example.com/`）。
    オリジンは `GITHUB_OAUTH_ALLOWED_ORIGINS` のどれかと同じであること

### client secret を差し替える

古い secret を先に消すと、差し替えが本番に届くまでのあいだ全員の接続が失敗する
（GitHub は `incorrect_client_credentials` を返し、画面には「交換に失敗: 400 exchange_rejected」と出る）。
次の順で行う。

1. GitHub App の設定で **新しい secret を作る**（古い secret はまだ消さない。App は secret を同時に複数持てる）
2. Vercel の `GITHUB_APP_CLIENT_SECRET` を新しい値に変える
3. **Production を再デプロイする**
4. §5 の 1〜3 で接続できることを確かめる
5. GitHub App の設定で **古い secret を削除する**

### 「接続できない」と言われたとき

画面の「トークンの交換に失敗: <状態コード> <理由コード>」と、Function のログで切り分ける。

| 画面に出るもの | 主な原因 | 直し方 |
| --- | --- | --- |
| `503 not_configured` | 環境変数が無い・形が崩れている・変えたあと再デプロイしていない | Function のログに出る変数名を見て直し、再デプロイする |
| `403 origin_not_allowed` | 許可していないオリジン（Production の別名など）から開いている | 正規の URL で開く。独自ドメインなら両方の許可リストに足す |
| `400 redirect_uri_not_allowed` | 開いたオリジンの callback が許可リストに無い | `GITHUB_OAUTH_REDIRECT_URIS` に `https://<そのオリジン>/` を足す |
| `400 exchange_rejected` | コードの期限切れ・使い回し、または secret の不一致 | もう一度接続する。全員が失敗するなら secret と再デプロイを確かめる |
| `502 upstream_invalid` | GitHub App の「Expire user authorization tokens」がオフ（期限の無いトークンは受け付けない） | App の設定でオンに戻す |
| `502 upstream_unreachable` / `upstream_error` | GitHub 側の障害・遅延 | 時間をおいて接続し直す |
| `429`（一時的に制限） | Firewall のレート制限（§3） | 1 分ほど待つ。同じ IP の利用者が続けて試していないかも確かめる |
- client secret は `VITE_` を付けない（付けるとブラウザに配られる）

## 3. トークン交換のレート制限（Vercel Firewall）

`/api/github/token` は Origin を許可リストと照合しているが、Origin を偽れないのは
ブラウザだけで、curl などからは任意の Origin で叩ける。正しい code と verifier が
無ければ GitHub との交換は通らないが、大量に送られると Function の実行回数を消費し、
GitHub 側で App の client_id ごと絞られるおそれがある。

これは **Vercel Firewall のレート制限ルール**で止める。Function の中にメモリ上の
カウンタを置く方式は使わない（サーバーレスではインスタンスが複数立ち、起動のたびに
消えるので、数えた値がインスタンス間で共有されず、制限として機能しない）。

Project `bulk-text-replacement-tool` → Firewall → Configure → **+ New Rule**（Custom Rule）:

| 項目 | 値 |
| --- | --- |
| Name | `github-token-exchange-rate-limit` |
| If | **Request Path** — **Starts with** — `/api/` |
| Then | **Rate Limit** |
| Algorithm | Fixed Window |
| Window | 60 秒 |
| Limit | 10 リクエスト |
| Key | IP Address |
| Action（超過時） | Too Many Requests（429） |

- **完全一致（Equals `/api/github/token`）にしない。** 同じ Function には
  `/api/github/token/`（末尾の `/`）や `/api/github/token.js`（拡張子付き）でも届き、
  完全一致の条件はそれらを数えない（Preview で3つとも Function が応答することを確認した）。
  `api/` にある Function はトークン交換だけなので、`/api/` の前方一致で巻き込むものは無く、
  Function を足したときにも既定で制限が効く
- メソッドでは絞らない（POST 以外も Function を起動する。405 を返すだけでも実行回数に数えられる）
- 値の根拠: 正規の利用者が交換するのは「GitHubに接続」1回につき1回だけ。
  接続のやり直しを何度か続けても 1 分に 10 回には届かない
- 超過した利用者の画面には「トークンの交換に失敗: 429」と出るだけで、作業データは失われない
  （もう一度接続すれば済む）
- 作成後に **Review Changes → Publish** で反映する（保存しただけでは効かない）
- プランによって使えるルール数・窓の長さ・キーの種類が異なる。上の値が選べないときは、
  「IP ごとに 1 分あたり数回〜十数回」に最も近い設定にする
- Function のコードは変えない。ルールはリクエストが Function に届く前に効く
- **これはリポジトリの外の設定で、マージしただけでは有効にならない。** Publish して §5 の 9 を
  確かめるまで、L5（トークン交換のレート制限）は対応済みとして扱わない
- 回数は厳密な上限（セキュリティ上の不変条件）ではなく、**乱用を抑える歯止め**として扱う。
  計数はエッジで分散して行われるので、「全体で 1 分に必ず 10 回まで」を保証するものではない。
  交換そのものの安全性は、PKCE・state・Origin と redirect_uri の許可リストが受け持つ

### 本番への入れ方（段階導入）

設定を誤ると OAuth 全体を止めるので、いきなり本番で制限を有効にしない。

**Rate Limit を本番で有効にするのは、429 の案内文（#18 の `describeTokenExchangeFailure`）が
本番に入ってからにする。** それより前に有効にすると、制限に掛かった利用者には
「トークンの交換に失敗: 429」とだけ出て、待てば直ることが伝わらない。

**Firewall のルールは、条件に環境を入れない限り Production と Preview の両方に効く。**
上の表の条件は `/api/` の前方一致だけなので、同じルールの Then を Rate Limit に変えると、
Preview で試すつもりでも本番に同時に効く。Preview で試すときは、環境で絞った**別のルール**を
一時的に作る。

| ルール | 条件 | Then | 役割 |
| --- | --- | --- | --- |
| A（本番用） | Request Path — Starts with — `/api/` | Log → 最後に Rate Limit | 本番の観測と、最終的な制限 |
| B（検証用・一時） | Request Path — Starts with — `/api/` **かつ Environment — Equals — Preview** | Rate Limit | Preview で 429 を確かめるだけ |

1. ルール A を Then **Log** で Publish する
2. 本番で正規の接続を1回行い、Firewall のログで、その交換が A に1件だけ一致していることを
   確かめる（ほかの経路を巻き込んでいないこと）
3. ルール B を作って Publish し、Preview（固定した検証用の URL）に対して §5 の 9 の手順で
   429 が返ることを確かめる。このあいだ本番は A（Log）のままなので、制限されない
   - Preview は Vercel Authentication で保護されているので、ログイン済みのブラウザの cookie か、
     保護を回避する共有リンクを付けて送る（付けないと 429 の前にログイン画面へ 302 で戻される）
   - Preview には交換用の環境変数が無いので、Function まで届けば 503（`not_configured`）になる。
     確かめるのは、それが 429 に変わること
4. ルール B を**削除**して Publish する（残すと Preview の検証で自分が締め出される）
5. ルール A の Then を Rate Limit に切り替えて Publish する
6. 本番で §5 の 9（3つのパスすべてで 429）を確かめる

画面やプランの都合で Environment の条件が選べないときは、B の条件を
「Host — Equals — 固定した検証用 Preview のホスト名」にする。どちらも使えないときは、3 を省いて
5 のあとの 6 で確かめる（その場合、6 の直後に正規の接続が通ることも確かめる）。

## 4. 配信時のヘッダ

`vercel.json` の `headers` が、`/api/` 以外のすべての応答に次を付ける。

| ヘッダ | 値 | 理由 |
| --- | --- | --- |
| `Content-Security-Policy` | `frame-ancestors 'none'` | 他サイトの iframe に埋め込ませない（クリックジャッキング）。meta の CSP では `frame-ancestors` を指定できないためヘッダで送る |
| `X-Frame-Options` | `DENY` | `frame-ancestors` を解さない古いブラウザ向け |
| `X-Content-Type-Options` | `nosniff` | 配信物を宣言と違う型として解釈させない |
| `Referrer-Policy` | `strict-origin` | Referer をオリジンまでに絞る。認可から戻った直後は `/?code=…&state=…` のまま HTML が開き、`history.replaceState` を走らせる JS 自体と Google Fonts はその前に読まれる。ブラウザ既定の `strict-origin-when-cross-origin` は**同一オリジンの要求には URL 全体を送る**ので、`/assets/*.js` の Referer に code と state が載り、配信側のログに残り得る |

- 本体の CSP（`connect-src` など）は `index.html` の meta にあり、ヘッダの CSP はそれに
  `frame-ancestors` を足すだけ。両方があると、ブラウザは両方を満たすものだけを許す
- `Referrer-Policy` を `no-referrer` にしないのは、トークン交換の Function が Origin を
  照合しているため。Referrer-Policy は Origin ヘッダにも効き、`no-referrer` の下では
  cors 以外のモードの POST が `Origin: null` になる（Fetch 仕様）。いまの交換は
  `fetch`（cors モード）なので送られるが、実装差や呼び出し方の変更で Origin が消えると
  交換が 403 で止まる。`strict-origin` なら HTTPS のページからの要求には常に Origin が付く
  （E2E が、交換に Origin が付くことと、戻り直後の要求の Referer に code / state が無いことを
  確かめている）
- ヘッダを無視する配信先のために、`index.html` にも `<meta name="referrer">` で同じ方針を書いている
- `strict-origin` が防ぐのは、戻り URL の code / state が**その後の要求**（同一オリジンの JS・CSS、
  Google Fonts、画面遷移）の Referer に**伝わること**まで。GitHub から戻る最初の要求
  （`GET /?code=…&state=…`）そのものは、静的な SPA で query の callback を受ける以上、
  Vercel の配信基盤に届く。「code が配信側のどのログにも残らない」とは言えない
  （code は PKCE 付きの使い捨てで、単体ではトークンに交換できない）。§5 の 7 で見るのは
  Function のログだけで、エッジやアクセスログの保持・表示範囲は別に確かめる
- `/api/` の応答は Function が自前でヘッダを付ける（`Referrer-Policy: no-referrer` など）ので対象外にしている
- `vite preview`（E2E の配信元）も `vercel.json` から**ヘッダの値**を読んで返す（`vite.config.ts`）。
  共有しているのは値だけで、`source` のパス条件（`/api/` の除外）は再現していない
  （preview には `/api/` が無く、E2E のトークン交換は Playwright の route で応答している）。
  パス条件は Preview / 本番で §5 の 8 で確かめる。ヘッダを変えたら `e2e/dist.spec.ts` を合わせる

## 5. 確認（実 GitHub での smoke test）

本番にデプロイしたあと（1 の前に、GitHub App の設定で **Expire user authorization tokens が
オン**であることを見る。オフだと 1 で `502 upstream_invalid` になる）:

1. 「GitHubから追加」→ 同意画面 →「GitHubに接続」
2. 初回は「アクセスできるリポジトリがありません」になるので、
   「GitHub Appをインストール / 権限を設定」から対象リポジトリを選んでインストールし、
   元のタブで「再確認」
3. リポジトリ → 既定ブランチで開く（固定したコミットが表示される）→ フォルダを辿って
   `.md` / `.txt` / `.tex` を1つ選ぶ →「入力に追加」
4. 変換まで通ること
5. App の権限画面に write 権限が無いこと
6. 再読み込みすると、もう一度接続が必要になること
7. Vercel の Function ログ（`/api/github/token`）に、本文・コード・トークンが出ていないこと
8. `curl -sI https://bulk-text-replacement-tool.vercel.app/` で §4 のヘッダが返ること。
   `curl -sI https://bulk-text-replacement-tool.vercel.app/api/github/token` には §4 の
   `frame-ancestors` が付かず、Function 自身の `Referrer-Policy: no-referrer` が返ること
9. Firewall のルールが Publish 済みで、次の3つがすべて 429 になること。
   Origin を付けていないので、制限に掛かるまでは 403（`.js` と末尾 `/` も同じ Function）が返る

   ```sh
   BASE=https://bulk-text-replacement-tool.vercel.app
   for i in $(seq 11); do curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/github/token"; done
   for p in /api/github/token /api/github/token/ /api/github/token.js; do
     curl -s -o /dev/null -w "$p %{http_code}\n" -X POST "$BASE$p"
   done
   ```

   確かめたあとは窓（60 秒）が明けるまで、同じ IP からは接続できない。
   **利用者と同じ回線（社内の NAT・同じ Wi-Fi）から実行しない**。同じ IP の利用者全員が
   60 秒間接続できなくなる。携帯のテザリングなど別の回線から、利用の少ない時間に行う
