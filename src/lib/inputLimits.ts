/**
 * 取り込む入力の大きさの上限（resource policy, issue #19 / docs/resource-policy.md）。
 *
 * ローカルのファイルと GitHub の取り込みで同じ値を使う。経路ごとに値が違うと、
 * 同じファイルが入れ方によって取り込めたり取り込めなかったりする。
 *
 * どれも decode する前のバイト数で判定する。文字数で数えるには全文を文字列にする
 * 必要があり、判定のためだけに大きな入力のコピーを作ることになる（実測では、
 * 100MB 級の入力はその時点でタブが長く止まるかクラッシュした）。
 */

const MiB = 1024 * 1024;

/**
 * 1ファイルの上限。これを超えたら decode もプレビューもせずに断る。
 *
 * 続行の確認で突破できる上限にはしない。確認のあとで取り込むと、その時点でタブが
 * 応答しなくなる・落ちるので、取り消す手段が残らない。
 */
export const MAX_INPUT_BYTES = 5 * MiB;

/**
 * 1回の取り込み（複数選択・GitHub の一括取り込み）の合計の上限。
 *
 * 1ファイルの上限だけだと、上限以下のファイルを大量に選べば同じ量を一度に読めてしまう。
 */
export const MAX_IMPORT_TOTAL_BYTES = 5 * MiB;

/**
 * 反映後のワークスペースを保存した長さ（UTF-16 のコード単位）がこれを超えそうなら、
 * 取り込む前に確かめる。
 *
 * 保証値ではなく事前の注意。localStorage の容量はブラウザごとに違い（Chromium の実測で
 * 約 524 万）、最終的に保存できたかどうかは `saveWorkspace` の成否で決まる。
 */
export const STORAGE_CONFIRM_CODE_UNITS = 4 * MiB;

/** 画面に出す上限の表記（「5MB」）。 */
export function formatLimit(bytes: number): string {
  return `${bytes / MiB}MB`;
}

/** 1回の取り込みの合計が上限を超えたときの文言。ローカルと GitHub で共通にする。 */
export function describeImportTotalTooLarge(): string {
  return `選んだファイルの合計が ${formatLimit(MAX_IMPORT_TOTAL_BYTES)} を超えるため、取り込めません。一度に選ぶファイルを減らしてください。`;
}
