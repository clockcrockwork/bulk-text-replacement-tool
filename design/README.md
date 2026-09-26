# design/ — 元になった Claude Design のエクスポート

このディレクトリは **参照用のアーカイブ** です。ビルドにも lint にも含まれません
（`biome.json` の `files.includes` で除外しています）。

| ファイル | 内容 |
| --- | --- |
| `bulk-replace.dc.html` | Claude Design から書き出した元データ（`<x-dc>` テンプレート + `DCLogic` を継承したロジック）。現行の `src/` はこれを Vite + React + TypeScript に移植したもの。 |
| `modernist/readme.md` | 使用したデザインシステム「Modernist」のガイド。色・余白・罫線・状態の考え方はここに書かれている。 |
| `modernist/styles.css` | 同デザインシステムのスタイルシート。`src/styles/tokens.css` の値はここから取っている。 |

## 元データとの関係

`bulk-replace.dc.html` は Claude Design 専用フォーマットで、実行には
`support.js`（React 18 と Babel を CDN から読み込むランタイム）が必要でした。
移植にあたって次を変えています。

- テンプレート（`{{ }}` / `sc-if` / `sc-for`）→ JSX
- 単一の `Component extends DCLogic` → `useReducer` + 機能ごとのコンポーネント
- インライン `style` 属性 → `src/styles/` のクラス（トークンは CSS カスタムプロパティ）
- `data-bt` 属性によるテーマ切替 → `<html data-theme>`
- 自前モーダル → ネイティブ `<dialog>`

デザインを変更したい場合、**このディレクトリを編集しても本体には反映されません**。
`src/styles/tokens.css` を直してください。
