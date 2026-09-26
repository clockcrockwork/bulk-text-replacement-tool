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

/**
 * 文字数を数える。
 *
 * `text.length` は UTF-16 の符号単位数なので、`𠮷` のような補助漢字を2と数えてしまう。
 * ここではコードポイント単位で数える（`𠮷` は1）。
 *
 * 書記素クラスタ（`Intl.Segmenter`）まで踏み込めば IVS や絵文字の連結も1と数えられるが、
 * 実測で 100万文字あたり 約630ms かかり、打鍵のたびに走る表示では現実的でない
 * （同じ条件でコードポイント計数は約5ms）。そのため IVS や ZWJ 絵文字は
 * 見た目の字数と一致しない。
 */
export function countCharacters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    count += 1;
    const code = text.charCodeAt(i);
    // 上位サロゲートなら、続く下位サロゲートと合わせて1文字として数える。
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i += 1;
  }
  return count;
}
