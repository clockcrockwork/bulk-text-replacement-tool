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

## 3. 確認（実 GitHub での smoke test）

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
