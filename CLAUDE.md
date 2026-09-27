# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code 向けの指針です。

## プロジェクト概要

「一括置換ツール」— 複数のテキストを、グループごとの置換ルール表で一括変換する
ブラウザ完結の静的アプリ。Vite + React 19 + TypeScript。サーバーは無く、状態は
localStorage にだけ保存する。**スマートフォンと Safari も保証対象**。

元は Claude Design で作られた `.dc.html`（独自テンプレート + CDN 実行時ランタイム）で、
そのアーカイブが `design/` にある。**`design/` は参照用で、編集しても本体には反映されない。**

## コマンド

```bash
npm run dev            # 開発サーバー
npm run check          # lint + typecheck + coverage + build（変更後は必ずこれを通す）
npm run lint:fix       # Biome の自動修正
npm run test -- <path> # 単一テストファイルの実行
npm run coverage       # カバレッジ（閾値つき。ロジック層のみ計測）
npm run test:e2e       # Playwright（初回は npx playwright install chromium webkit）
npm run lint:text      # 不可視文字・双方向制御文字・CRLF の全ファイル走査（lint に含まれる）
```

E2E をブラウザ1つに絞るときは `npx playwright test --project=chromium`。

## アーキテクチャ

**ロジックとUIを分ける**のがこのリポジトリの基本方針。

- `src/lib/` — **純粋関数のみ**。DOM・React・グローバル状態に触らない。ここに置いたものは
  必ず `*.test.ts` を書く。唯一の例外が `browser.ts`（ダウンロード・クリップボード）で、
  副作用はここに閉じ込める。
- `src/state/workspace.ts` — アプリ状態は1つの `useReducer` に集約。**reducer は純粋**に保つ。
  新しい実体（ルール行・グループ・入力）が必要な action は、ID を含む完成済みのオブジェクトを
  payload で受け取る（`createEmptyRule()` などのファクトリは reducer の外）。
- `src/components/` — 表示に専念。データ取得も永続化もしない。ハンドラは `App.tsx` から渡す。
  `ErrorBoundary` だけは例外で、描画が落ちたときの復旧画面を自前で持つ。
- `src/hooks/` — 再利用する副作用（スクロールロック、トースト、画面幅、永続化、GitHub 取り込み）。
- `src/github/` — GitHub REST API への fetch だけを置く（`client.ts`）。応答の解釈は
  `src/lib/githubApi.ts` の純粋関数に任せる。副作用なのでカバレッジの計測対象外。
  ページ送りと送るヘッダは `client.test.ts`（fetch を差し替え）、画面の流れは E2E
  （`e2e/githubMock.ts` で GitHub を置き換える）で見る。
- `src/state/githubImport.ts` — 「GitHubから追加」ダイアログの純粋 reducer。ワークスペースとは
  別に持ち、永続化しない。
- `api/` — Vercel Function。**OAuth のトークン交換だけ**（`api/github/token.js`）。
  TypeScript 7 は従来の JS API を持たず、Vercel が `.ts` を変換できない恐れがあるので、
  **JSDoc 付きの JavaScript** で書き `checkJs` で型検査する。本体は `api/_lib/`
  （`_` 始まりは Function にならない）に置き、Vitest で直接テストする。
- `e2e/` — Playwright。本番ビルドを `npm run preview` で配信して検証する。

データの流れ: `App.tsx` が state を持ち、`src/lib/` の関数を呼んで結果を reducer に渡し、
コンポーネントへ props で配る。

## 規約

- **スタイル**: インラインの `style` 属性は使わない。`src/styles/app.css` にクラスを足す。
  色・フォント・余白は必ず `src/styles/tokens.css` のカスタムプロパティから取る
  （生の 16 進数や font-family を書かない）。クラス名は `block__element--modifier`、
  状態は `is-active` のような `is-*`。
