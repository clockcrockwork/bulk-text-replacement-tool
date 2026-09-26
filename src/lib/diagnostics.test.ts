import { describe, expect, it } from 'vitest';
import type { Group, Rule } from '../types';
import { collectRuleErrors, findDuplicateGroupNames, findUnmatchedRules } from './diagnostics';
import { runConversion } from './replace';

const GROUPS: Group[] = [
  { id: 'g1', name: 'A' },
  { id: 'g2', name: 'B' },
];

function rule(id: string, src: string, values: Record<string, string>, regex = false): Rule {
  return { id, src, regex, cs: true, order: 'sim', values };
}

describe('collectRuleErrors', () => {
  it('正規表現として不正な行を拾う', () => {
    const errors = collectRuleErrors([rule('r1', '(', { g1: 'x' }, true)]);
    expect(errors.get('r1')).toContain('正規表現エラー');
  });

  it('正規表現モードでない行は、同じ文字列でもエラーにしない', () => {
    expect(collectRuleErrors([rule('r1', '(', { g1: 'x' })]).size).toBe(0);
  });

  it('置換元が空の行は対象外', () => {
    expect(collectRuleErrors([rule('r1', '', { g1: 'x' }, true)]).size).toBe(0);
  });

  it('正しい正規表現は残らない', () => {
    expect(collectRuleErrors([rule('r1', '\\d+', { g1: 'x' }, true)]).size).toBe(0);
  });
});

describe('findUnmatchedRules', () => {
  const convert = (rules: Rule[], text: string) =>
    runConversion({ inputs: [{ id: 'i1', title: 'a.txt', text }], groups: GROUPS, rules });

  it('どのグループでも当たらなかったルールを返す', () => {
    const rules = [rule('r1', 'アリス', { g1: 'あー' }), rule('r2', 'ボブ', { g1: 'びー' })];
    const unmatched = findUnmatchedRules(rules, GROUPS, convert(rules, 'アリス'));
    expect(unmatched.map((r) => r.id)).toEqual(['r2']);
  });

  it('1つでも当たったグループがあれば対象外', () => {
    const rules = [rule('r1', 'アリス', { g1: 'あー', g2: '' })];
    expect(findUnmatchedRules(rules, GROUPS, convert(rules, 'アリス'))).toEqual([]);
  });

  it('置換先が全グループで空の行は、適用対象でないので数えない', () => {
    const rules = [rule('r1', 'アリス', {})];
    expect(findUnmatchedRules(rules, GROUPS, convert(rules, 'ボブ'))).toEqual([]);
  });

  it('置換元が空の行は数えない', () => {
    const rules = [rule('r1', '', { g1: 'あー' })];
    expect(findUnmatchedRules(rules, GROUPS, convert(rules, 'ボブ'))).toEqual([]);
  });

  it('置換先を設定したグループでだけ0件かを見る（未設定のグループに引きずられない）', () => {
    // g1 には置換先があり当たる。g2 は未設定なので 0 件だが、それは正常。
    const rules = [rule('r1', 'アリス', { g1: 'あー' })];
    expect(findUnmatchedRules(rules, GROUPS, convert(rules, 'アリス'))).toEqual([]);
  });
});

describe('findDuplicateGroupNames', () => {
  it('同じ名前を1回だけ返す', () => {
    expect(
      findDuplicateGroupNames([
        { id: 'g1', name: 'A用' },
        { id: 'g2', name: 'A用' },
        { id: 'g3', name: 'A用' },
        { id: 'g4', name: 'B用' },
      ]),
    ).toEqual(['A用']);
  });

  it('重複が無ければ空', () => {
    expect(findDuplicateGroupNames(GROUPS)).toEqual([]);
  });

  it('空の名前どうしも重複として扱う', () => {
    expect(
      findDuplicateGroupNames([
        { id: 'g1', name: '' },
        { id: 'g2', name: '' },
      ]),
    ).toEqual(['']);
  });
});
