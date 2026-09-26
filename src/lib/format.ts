/** 画面に出す数値・日時の書式をここに集約する。 */

/** 「1,234 文字 · 56 行」 */
export function formatTextMeta(text: string): string {
  const lines = text ? text.split('\n').length : 0;
  return `${text.length.toLocaleString()} 文字 · ${lines} 行`;
}

/** 入力タブの見出しに出す合計。 */
export function formatInputSummary(count: number, totalChars: number): string {
  return `${count} 件 · ${totalChars.toLocaleString()} 文字`;
}

/** 連番ラベル（01, 02, …）。 */
export function formatIndex(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/** 「HH:MM」 */
export function formatTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
