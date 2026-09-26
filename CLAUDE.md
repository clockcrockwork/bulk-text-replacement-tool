# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code 向けの指針です。

## プロジェクト概要

「一括置換ツール」— 複数のテキストを、グループごとの置換ルール表で一括変換する
ブラウザ完結の静的アプリ。Vite + React 19 + TypeScript。サーバーは無く、状態は
localStorage にだけ保存する。

元は Claude Design で作られた `.dc.html`（独自テンプレート + CDN 実行時ランタイム）で、
そのアーカイブが `design/` にある。**`design/` は参照用で、編集しても本体には反映されない。**

## コマンド

```bash
npm run dev            # 開発サーバー
npm run check          # lint + typecheck + test（変更後は必ずこれを通す）
npm run lint:fix       # Biome の自動修正
npm run test -- <path> # 単一テストファイルの実行
npm run build          # 型チェック + 本番ビルド
```

## アーキテクチャ

**ロジックとUIを分ける**のがこのリポジトリの基本方針。

- `src/lib/` — **純粋関数のみ**。DOM・React・グローバル状態に触らない。ここに置いたものは
  必ず `*.test.ts` を書く。唯一の例外が `browser.ts`（ダウンロード・クリップボード）で、
  副作用はここに閉じ込める。
- `src/state/workspace.ts` — アプリ状態は1つの `useReducer` に集約。**reducer は純粋**に保つ。
  新しい実体（ルール行・グループ・入力）が必要な action は、ID を含む完成済みのオブジェクトを
  payload で受け取る（`createEmptyRule()` などのファクトリは reducer の外）。
- `src/components/` — 表示に専念。データ取得も永続化もしない。ハンドラは `App.tsx` から渡す。
- `src/hooks/` — 再利用する副作用（スクロールロック、トースト、画面幅、永続化）。

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
- **lint の抑制**: `biome-ignore` は理由を必ず書く。a11y の指摘は、まず実装で直せないかを検討する
  （例: モーダルはネイティブ `<dialog>`、トグル群は `<fieldset>` + `<legend>`）。

## 触るときに気をつけること

- **置換の意味論**（`src/lib/replace.ts`）: 「同時」は連続する行をまとめて1パスで適用し、
  長い一致を優先、同着ならルール定義順。置換結果は同じパス内で再走査しない。「順次」は
  単独パスとして、それまでの結果に適用する。この挙動を変えると利用者の出力が変わるので、
  変更時は `replace.test.ts` のケースを先に見直すこと。
- **永続化**（`src/lib/storage.ts`）: キーは `bt-bulk-replace-v1`。保存する形（`PersistedWorkspace`）に
  後方互換の無い変更を入れるなら、キーの版を上げて古いデータを読み飛ばす。
- **ZIP**（`src/lib/zip.ts`）: 無圧縮 store 形式の自前実装。ライブラリ追加より仕様に従う方を優先する。
  オフセットの意味はコメント参照。
- **IME**: ルール表のキーボード移動は、変換確定中の Enter を無視する必要がある
  （`isComposing` と keyCode 229 の両方を見ている）。ここを削らない。

## 動作確認

ロジックの変更はユニットテストで確認する。UI の変更は `npm run dev` で実際に触って確認する
（UI の自動テストは入れていない）。
