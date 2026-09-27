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
- **Expire user authorization tokens**: オン（既定のまま）
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

- `VITE_` で始まる2つは公開値で、ビルドに埋め込まれる。**設定したら再デプロイが必要**。
  未設定のビルドでは「GitHubから追加」ボタンが無効になる
- 許可リストはカンマ区切りで複数書ける。独自ドメインを足すときは両方に足し、
  GitHub App の Callback URL にも同じ URL を追加する
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
| If | **Request Path** — **Equals** — `/api/github/token` |
| Then | **Rate Limit** |
| Algorithm | Fixed Window |
| Window | 60 秒 |
| Limit | 10 リクエスト |
| Key | IP Address |
| Action（超過時） | Too Many Requests（429） |

- メソッドでは絞らない（POST 以外も Function を起動する。405 を返すだけでも実行回数に数えられる）
- 値の根拠: 正規の利用者が交換するのは「GitHubに接続」1回につき1回だけ。
  接続のやり直しを何度か続けても 1 分に 10 回には届かない
- 超過した利用者の画面には「トークンの交換に失敗: 429」と出るだけで、作業データは失われない
  （もう一度接続すれば済む）
- 作成後に **Review Changes → Publish** で反映する（保存しただけでは効かない）
- プランによって使えるルール数・窓の長さ・キーの種類が異なる。上の値が選べないときは、
  「IP ごとに 1 分あたり数回〜十数回」に最も近い設定にする
- Function のコードは変えない。ルールはリクエストが Function に届く前に効く

## 4. 配信時のヘッダ

`vercel.json` の `headers` が、`/api/` 以外のすべての応答に次を付ける。

| ヘッダ | 値 | 理由 |
| --- | --- | --- |
| `Content-Security-Policy` | `frame-ancestors 'none'` | 他サイトの iframe に埋め込ませない（クリックジャッキング）。meta の CSP では `frame-ancestors` を指定できないためヘッダで送る |
| `X-Frame-Options` | `DENY` | `frame-ancestors` を解さない古いブラウザ向け |
| `X-Content-Type-Options` | `nosniff` | 配信物を宣言と違う型として解釈させない |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 認可から戻った直後（`/?code=…&state=…`）の URL を、`history.replaceState` で消す前に読み込まれる Google Fonts などへ送らない。ブラウザの既定値と同じだが、既定に頼らず明示する |

- 本体の CSP（`connect-src` など）は `index.html` の meta にあり、ヘッダの CSP はそれに
  `frame-ancestors` を足すだけ。両方があると、ブラウザは両方を満たすものだけを許す
- `Referrer-Policy` を `no-referrer` にしないのは、トークン交換の Function が Origin を
  照合しているため。Referrer-Policy は Origin ヘッダにも効き、`no-referrer` の下では
  cors 以外のモードの POST が `Origin: null` になる（Fetch 仕様）。いまの交換は
  `fetch`（cors モード）なので送られるが、実装差や呼び出し方の変更で Origin が消えると
  交換が 403 で止まる。`strict-origin-when-cross-origin` なら同一オリジンへは常に送られる
  （E2E が交換に Origin が付いていることを確かめている）
- ヘッダを無視する配信先のために、`index.html` にも `<meta name="referrer">` で同じ方針を書いている
- `/api/` の応答は Function が自前でヘッダを付ける（`Referrer-Policy: no-referrer` など）ので対象外にしている
- `vite preview`（E2E の配信元）も `vercel.json` を読んで同じヘッダを返す（`vite.config.ts`）。
  ヘッダを変えたら `e2e/dist.spec.ts` を合わせる

## 5. 確認（実 GitHub での smoke test）

本番にデプロイしたあと:

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
8. `curl -sI https://bulk-text-replacement-tool.vercel.app/` で §4 のヘッダが返ること
9. Firewall のルールが Publish 済みで、`/api/github/token` を短時間に 11 回以上叩くと
   429 が返ること（例: `for i in $(seq 12); do curl -s -o /dev/null -w '%{http_code}\n' -X POST https://bulk-text-replacement-tool.vercel.app/api/github/token; done`。
   Origin を付けていないので、制限に掛かるまでは 403 が返る）
