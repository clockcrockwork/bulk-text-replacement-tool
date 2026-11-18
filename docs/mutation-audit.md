# Mutation Testing — 限定的な品質監査

更新: 2026-11-18 / 初回PoC

## 目的と境界

- 置換エンジン `src/lib/replace.ts` の既存Vitestテストが、ロジックの故障を検出できるか確かめる。
- `@mizchi/mutator` を限定実行し、Survived / NoCoverage / 等価変異と実行負荷を検証する。
- Mutation Scoreを上げるためだけにテストを増やさない。E2Eや外部IOの保証を置き換えない。
- 本番コード、通常の `npm run check`、必須CIの権限・条件は変更しない。

## 実行方式（PoC）

`.github/workflows/ci.yml` の `Mutation audit (optional)` ジョブは独立したNode 24で実行する。

1. `npm ci` で既存依存を復元し、`replace.test.ts` を先に実行する。
2. `@mizchi/mutator@0.2.0` を **このCIジョブだけ**にインストールする。通常のNode 22と `package-lock.json` は変えない。
3. `src/lib/replace.ts` のみ対象。1行あたり最大1変異、150秒、並列数2で測定する。
4. Actionsログ、`.mutator/report/`、`.mutator/snapshot.json` を7日間保存する。

初回PoCでは実験ブランチのPRから自動起動し、検証後は **workflow_dispatch による手動実行だけ**にする。

Node 24環境で同じ監査を実行する手順。通常のNode 22では実行しない。

```sh
npm ci
npm run test -- src/lib/replace.test.ts
npm install --no-save --package-lock=false --ignore-scripts @mizchi/mutator@0.2.0
npm exec --no -- mutator --runner vitest --include 'src/lib/replace.ts' --time-budget 150 --mutants-per-line 1 -j 2 --reporter text --reporter json
```

## 結果の扱い

- **Killed**: 意図的に壊した実装をテストが検出した。
- **Survived**: 未検出の可能性。境界値・アサーションを調べ、等価ミュータントなら根拠を記す。
- **NoCoverage / Not reached**: 該当コードに到達するテストがない。必要な挙動か確認する。
- **Timeout / Pending / Error**: 未測定または実行環境の問題。Killed/Survivedに混ぜない。
- 条件が違うMutation Scoreや異なる変異集合を単純比較しない。Survivedゼロを採用条件にしない。

## 導入判断（未検証）

- [ ] Node 24+・Vitest 5の組み合わせで実行できる。
- [ ] レポートが取得でき、少なくとも1件のSurvivedを具体的に評価できる（無い場合はその事実を記録）。
- [ ] 既存ユニットテストとの差分と監査時間・消費リソースを記録する。
- [ ] 実測後、常時必須化せず、任意実行として継続するかを判断する。
- [ ] 結果が役立つ場合のみ、既存の `agent-commons/core/review-angles/angle-test-quality.md` の検証証拠に接続する。新規reviewerや全repo展開はしない。

参考: https://zenn.dev/mizchi/articles/mutation-test-quality / https://github.com/mizchi/mutator
