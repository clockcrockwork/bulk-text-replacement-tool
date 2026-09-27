/**
 * 画面やファイル名に出す数値・日時の書式をここに集約する。
 *
 * 数量は単位の前に空白を入れない。トーストや件数バッジが元から詰めた書き方
 * （「2ファイルをZIPで保存しました」「2箇所を置換」）なので、画面の中で揃うのはこちら側。
 *
 * 文字数は出さない。上限を設けていないので数えても判断材料にならず、
 * 「何をどう数えるか」（サロゲートペア・IVS・書記素）の説明だけが増えるため。
 * 長い原稿でも最後まで置換されることの方が大事で、そちらはテストで担保している。
 */

/** 2桁ゼロ埋め。時刻と連番で共有する。 */
function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

/** 「56行」。空なら「0行」。 */
export function formatTextMeta(text: string): string {
  const lines = text ? text.split('\n').length : 0;
  return `${lines.toLocaleString()}行`;
}

/** 入力タブの見出しに出す合計。 */
export function formatInputSummary(count: number): string {
  return `${count}件`;
}

/**
 * タイトルを空のままにしたときに使われる出力ファイル名。
 *
 * 画面では空欄なのに出力だけ勝手に名前が付くと「空で保存したのに名前が付いた」に
 * 見えるので、placeholder でその名前を先に見せる。`resolveFileNames` の
 * フォールバックと同じ形にしておくこと。
 */
export function formatFallbackTitle(index: number): string {
  return `text-${index + 1}.txt`;
}

/** 値が実際の改行を含むか。含むセルは1行入力に載せられない。 */
export function isMultiline(value: string): boolean {
  return value.includes('\n');
}

/**
 * 複数行の値を、表のセルに収まる1行の要約にする。
 *
 * ルール表は「大量のルールを横断して見る一覧」なので、行の高さを可変にしたり
 * 改行位置を `↵` で詰め込んだりはしない。1行目だけ見せて、複数行であることを明示する。
 */
export function formatCellPreview(value: string): string {
  if (!isMultiline(value)) return value;
  const firstLine = value.slice(0, value.indexOf('\n'));
  return `${firstLine}… [複数行]`;
}

/** 連番ラベル（01, 02, …）。 */
export function formatIndex(index: number): string {
  return padTwo(index + 1);
}

/** 「HH:MM」 */
export function formatTime(date: Date): string {
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

/** ダウンロードしたファイル名に使う `YYYYMMDD-HHmm`。 */
export function timestampForFileName(date: Date): string {
  return `${date.getFullYear()}${padTwo(date.getMonth() + 1)}${padTwo(date.getDate())}-${padTwo(date.getHours())}${padTwo(date.getMinutes())}`;
}