- **テーマ**: `<html data-theme="dark">` で切り替える。ダーク用の値は tokens.css 側で上書きする。
- **コメント**: 日本語。「何をしているか」ではなく「なぜそうなっているか」を書く。
- **型**: `any` 禁止。ドメイン型は `src/types.ts` に集約。`noUncheckedIndexedAccess` が有効なので
  配列アクセスは `undefined` を考慮する（`!` による非 null 表明は lint エラー）。
  **外から来る値（localStorage・取り込んだ表）を `as` で通さない。** 検証して正規化する。
- **lint の抑制**: `biome-ignore` は理由を必ず書く。a11y の指摘は、まず実装で直せないかを検討する
  （例: モーダルはネイティブ `<dialog>`、トグル群は `ToggleGroup`）。
- **不可視文字**: `\ufeff` のような文字をソースに直接書かない（見えないまま壊れる）。
  BOM は `src/lib/text.ts` の `BOM` / `stripBom` / `withBom` を使う。
  Biome は Markdown を見ず、文字列リテラルの中も見ないので、`scripts/checkText.mjs` が
  git 管理下の全ファイルを走査する（`npm run lint` に含まれる）。

## 触るときに気をつけること

- **置換の意味論**（`src/lib/replace.ts`）: テキストは1本の文字列として持ち、ハイライトは
  範囲（オフセット）で覚える。各パスは**その時点のテキスト全体**を走査する。
  「同時」は連続する行を1パスにまとめ、長い一致を優先、同着ならルール定義順。同じパス内で
  置換結果を再走査しないので連鎖しない。「順次」は単独パスなので、前のパスの結果と周囲に
  またがる一致も拾う。この挙動を変えると利用者の出力が変わるので、変更時は
  `replace.test.ts` のケースを先に見直すこと。
- **置換先が空の行**は「削除」ではなく「そのグループでは適用しない」。ただし
  **正規表現モードでは、展開後に空文字になる置換先を書けば削除できる**
  （`applyBatch` の `if (replaced)` が偽になり、一致範囲が出力に積まれない）。
  「リテラルでは消せない／正規表現なら消せる」が現在の仕様。
- **作業データの書き出し／読み込み**（`src/lib/backup.ts`）: 書き出しは版 2（入力の出自
  `source` を含む）。版 1 も読める。保存先が localStorage だけなので、
  ブラウザ側の都合（Safari の ITP、サイトデータ削除、容量超過）で消える。復旧経路を
  画面の中に持つ。取り込みは**検証 → 内容の確認 → 反映**の順を崩さない。選んだ瞬間に
  反映すると、壊れたファイルを選んだだけで今のデータが消え、復旧手段そのものが
  新しいデータ消失の経路になる。検証は `storage.ts` の `normalizeWorkspace` を共有する
  （取り込み側で緩めると、保存データ経由では防いだ壊れ方をファイル経由で作れる）。
- **保存の失敗**は握り潰さない。`saveWorkspace` は成否を返し、失敗は消えるトーストでは
  なく出したままの警告にする（見落としたときに失う設計にしない）。
- **永続化**（`src/lib/storage.ts`）: キーは `bt-bulk-replace-v1`。読み込み時に各要素を検証・
  正規化しており、ここを緩めると壊れた保存データで起動時に落ち、リロードしても直らない
  （復旧不能）状態を作れる。入力の出自（`source`）は `normalizeInputSource` で検証し、
  壊れていれば**入力は残して出自だけ落とす**。保存する形を後方互換なく変えるならキーの版を上げる。
- **複数行のルール**: 置換元・置換先は実改行を保持できる。ただし**ルール表のセルは
  1行入力のまま**にする（行の高さを可変にすると一覧性が落ちる）。改行を含む値は
  `RuleCell` が要約表示のボタンに切り替え、実体の編集は `CellEditor` で行う。
  改行入りの値を `<input>` に載せるとブラウザが改行を落とし、一度触っただけで壊れる。
  置換先の文字列 `\n` を実改行へ展開する独自仕様は入れない（文字としての `\n` と
  実改行を混同させない）。
