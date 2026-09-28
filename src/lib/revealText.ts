/**
 * 見た目と実体がずれる文字を、画面上で見える形にする（表示専用）。
 *
 * GitHub の tree の名前・ブランチ名・取り込んだ入力のタイトルは、NUL と `/` 以外を
 * 何でも含み得る。そのまま描画すると、`invoice\u202etxt.md` が一覧で `invoicedm.txt` に
 * 見えるように、別のファイルを選ばせる偽装ができる（CVE-2021-42574 と同じ仕組み）。
 * `<bdi>` は周りの文章との方向を切り離すだけで、中の RLO は効いたままなので足りない。
 *
 * ここで変えるのは**表示する文字列だけ**。保存するタイトル・出自・本文は変えない
 * （コードポイントの差も利用者の名前で、変えると取り込み元の同一性や出力が変わる）。
 */

/**
 * 可視化する文字。出力名で `_` に置き換える文字（`fileName.ts` の `sanitizeName`）と
 * 同じ集合にしておく。画面では見えていたのに出力では消えた、またはその逆を作らない。
 *
 * - C0 / C1 制御文字（改行・タブを含む）
 * - 双方向制御文字: ALM（U+061C）、LRM / RLM（U+200E/200F）、埋め込み・上書き
 *   （U+202A–202E）、隔離（U+2066–2069）
 * - 行区切り・段落区切り（U+2028/2029）
 * - 幅を持たない書式文字: ソフトハイフン、ZWSP、U+2060–206F、BOM、行間注記
 *   （U+FFF9–FFFB）、タグ文字（U+E0000–E007F）
 *
 * ZWNJ（U+200C）と ZWJ（U+200D）は含めない。絵文字の合字やインド系の文字では、
 * 見た目と意味を持つ文字として使われる。
 * ソースに実物を書かない（見えないまま壊れる）ので、すべてエスケープで書く。
 */
export const UNSAFE_DISPLAY_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を検出して見える形にするための正規表現
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

/** 1文字を `⟨U+202E⟩` の形にする。補助面の文字は 5〜6 桁になる。 */
function describeCodePoint(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `⟨U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}⟩`;
}

/** 見た目と実体がずれる文字を含むか。 */
export function hasUnsafeDisplayChars(text: string): boolean {
  // `search` は正規表現の lastIndex を見ないので、g 付きの共有パターンでも毎回先頭から探す。
  return text.search(UNSAFE_DISPLAY_CHARS) !== -1;
}

/**
 * 表示用の文字列を作る。該当する文字だけを `⟨U+XXXX⟩` に置き換え、それ以外は変えない。
 *
 * 戻り値は画面に出すためだけのもの。保存・比較・出力名には元の文字列を使うこと。
 */
export function revealUnsafeChars(text: string): string {
  return text.replace(UNSAFE_DISPLAY_CHARS, describeCodePoint);
}
