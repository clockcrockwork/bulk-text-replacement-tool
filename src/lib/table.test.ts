import { describe, expect, it } from 'vitest';
import type { Group, Rule } from '../types';
import {
  buildRulesFromTable,
  type Delimiter,
  findRaggedRows,
  parseDelimited,
  parseTable,
  rulesToDelimited,
} from './table';
import { BOM } from './text';

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
    const parsed = parseTable(`${BOM}a,b\r\n1,2\r\n`);
    expect(parsed.kind).toBe('csv');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('クォートの中のタブでは TSV と誤判定しない', () => {
    // 以前はテキスト全体に \t があるかで判定していたため、見出し行ごと1セルに潰れていた。
    const parsed = parseTable('元テキスト,A用\n"foo\tbar",X');
    expect(parsed.kind).toBe('csv');
    expect(parsed.rows).toEqual([
      ['元テキスト', 'A用'],
      ['foo\tbar', 'X'],
    ]);
  });

  it('クォートの外にタブがあれば TSV とみなす', () => {
    expect(parseTable('a\tb\n1\t2').kind).toBe('tsv');
  });

  it('全角空白はセルの値として残す（字下げの指定に使う）', () => {
    expect(parseTable('| 元テキスト | A用 |\n| --- | --- |\n| INDENT | \u3000 |').rows).toEqual([
      ['元テキスト', 'A用'],
      ['INDENT', '\u3000'],
    ]);
    expect(parseTable('元テキスト,A用\nINDENT,\u3000').rows).toEqual([
      ['元テキスト', 'A用'],
      ['INDENT', '\u3000'],
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

  it('同名の列見出しは別グループに分け、値を取りこぼさない', () => {
    const built = buildRulesFromTable({
      ...base,
      rows: [
        ['元テキスト', 'A用', 'A用'],
        ['アリス', '左', '右'],
      ],
    });
    expect(built?.groups.map((group) => group.name)).toEqual(['A用', 'A用 (2)']);
    const [first, second] = built?.groups ?? [];
    expect(built?.rules[0]?.values).toEqual({
      [String(first?.id)]: '左',
      [String(second?.id)]: '右',
    });
  });

  it('グループ列が1つも無ければ既定のグループを作る', () => {
    const built = buildRulesFromTable({ ...base, rows: [['元テキスト'], ['a']] });
    expect(built?.groups.map((group) => group.name)).toEqual(['グループ1']);
  });
});

describe('書き出し → 読み込みの往復', () => {
  const roundTrip = (groups: Group[], rules: Rule[], delimiter: Delimiter = ',') => {
    const text = rulesToDelimited(groups, rules, delimiter);
    const parsed = parseTable(text);
    return buildRulesFromTable({
      rows: parsed.rows,
      mode: 'replace',
      currentGroups: [],
      currentRules: [],
    });
  };

  it('ふつうのルール表は往復しても同じ意味になる', () => {
    const groups: Group[] = [
      { id: 'g1', name: 'A用' },
      { id: 'g2', name: 'B用' },
    ];
    const rules: Rule[] = [
      {
        id: 'r1',
        src: 'アリス',
        regex: false,
        cs: true,
        order: 'sim',
        values: { g1: 'あー', g2: 'びー' },
      },
      { id: 'r2', src: 'a+', regex: true, cs: false, order: 'seq', values: { g1: 'X', g2: 'Y' } },
    ];
    const back = roundTrip(groups, rules);
    expect(back?.groups.map((g) => g.name)).toEqual(['A用', 'B用']);
    const [gA, gB] = back?.groups ?? [];
    expect(back?.rules[0]).toMatchObject({ src: 'アリス', regex: false, cs: true, order: 'sim' });
    expect(back?.rules[0]?.values).toEqual({ [String(gA?.id)]: 'あー', [String(gB?.id)]: 'びー' });
    expect(back?.rules[1]).toMatchObject({ src: 'a+', regex: true, cs: false, order: 'seq' });
  });

  // 予約見出しと同じ名前のグループは UI で普通に作れる。以前はここで置換先が失われていた。
  it.each(['正規表現', '大小区別', '適用順'])(
    'グループ名が予約見出し「%s」でも往復できる',
    (name) => {
      const groups: Group[] = [{ id: 'g1', name }];
      const rules: Rule[] = [
        { id: 'r1', src: 'A', regex: false, cs: true, order: 'sim', values: { g1: 'X' } },
      ];
      const back = roundTrip(groups, rules);
      expect(back?.groups.map((g) => g.name)).toEqual([name]);
      expect(Object.values(back?.rules[0]?.values ?? {})).toEqual(['X']);
      expect(back?.rules[0]).toMatchObject({ regex: false, cs: true, order: 'sim' });
    },
  );

  it('全角空白だけの置換先も往復で失われない', () => {
    const groups: Group[] = [{ id: 'g1', name: 'A用' }];
    const rules: Rule[] = [
      { id: 'r1', src: 'INDENT', regex: false, cs: true, order: 'sim', values: { g1: '\u3000' } },
    ];
    const back = roundTrip(groups, rules);
    expect(Object.values(back?.rules[0]?.values ?? {})).toEqual(['\u3000']);
  });

  it('タブを含む置換元は CSV なら往復できる', () => {
    const groups: Group[] = [{ id: 'g1', name: 'A用' }];
    const rules: Rule[] = [
      { id: 'r1', src: 'foo\tbar', regex: false, cs: true, order: 'sim', values: { g1: 'X' } },
    ];
    const back = roundTrip(groups, rules, ',');
    expect(back?.rules[0]?.src).toBe('foo\tbar');
  });

  // 以前 TSV は区切り文字を空白へ潰していたため、自分で書き出したものを
  // 読み戻すだけで値が変わっていた。
  it.each([',', '\t'] as const)('区切り「%j」でも、値を変えずに往復できる', (delimiter) => {
    const groups: Group[] = [{ id: 'g1', name: 'A用' }];
    const rules: Rule[] = [
      {
        id: 'r1',
        src: 'foo\tbar',
        regex: false,
        cs: true,
        order: 'sim',
        values: { g1: '一行目\n二行目' },
      },
      {
        id: 'r2',
        src: 'あ"い',
        regex: false,
        cs: true,
        order: 'sim',
        values: { g1: '\u3000字下げ' },
      },
    ];
    const back = roundTrip(groups, rules, delimiter);
    expect(back?.rules.map((rule) => rule.src)).toEqual(['foo\tbar', 'あ"い']);
    expect(back?.rules.map((rule) => Object.values(rule.values)[0])).toEqual([
      '一行目\n二行目',
      '\u3000字下げ',
    ]);
  });
});

describe('findRaggedRows', () => {
  it('見出しと列数が違う行を返す（データ行の1始まり）', () => {
    expect(
      findRaggedRows([
        ['元テキスト', 'A用', 'B用'],
        ['ア', 'あ', 'い'],
        ['イ', 'う'],
        ['ウ', 'え', 'お', '余り'],
      ]),
    ).toEqual([2, 3]);
  });

  it('揃っていれば空', () => {
    expect(
      findRaggedRows([
        ['元テキスト', 'A用'],
        ['ア', 'あ'],
      ]),
    ).toEqual([]);
  });

  it('見出しだけ・空の表では何も返さない', () => {
    expect(findRaggedRows([['元テキスト', 'A用']])).toEqual([]);
    expect(findRaggedRows([])).toEqual([]);
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

  it('TSV でも区切りを含むセルはクォートする（値を潰さない）', () => {
    const withTab: Rule[] = [{ ...(rules[0] as Rule), src: 'a\tb' }];
    expect(rulesToDelimited(groups, withTab, '\t').split('\r\n')[1]).toBe('"a\tb"\tX\t1\t0\t順次');
  });

  it('TSV でも改行と引用符を含むセルをクォートする', () => {
    const tricky: Rule[] = [
      { ...(rules[0] as Rule), src: '一行目\n二行目', values: { g1: 'あ"い' } },
    ];
    expect(rulesToDelimited(groups, tricky, '\t').split('\r\n')[1]).toBe(
      '"一行目\n二行目"\t"あ""い"\t1\t0\t順次',
    );
  });
});