- **サンプル状態**（`isSample`）: 初回のサンプルに**まだ誰も触っていない**あいだだけ true。
  中身を変える action（`TOUCHES_CONTENT`）を通ると false になる。自動で片付けてよいのは
  true のときだけで、1文字でも直したらユーザーの作業なので勝手に消さない。
  片付けは取り消せるようトーストに「元に戻す」を添える。**トーストは1つしか出ないので、
  片付けと本来の通知を別々に flash しない**（後から出た方が前を消す）。
- **表の書き出し**（`src/lib/table.ts`）: CSV / TSV とも、区切り・改行・引用符を含むセルを
  クォートする。TSV だけ空白へ潰す実装に戻さない（自分で書き出したものを読み戻すと
  値が変わる状態になる）。列数が見出しと食い違う表は `findRaggedRows` で検出し、
  確定する前に見せる。
- **出力ファイル名**（`src/lib/fileName.ts`）: タイトルは名前であってパスではないので
  `/` は潰す。保証する拡張子は `ACCEPTED_EXTENSIONS`（取り込みと共有）で、それ以外は
  消さずに `.txt` を足す（`title.html` → `title.html.txt`）。**変えるのは名前だけで、
  本文・ルール・変換結果の文字列には触らない。**
- **グループ名**は出力先の識別子。追加・取り込み・作業データの読み込みでは
  `uniqueName` で一意にし、変換時はタブ名も ZIP のディレクトリ名と同じ値を使う
  （見た目が同名なのに中では別物、を作らない）。
- **ZIP**（`src/lib/zip.ts`）: 無圧縮 store 形式の自前実装。ライブラリ追加より仕様に従う方を優先する。
  ファイル名は `sanitizeName` を通す（`..` を残すと展開先を抜け出せる）。
- **IME**: ルール表のキーボード移動は、変換確定中の Enter を無視する必要がある
  （`isComposing` と keyCode 229 の両方を見ている）。ここを削らない。
- **スマホ / Safari**: フォーム要素は狭幅・タッチ環境で **16px 以上**にする（iOS Safari が
  16px 未満で自動ズームする）。`user-scalable=no` は使わない。
- **選択状態**は色だけで表さない。トグルは `ToggleGroup`（`aria-pressed` 込み）を使い、
  独自に組むなら `aria-pressed` / `aria-current` を付ける。
- **外部通信**を増やさない。README で「入力とルールは外部へ送信しない」と約束しており、
  `index.html` の CSP が `connect-src 'self' https://api.github.com` で、それ以外への
  fetch / XHR / sendBeacon / WebSocket を塞ぐ（テストだけでなくブラウザ側でも保証する）。
  `'self'` はトークン交換のためだけにある。`style-src` の `'unsafe-inline'` は
  Google Fonts のスタイルシートのために要る。
  `e2e/privacy.spec.ts` が原稿・ルールに仕込んだ目印がリクエストに現れないことを検証する。
  宛先ホストだけを見るのでは足りない（同一オリジンへの送信を見逃す）。GitHub を使わない
  流れでは GitHub にも `/api/` にも一切つながないこと、GitHub の流れでもバックエンドへは
  トークン交換の3項目しか送らないことも見ている。**通信が可能になったからといって
  このテストを消さない。**
