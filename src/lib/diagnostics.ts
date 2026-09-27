import type { ConversionResult, Group, Rule } from '../types';
import { compileRule } from './regex';

/**
 * 変換の前後にユーザーへ知らせるべきことを判定する。
 *
 * 画面側で条件を組み立てると、同じ判定が「表示する場所」と「操作を止める場所」で
 * 食い違う（エラー表示は出ているのに変換は通る、など）。判定はここに1つだけ置く。
 */

/**
 * ルールIDごとの正規表現エラー。
 *
 * 正規表現として使わない行は、`(` のような文字もただの文字列なのでエラーにしない。
 * 置換元が空の行も対象外（そのグループでは何もしない行なので）。
 */
export function collectRuleErrors(rules: readonly Rule[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const rule of rules) {
    if (!rule.regex || !rule.src) continue;
    const compiled = compileRule(rule);
    if (compiled.kind === 'error') errors.set(rule.id, compiled.message);
  }
  return errors;
}

/**
 * 置換先が設定されているのに、どの入力でも一度も当たらなかったルール。
 *
 * 0件そのものは異常ではない（複数の原稿で同じルール表を使い回せば、その原稿には
 * 出てこない語も当然ある）。ただし全グループ・全入力で0件なら、打ち間違い・
 * 表記違い・Unicode の差が疑わしいので、変換後に気づけるようにする。
 *
 * 置換先が空のグループは「そのグループでは適用しない」ので数に入れない。
 */
export function findUnmatchedRules(
  rules: readonly Rule[],
  groups: readonly Group[],
  result: ConversionResult,
): Rule[] {
  return rules.filter((rule) => {
    if (!rule.src) return false;
    const applied = groups.filter((group) => (rule.values[group.id] ?? '') !== '');
    if (applied.length === 0) return false;
    return applied.every((group) => (result.hitsByGroupRule[group.id]?.[rule.id] ?? 0) === 0);
  });
}

/**
 * 同じ名前のグループ。
 *
 * 名前は出力先（タブ名・ZIP のディレクトリ名）の識別子になる。変換時に連番を振って
 * 重ならないようにはするが、表の見出しは入力したままなので、どの列がどの出力に
 * なるのか分からない状態になる。気づけるように名前を返す。
 */
export function findDuplicateGroupNames(groups: readonly Group[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.name)) duplicated.add(group.name);
    seen.add(group.name);
  }
  return [...duplicated];
}
