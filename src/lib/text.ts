/**
 * UTF-8 の BOM（U+FEFF）。
 *
 * ソースに生の文字として書くとエディタでも diff でも見えず、コピペやツールの
 * 正規化で静かに落ちる。この1箇所だけエスケープで持ち、他はここを参照する。
 */
export const BOM = '\ufeff';

/** 先頭の BOM を外す。取り込んだファイルや貼り付けたテキストの前処理に使う。 */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/** Excel が UTF-8 と判定できるよう BOM を付ける。 */
export function withBom(text: string): string {
  return BOM + text;
}
