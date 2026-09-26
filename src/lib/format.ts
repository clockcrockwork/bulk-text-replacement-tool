import { countCharacters } from './text';

/** 画面やファイル名に出す数値・日時の書式をここに集約する。 */

/** 2桁ゼロ埋め。時刻と連番で共有する。 */
function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

/** 「1,234 文字 · 56 行」 */
export function formatTextMeta(text: string): string {
  const lines = text ? text.split('\n').length : 0;
  return `${countCharacters(text).toLocaleString()} 文字 · ${lines} 行`;
}

/** 入力タブの見出しに出す合計。 */
export function formatInputSummary(count: number, totalChars: number): string {
  return `${count} 件 · ${totalChars.toLocaleString()} 文字`;
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