- **GitHub 取り込み**（仕様は `docs/github-import-v2.md`、設定は `docs/github-app-setup.md`）:
  - **読み取り専用**。write 系の権限・API を足さない（Git への書き出しは別仕様）。
  - アクセストークンは `useGitHubImport` の ref（メモリ）にだけ持つ。localStorage /
    sessionStorage / ワークスペース / 作業データに書かない。sessionStorage に置いてよいのは
    リダイレクトを跨ぐ state と PKCE verifier だけで、戻った時点で消す。
  - 認可は毎回アプリが state と PKCE（S256）を付けて始める。GitHub の「インストール時に
    OAuth を要求」には頼らない。callback はオリジン直下（`base: './'` なので下位パス不可）。
  - バックエンドは原稿・ルール・リポジトリの内容を受け取らない。本文はブラウザから
    api.github.com へ直接取りに行く。
  - api.github.com へのリクエストは **GitHub の CORS 方針**に従う。送る要求ヘッダは
    `githubRequestHeaders`（`Accept` と `Authorization`）だけで、`X-GitHub-Api-Version` など
    許可リスト（`GITHUB_CORS_ALLOWED_REQUEST_HEADERS`）に無いものは付けない（preflight で止まる）。
    読める応答ヘッダも限られる（`retry-after` や `x-github-sso` は読めない）ので、判定は
    `x-ratelimit-*` と本文の `message` で行う。モックの E2E は CORS を再現しないので、
    ヘッダや fetch オプションを変えたら `e2e/githubCors.spec.ts`（実ブラウザ × 方針を再現した
    サーバー）で確かめる。
  - ブランチを選んだ時点でコミットを固定し、tree も blob もそこから読む。遅れて返った
    古い応答は reducer が捨てる。新しいコミットへは「最新に更新」でだけ移る。
  - tree の一覧は項目にパスを焼き込んでいる。中身が同じディレクトリは別の場所でも同じ
    tree SHA になるので、一覧のキャッシュや照合は **SHA とパスの組**で行う（SHA だけだと
    別のフォルダのパスで取り込み、出自と同一性が別ファイルに結び付く）。
  - 一覧のページ送りは上限（`MAX_PAGES`）で止めるが、続きが残っていれば途中までの一覧を
    返さずに失敗させる（「無い」と「上限で見えていない」を取り違えさせない）。
  - 取り込み元の同一性は `repositoryId + ref + path`（`sourceIdentity`）。タイトルでは判定しない。
    同じ取り込み元が複数あるときに更新先を推測しない。
  - 対応拡張子は `ACCEPTED_EXTENSIONS`、文字コードは `decodeText` をローカルと共有する。
- **配信物とユーザーのテキストは別のレイヤー**として扱う。アプリの HTML / CSS / JS は
  不要物を落として軽くしてよい（`index.html` に開発者向けコメントを残さない、
  sourcemap を配らない、JS/CSS の minify は Vite 既定に任せる）。一方、
  **原稿・ルール・変換結果・書き出すファイルには minify も正規化もしない。**
  改行・行頭の空白・連続空白・タブ・コードポイントの差は、すべて意味を持ち得る。
  `index.html` に手を入れたら `e2e/dist.spec.ts` を確認する。
- **破壊操作の確認**は `useConfirm` + `ConfirmDialog`（`App.tsx` の `confirmThen`）。
  `window.confirm` は使わない（文言を整えられず、失われる内容の内訳も出せず、
  iOS Safari では抑制され得る）。既定のフォーカスはキャンセル側に置く。
- **変換の前後に出す判定**は `src/lib/diagnostics.ts` に集約する。
  正規表現エラーがあれば変換を止め（黙って「そのルールだけ効いていない完成物」を
  作らせない）、0件のルールは止めずに知らせる。表示側と実行側で条件を別々に
  書かない（エラー表示は出ているのに変換は通る、が起きる）。
- **未反映（stale）の結果**はプレビューとしては残すが、コピー・個別保存・ZIP は
  無効化する。古いルールの結果を取り違えて持ち出す事故の方が重い。
- **イベントハンドラの例外**は `App.tsx` の `guard` で受ける。React のエラー境界は
  描画中の例外しか拾わないので、onClick から同期で呼ぶ処理は自前で受け皿が要る。
- **文字コード**: 取り込みは `decodeText`（UTF-8 → 失敗したら Shift_JIS）。`File.text()` を
  直接使わない。書き出しの BOM は `withBom`。出力は常に UTF-8 で、入力の文字コードは
  持ち回らない。Shift_JIS は**推測**なので、そう読んだことは画面で知らせる
  （`decodeText` が `encoding` を返す）。黙って取り込むと、文字化けした原稿が
  そのまま置換対象になる。
