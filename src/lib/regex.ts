import type { Rule } from '../types';

/** 文字列をそのまま一致させるために、正規表現のメタ文字をエスケープする。 */
export function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `compileRule` の結果。置換元が空の行はエラーではなく「対象外」として扱う。 */
export type CompiledRule =
  | { kind: 'empty' }
  | { kind: 'ok'; re: RegExp }
  | { kind: 'error'; message: string };

/**
 * ルールの置換元を `RegExp` に変換する。
 *
 * **常に `u` フラグを付ける。** 付けないと `.` が `𠮷` を分断し
 * （`'𠮷'.replace(/./g, 'X')` は `"XX"` になる）、`\p{Script=Han}` のような Unicode
 * プロパティも使えない。日本語の原稿を扱う以上ここは外せない。
 *
 * `u` は `[\-]` や裸の `{` のような、付けなければ通る書き方を不正にする。
 * 以前はそうしたパターンを `u` 無しで作り直していたが、ルールごとに Unicode の
 * 扱いが変わる（同じ `.` が1文字だったり2文字だったりする）状態になるのでやめた。
 * 不正なものは正規表現エラーとして表示し、書き直してもらう。
 *
 * 常に `g` フラグ付きなので、利用側は `lastIndex` のリセットに責任を持つこと。
 */
export function compileRule(rule: Pick<Rule, 'src' | 'regex' | 'cs'>): CompiledRule {
  if (!rule.src) return { kind: 'empty' };
  const source = rule.regex ? rule.src : escapeRegExp(rule.src);
  try {
    return { kind: 'ok', re: new RegExp(source, rule.cs ? 'gu' : 'giu') };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      kind: 'error',
      message: `正規表現エラー: ${raw.replace(/^Invalid regular expression: /, '')}`,
    };
  }
}

/**
 * 置換先文字列の `$&` `$1` `$<name>` `$$` を展開する。
 * `String.prototype.replace` と違い、存在しない番号の参照はそのまま残す
 * （`$9` と書いて 9 番が無いとき、消えるより見えている方が直しやすい）。
 * `$0` は `String.prototype.replace` と同じくグループ参照ではなくそのままの文字列。
 */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (all, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (token.startsWith('<')) return match.groups?.[token.slice(1, -1)] ?? '';
    const index = Number(token);
    // $0 はキャプチャ番号ではない（全体一致は $&）。native と同じくそのまま残す。
    if (index === 0) return all;
    return index < match.length ? (match[index] ?? '') : all;
  });
}
