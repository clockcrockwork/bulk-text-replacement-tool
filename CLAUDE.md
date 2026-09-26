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
- `src/hooks/` — 再利用する副作用（スクロールロック、トースト、画面幅、永続化）。
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
- **永続化**（`src/lib/storage.ts`）: キーは `bt-bulk-replace-v1`。読み込み時に各要素を検証・
  正規化しており、ここを緩めると壊れた保存データで起動時に落ち、リロードしても直らない
  （復旧不能）状態を作れる。保存する形を後方互換なく変えるならキーの版を上げる。
- **ZIP**（`src/lib/zip.ts`）: 無圧縮 store 形式の自前実装。ライブラリ追加より仕様に従う方を優先する。
  ファイル名は `sanitizeName` を通す（`..` を残すと展開先を抜け出せる）。
- **IME**: ルール表のキーボード移動は、変換確定中の Enter を無視する必要がある
  （`isComposing` と keyCode 229 の両方を見ている）。ここを削らない。
- **スマホ / Safari**: フォーム要素は狭幅・タッチ環境で **16px 以上**にする（iOS Safari が
  16px 未満で自動ズームする）。`user-scalable=no` は使わない。
- **選択状態**は色だけで表さない。トグルは `ToggleGroup`（`aria-pressed` 込み）を使い、
  独自に組むなら `aria-pressed` / `aria-current` を付ける。
- **外部通信**を増やさない。README で「入力とルールは外部へ送信しない」と約束しており、
  `index.html` の CSP が `connect-src 'none'` で fetch / XHR を塞ぎ、
  `e2e/privacy.spec.ts` が原稿・ルールに仕込んだ目印がリクエストに現れないことを検証する。
  宛先ホストだけを見るのでは足りない（同一オリジンへの送信を見逃す）。
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
  直接使わない。書き出しの BOM は `withBom`。
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

## CI

`.github/workflows/ci.yml` の2ジョブ（`Lint / Types / Unit tests / Build` と `E2E (Playwright)`）。
`push` は `main` のみ、他は `pull_request` で走る（同じコミットに同名チェックが2系統
報告されると required status checks が不安定になるため）。失敗時だけレポートを回収する。
