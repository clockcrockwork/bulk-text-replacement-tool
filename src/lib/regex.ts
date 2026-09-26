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
 * `u` フラグを付けてサロゲートペアを1文字として扱う。付けないと `.` が `𠮷` を分断し
 * （`'𠮷'.replace(/./g, 'X')` は `"XX"` になる）、`\p{Script=Han}` のような Unicode
 * プロパティも使えない。日本語の原稿を扱う以上ここは外せない。
 *
 * ただし `u` は `[\-]` や裸の `{` のような従来は通っていた書き方を不正にするため、
 * `u` 付きで作れないパターンは `u` 無しで作り直す。既に動いているルールを壊さないことを優先する。
 *
 * 常に `g` フラグ付きなので、利用側は `lastIndex` のリセットに責任を持つこと。
 */
export function compileRule(rule: Pick<Rule, 'src' | 'regex' | 'cs'>): CompiledRule {
  if (!rule.src) return { kind: 'empty' };
  const source = rule.regex ? rule.src : escapeRegExp(rule.src);
  const base = rule.cs ? 'g' : 'gi';
  try {
    return { kind: 'ok', re: new RegExp(source, `${base}u`) };
  } catch {
    // u フラグでのみ不正になる書き方（`\-` や裸の `{` など）は、従来どおり u 無しで受け付ける。
  }
  try {
    return { kind: 'ok', re: new RegExp(source, base) };
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
 * `String.prototype.replace` と違い、存在しない番号の参照はそのまま残す。
 */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (all, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (token.startsWith('<')) return match.groups?.[token.slice(1, -1)] ?? '';
    const index = Number(token);
    return index < match.length ? (match[index] ?? '') : all;
  });
}
