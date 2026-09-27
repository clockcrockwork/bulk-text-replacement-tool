# Release policy

## 目的

V1 以降、同じコードを2つの配信先で同じ速度で育てない。
継続開発する Web アプリと、コンテスト提出のために V1 を固定して維持する静的配信物を
明確に分離する。

## 系統

| 系統 | Branch | 配信先 | 状態 |
| --- | --- | --- | --- |
| Active product | `main` | Vercel production | 継続開発 |
| Contest maintenance | `release/lolipop-v1` | ロリポップ | V1 固定・最低限保守 |

V1 baseline は PR #6 を squash merge した `221c2331a21a6f39e3d0c93642a73fe8b042dfa8`。

## main

`main` が唯一の product source of truth。
GitHub 連携、V1 後の UX 改善、通常の refactor、dependency update、将来の V1.1 / V2 は
すべてここから進める。Vercel production も `main` を追う。

## release/lolipop-v1

コンテスト提出版のための長期保守ブランチ。
V1 の挙動を不用意に変えず、公開を維持するために必要な変更だけを許可する。

### 変更を許可するもの

- security / privacy fix
- データ消失・破損・誤った出力につながる重大 bug fix
- アプリが起動・build・配信できない問題
- コンテストの提出条件・規約に合わせるための必要変更
- ロリポップ環境固有の互換性・配信設定

### 原則として入れないもの

- GitHub 連携を含む新機能
- 通常の UI / UX 改善
- 本流に追従するためだけの refactor
- cosmetic cleanup
- 必要性が無い dependency update
- `main` の feature merge

## Backport rule

`main` と release の両方に必要な問題は、可能ならまず `main` で修正する。
その後、release に必要な変更だけを小さい commit / PR として選択的に backport する。

**`main` を `release/lolipop-v1` へ定期 merge / rebase しない。**
本流が GitHub 連携などで構造を変えても、コンテスト版へ不要な変更を持ち込まないため。

ロリポップでしか発生しない問題は release 側で直接修正してよい。
その修正を `main` にも持ち込むかは、現在の本流でも同じ問題が存在するかで判断する。

## Validation

どちらの系統でも変更時は少なくとも以下を通す。

- `npm run check`
- GitHub CI: `Lint / Types / Unit tests / Build`
- GitHub CI: `E2E (Playwright)`

release 側ではさらに、ロリポップへ出す build が
`release/lolipop-v1` の意図した commit から生成されたことを確認する。

## Deployment ownership

- **Vercel**: `main` の自動 production deployment が正。
- **ロリポップ**: `release/lolipop-v1` の `dist/` を明示的に build して配信する。
- Vercel の Preview deployment は release の正本ではない。
- ロリポップ版を Vercel の最新状態へ自動同期しない。

## Branch protection

`release/lolipop-v1` は長期間触らない前提なので、通常開発ブランチよりも
「誤って壊さない」ことを優先する。

GitHub ruleset では少なくとも以下を要求する。

- branch deletion を禁止
- non-fast-forward / force push を禁止
- Pull Request 経由を必須
- review thread の解決を必須
- `Lint / Types / Unit tests / Build` を必須
- `E2E (Playwright)` を必須
- bypass actor は原則置かない

`main protection` は default branch のみを対象としているため、この release branch は
別途対象に追加する。release branch を長期間放置することは、保護を弱める理由にはしない。

V1 の immutable anchor としてタグを置く場合は、`v1.0.0` を
`221c2331a21a6f39e3d0c93642a73fe8b042dfa8` に向け、一度作ったタグを動かさない。

## Maintenance posture

コンテスト提出後のロリポップ版は **maintenance-only**。
問題が無い限り変更しないこと自体を正常状態とする。
「古いから更新する」「main と差があるから揃える」は変更理由にならない。
