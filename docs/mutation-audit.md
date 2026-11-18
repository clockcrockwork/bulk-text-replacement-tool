# Mutation Testing — 限定的な品質監査

更新: 2026-11-18 / PoC実測済み・通常CIでは無効

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

初回PoCはPR #47の実験ブランチで実測済み。通常のPR/pushでは監査ジョブをスキップする。mainへマージした後はGitHub Actionsの「CI」→「Run workflow」で手動監査できる。手動実行時は通常のlint・build・E2Eジョブをスキップし、手動監査が進行中の通常CIをキャンセルしないようにconcurrencyを分離した。

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

## 初回実測の証拠（2026-11-18）

- ベースライン: 既存の`replace.test.ts` 53件PASS、39 Killed / 18 Survived。Mutation Score **64.6%**、Mutator本体 **12.2秒**。
- 検出できない故障候補を精査し、**合計ヒット数**と**複数パスでのハイライト範囲保持**に絞った3テストを追加。
- 補強後: `replace.test.ts` 56件PASS、44 Killed / 13 Survived。Mutation Score **72.3%**、Mutator本体 **11.1秒**。同じ変異集合から**5件を新たに検出できた**。
- 生成変異は341件で、サンプリング制限により216件がPending。さらに60件はCompileError、5件はNoCoverage、3件はTimeout。**64.6% / 72.3%は全ソース・全変異の評価値ではない**。
- 標準のLint・型検査・ユニットテスト・Buildジョブは補強後のPRでPASS。E2EはPRの最終headで別途確認する。
- Node 24の監査ジョブ内で一時インストールを行うため、`npm ci` 時のnpm audit警告7 highが一時インストール後は9 highになった。根因・影響範囲は未調査で、`package-lock.json` や配信アプリには追加していない。正式な常時導入を考える際には依存を再評価する。

証拠:
- 初回: https://github.com/clockcrockwork/bulk-text-replacement-tool/actions/runs/44213971060 （Mutationジョブ成功後、後続コミットで全体runはキャンセル）
- 補強後: https://github.com/clockcrockwork/bulk-text-replacement-tool/actions/runs/44214326828
- 実装・レビュー対象: https://github.com/clockcrockwork/bulk-text-replacement-tool/pull/47

## 導入判断（現段階）


- [x] Node 24+・Vitest 5の組み合わせで実行できる。
- [x] レポートを取得し、Survivedを現実のテスト追加に結び付けて再実測した。
- [x] 既存テストとの差分と監査本体時間を記録した。
- [x] **手動・任意の品質監査として限定採用**。スコア閾値・必須PRチェック・全体CI化はしない。
- [ ] 残る13件のSurvived / 5件NoCoverage / 3件Timeoutの有効性・等価性を必要に応じて判定する。
- [ ] npm auditの増加分の原因とCLI更新経路を確認する。
- [ ] `agent-commons/core/review-angles/angle-test-quality.md` の検証証拠へ接続する。新規reviewerや全repo展開はしない。

参考: https://zenn.dev/mizchi/articles/mutation-test-quality / https://github.com/mizchi/mutator
