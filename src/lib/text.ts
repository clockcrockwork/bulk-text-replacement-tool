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

/**
 * 半角の空白・タブ・改行だけを前後から落とす。
 *
 * `String.prototype.trim` は全角空白 U+3000 も落とすが、日本語の原稿では字下げに
 * 全角空白を使うため、表のセルの値として意味を持つ。表の体裁合わせに使われるのは
 * 半角空白なので、そこだけを対象にする。
 */
export function trimAscii(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

/**
 * バイト列を文字列にする。
 *
 * `File.text()` は UTF-8 決め打ちなので、Shift_JIS / Windows-31J で保存された古い原稿や
 * Excel が書き出した CSV が文字化けする。まず UTF-8 として厳密に読み、壊れていれば
 * Shift_JIS として読み直す。BOM は落とす。
 */
export function decodeText(buffer: ArrayBuffer): string {
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    // UTF-8 として不正なバイト列 → 日本語環境で最も多い Shift_JIS とみなす。
    return stripBom(new TextDecoder('shift_jis').decode(buffer));
  }
}