- **正規表現は常に `u` 付き**（`src/lib/regex.ts`）。`u` 無しへ退避させない。
  退避すると同じ `.` がルールによって1文字にも2文字にもなり、仕様が1つに定まらない。
  `u` で不正な書き方はエラーとして見せる。
- **文字数は表示しない**（`src/lib/format.ts` のコメント参照）。入力に上限が無く、
  数え方（コードポイント／書記素）で値が変わるだけで判断材料にならないため外した。
  足し直すなら、まず「何のために数えるか」を決めること。

## テスト

- **ロジック**（`src/lib/`, `src/state/`）は Vitest。置換の意味論・表の入出力・ZIP のバイト列・
  保存データの正規化・reducer の遷移など、壊れると出力が変わるところを押さえる。
  カバレッジ閾値（statements 96 / branches 87 / functions 98 / lines 98）があるので、ロジックを足すならテストも足す。
- **画面**は Playwright（`e2e/`）。コンポーネント単体のテストは置かない。UI を変えたら
  該当する E2E を直す。狭い画面はレイアウトの前提が違うので `e2e/mobile/` に分ける。
- **状態は `seedWorkspace` / `seedBasic` で仕込む**。アプリの初回サンプルを暗黙の fixture に
  すると、サンプル文言を変えただけで広範囲が壊れる。**サンプルに触れてよいのは
  `e2e/sample.spec.ts` だけ**。他の spec でサンプル本文（`chapter1.md` や登場人物名）を
  参照していたら、それは移し忘れ。
  仕込みは**最初の読み込み1回だけ**効く（リロードで書き戻すと、永続化のテストが
  成立しないため）。1つのテストで二重に seed しても後勝ちしない。
- **要素の指定**: 操作（クリック・入力）は `getByRole` / ラベルで行う。レイアウトや構造の
  検証（カード表示か表か、断片の数）はクラスセレクタでよい。同じラベルのボタンが複数ある
  場合は `.toolbar` などでスコープを絞る。
- 新しい振る舞いを足したら、ロジックならユニットテスト、画面の流れなら E2E を必ず1本足す。

## リリース系統

このリポジトリには、意図的に寿命の違う2系統がある。

- **`main`** — 継続開発する本流。Vercel production はここから配信する。GitHub 連携を含む
  V1 後の機能追加・改善・通常の依存更新はすべてここで行う。
- **`release/lolipop-v1`** — コンテスト提出用の V1 保守系統。分岐点は PR #6 の
  squash merge `221c233`、V1 baseline はタグ `v1.0.0`
  （V1 freeze prep PR #10）。ロリポップ配信を維持するための最小修正以外は入れない。

### release/lolipop-v1 を触る条件

入れてよいのは、セキュリティ／プライバシー、データ消失・破損、起動不能、
コンテスト要件、ロリポップ固有のホスティング互換性など、**提出版を安全に公開し続けるために
必要な修正**だけ。

次は release 側へ入れない。

- GitHub 連携や新機能
- UI / UX の通常改善やデザイン変更
- `main` に入った機能を揃えるためだけの同期
- 必須理由のない dependency update / refactor / cleanup（Dependabot も release は追従させない）

**`main` を release ブランチへ丸ごと merge / rebase しない。**
両方に必要なバグ修正は原則 `main` で先に直し、release に必要な最小 commit だけ
cherry-pick 相当の小さな PR で backport する。ロリポップ固有の問題だけは release 起点で
直してよいが、本流にも必要かを別途判断する。

release 側の変更でも CI の2ジョブを通す。デプロイ元は必ず branch / commit を確認し、
Vercel は `main`、ロリポップは `release/lolipop-v1` の build artifact から出す。
詳細は `RELEASE_POLICY.md`。

## CI

`.github/workflows/ci.yml` の2ジョブ（`Lint / Types / Unit tests / Build` と `E2E (Playwright)`）。
`push` は `main` のみ、他は `pull_request` で走る（同じコミットに同名チェックが2系統
報告されると required status checks が不安定になるため）。失敗時だけレポートを回収する。
