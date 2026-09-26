import { describe, expect, it } from 'vitest';
import type { Group, Rule } from '../types';
import { buildRulesFromTable, parseDelimited, parseTable, rulesToDelimited } from './table';

describe('parseDelimited', () => {
  it('クォートの中の区切りと改行を保つ', () => {
    expect(parseDelimited('a,"b,c"\n"d\ne",f', ',')).toEqual([
      ['a', 'b,c'],
      ['d\ne', 'f'],
    ]);
  });

  it('連続する "" はリテラルのダブルクォートになる', () => {
    expect(parseDelimited('"a""b",c', ',')).toEqual([['a"b', 'c']]);
  });

  it('全セルが空の行は落とす', () => {
    expect(parseDelimited('a,b\n,\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseTable', () => {
  it('Markdown 表を認識し、区切り行を落とす', () => {
    const parsed = parseTable('| a | b |\n| --- | :-: |\n| 1 | 2 |');
    expect(parsed.kind).toBe('markdown');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('エスケープされた | はセル内の文字として残す', () => {
    expect(parseTable('| a\\|b | c |\n| 1 | 2 |').rows[0]).toEqual(['a|b', 'c']);
  });

  it('タブがあれば TSV とみなす', () => {
    const parsed = parseTable('a\tb\n1\t2');
    expect(parsed.kind).toBe('tsv');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('それ以外は CSV とみなし、BOM と CRLF を吸収する', () => {
    const parsed = parseTable('﻿a,b\r\n1,2\r\n');
    expect(parsed.kind).toBe('csv');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('空入力は kind が null', () => {
    expect(parseTable('   ')).toEqual({ rows: [], kind: null });
  });
});

describe('buildRulesFromTable', () => {
  const base = { mode: 'replace' as const, currentGroups: [], currentRules: [] };

  it('見出しだけなら null を返す', () => {
    expect(buildRulesFromTable({ ...base, rows: [['元テキスト', 'A']] })).toBeNull();
  });

  it('2列目以降をグループとして作る', () => {
    const built = buildRulesFromTable({
      ...base,
      rows: [
        ['元テキスト', 'A用', 'B用'],
        ['アリス', 'あー', 'びー'],
      ],
    });
    expect(built?.groups.map((group) => group.name)).toEqual(['A用', 'B用']);
    expect(built?.imported).toBe(1);
    const [groupA, groupB] = built?.groups ?? [];
    expect(built?.rules[0]?.values).toEqual({
      [String(groupA?.id)]: 'あー',
      [String(groupB?.id)]: 'びー',
    });
  });

  it('オプション列を読み取り、グループ列からは除く', () => {
    const built = buildRulesFromTable({
      ...base,
      rows: [
        ['元テキスト', 'A用', '正規表現', '大小区別', '適用順'],
        ['a+', 'X', '1', '0', '順次'],
      ],
    });
    expect(built?.groups).toHaveLength(1);
    expect(built?.rules[0]).toMatchObject({ src: 'a+', regex: true, cs: false, order: 'seq' });
  });

  it('大小区別の列が無ければ既定で区別する', () => {
    const built = buildRulesFromTable({
      ...base,
      rows: [
        ['元テキスト', 'A用'],
        ['a', 'X'],
      ],
    });
    expect(built?.rules[0]?.cs).toBe(true);
  });

  it('置換元が空の行は取り込まない', () => {
    const built = buildRulesFromTable({
      ...base,
      rows: [
        ['元テキスト', 'A用'],
        ['', 'X'],
        ['a', 'Y'],
      ],
    });
    expect(built?.imported).toBe(1);
  });

  it('append では同名グループを使い回し、既存ルールの後ろに足す', () => {
    const existingGroup: Group = { id: 'g1', name: 'A用' };
    const existingRule: Rule = {
      id: 'r1',
      src: '旧',
      regex: false,
      cs: true,
      order: 'sim',
      values: { g1: '古' },
    };
    const built = buildRulesFromTable({
      rows: [
        ['元テキスト', 'A用'],
        ['新', '今'],
      ],
      mode: 'append',
      currentGroups: [existingGroup],
      currentRules: [existingRule],
    });
    expect(built?.groups).toEqual([existingGroup]);
    expect(built?.rules.map((rule) => rule.src)).toEqual(['旧', '新']);
    expect(built?.rules[1]?.values).toEqual({ g1: '今' });
  });

  it('append では中身のない既存行を捨てる', () => {
    const empty: Rule = { id: 'r0', src: '', regex: false, cs: true, order: 'sim', values: {} };
    const built = buildRulesFromTable({
      rows: [
        ['元テキスト', 'A用'],
        ['a', 'X'],
      ],
      mode: 'append',
      currentGroups: [{ id: 'g1', name: 'A用' }],
      currentRules: [empty],
    });
    expect(built?.rules.map((rule) => rule.src)).toEqual(['a']);
  });

  it('グループ列が1つも無ければ既定のグループを作る', () => {
    const built = buildRulesFromTable({ ...base, rows: [['元テキスト'], ['a']] });
    expect(built?.groups.map((group) => group.name)).toEqual(['グループ1']);
  });
});

describe('rulesToDelimited', () => {
  const groups: Group[] = [{ id: 'g1', name: 'A用' }];
  const rules: Rule[] = [
    { id: 'r1', src: 'a,b', regex: true, cs: false, order: 'seq', values: { g1: 'X' } },
    { id: 'r2', src: '', regex: false, cs: true, order: 'sim', values: {} },
  ];

  it('CSV では区切りを含むセルをクォートし、置換元が空の行は出さない', () => {
    expect(rulesToDelimited(groups, rules, ',')).toBe(
      ['元テキスト,A用,正規表現,大小区別,適用順', '"a,b",X,1,0,順次'].join('\r\n'),
    );
  });

  it('TSV では区切りになる文字を空白に潰す', () => {
    const withTab: Rule[] = [{ ...(rules[0] as Rule), src: 'a\tb' }];
    expect(rulesToDelimited(groups, withTab, '\t').split('\r\n')[1]).toBe('a b\tX\t1\t0\t順次');
  });
});
