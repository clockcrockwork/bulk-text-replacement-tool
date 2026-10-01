import { describe, expect, it } from 'vitest';
import type { Group, InputText, Rule, RuleOrder } from '../types';
import {
  advanceStringIndex,
  ConversionOutputLimitError,
  type ConversionProgress,
  createMarkedText,
  runConversion,
  toSegments,
} from './replace';

const GROUP_A: Group = { id: 'ga', name: 'A用' };

function rule(
  id: string,
  src: string,
  values: Record<string, string>,
  overrides: Partial<Pick<Rule, 'regex' | 'cs' | 'order'>> = {},
): Rule {
  return { id, src, regex: false, cs: true, order: 'sim', values, ...overrides };
}

function input(title: string, text: string): InputText {
  return { id: `i-${title}`, title, text };
}

/** 1入力・1グループの単純ケースを流すヘルパ。 */
function convertOne(text: string, rules: Rule[], groups: Group[] = [GROUP_A]) {
  const result = runConversion({ inputs: [input('a.txt', text)], groups, rules });
  const group = result.groups[0];
  if (!group) throw new Error('グループがありません');
  const file = group.files[0];
  if (!file) throw new Error('ファイルがありません');
  return { result, group, file };
}

describe('runConversion', () => {
  it('リテラルをグループごとに置換する', () => {
    const groupB: Group = { id: 'gb', name: 'B用' };
    const result = runConversion({
      inputs: [input('a.txt', 'アリスとビル')],
      groups: [GROUP_A, groupB],
      rules: [rule('r1', 'アリス', { ga: 'あー', gb: 'びー' })],
    });
    expect(result.groups[0]?.files[0]?.text).toBe('あーとビル');
    expect(result.groups[1]?.files[0]?.text).toBe('びーとビル');
  });

  it('置換先が空のセルは置換しない', () => {
    const { file } = convertOne('アリス', [rule('r1', 'アリス', { ga: '' })]);
    expect(file.text).toBe('アリス');
    expect(file.hits).toBe(0);
  });

  it('cs が false なら大小を無視する', () => {
    const { file } = convertOne('Foo foo', [rule('r1', 'foo', { ga: 'X' }, { cs: false })]);
    expect(file.text).toBe('X X');
  });

  it('同時適用では長い一致を優先する', () => {
    const { file } = convertOne('アリスさん', [
      rule('r1', 'アリス', { ga: 'A' }),
      rule('r2', 'アリスさん', { ga: 'B' }),
    ]);
    expect(file.text).toBe('B');
  });

  it('同じ位置・同じ長さならルールの定義順が勝つ', () => {
    const { file } = convertOne('x', [rule('r1', 'x', { ga: '1' }), rule('r2', 'x', { ga: '2' })]);
    expect(file.text).toBe('1');
  });

  it('同時適用では置換結果が次のルールに連鎖しない', () => {
    const { file } = convertOne('a', [rule('r1', 'a', { ga: 'b' }), rule('r2', 'b', { ga: 'c' })]);
    expect(file.text).toBe('b');
  });

  it('順次適用ではそれまでの結果に対して適用する', () => {
    const seq: Partial<Pick<Rule, 'order'>> = { order: 'seq' as RuleOrder };
    const { file } = convertOne('a', [
      rule('r1', 'a', { ga: 'b' }),
      rule('r2', 'b', { ga: 'c' }, seq),
    ]);
    expect(file.text).toBe('c');
  });

  it('順次適用は置換結果と周囲の文字列にまたがる一致も拾う', () => {
    // 以前は「あー」(置換済み) と「ちゃん」(未置換) が別断片で走査され、
    // またがる一致を取りこぼしていた。
    const seq: Partial<Pick<Rule, 'order'>> = { order: 'seq' as RuleOrder };
    const { file } = convertOne('アリスちゃん', [
      rule('r1', 'アリス', { ga: 'あー' }),
      rule('r2', 'あーちゃん', { ga: 'X' }, seq),
    ]);
    expect(file.text).toBe('X');
  });

  it('順次適用は置換結果の内側の一致も拾う', () => {
    const seq: Partial<Pick<Rule, 'order'>> = { order: 'seq' as RuleOrder };
    const { file } = convertOne('a', [
      rule('r1', 'a', { ga: 'xyz' }),
      rule('r2', 'y', { ga: 'Y' }, seq),
    ]);
    expect(file.text).toBe('xYz');
  });

  it('順次を挟んだあとの同時パスも、テキスト全体を対象にする', () => {
    const seq: Partial<Pick<Rule, 'order'>> = { order: 'seq' as RuleOrder };
    const { file } = convertOne('AB', [
      rule('r1', 'A', { ga: 'a' }),
      rule('r2', 'B', { ga: 'b' }, seq),
      rule('r3', 'ab', { ga: 'Z' }),
    ]);
    expect(file.text).toBe('Z');
  });

  it('前のパスのハイライトは、後のパスで置換されなければ残る', () => {
    const seq: Partial<Pick<Rule, 'order'>> = { order: 'seq' as RuleOrder };
    const { file } = convertOne('AB', [
      rule('r1', 'A', { ga: 'a' }),
      rule('r2', 'B', { ga: 'b' }, seq),
    ]);
    expect(file.text).toBe('ab');
    // 2回とも置換しているので全体がハイライト対象（隣接するので1断片に結合される）
    expect(file.segments).toEqual([{ text: 'ab', hit: true }]);
  });

  it('後のパスで置換された部分は、前のハイライトを引き継がない', () => {
    const seq: Partial<Pick<Rule, 'order'>> = { order: 'seq' as RuleOrder };
    const { file } = convertOne('xAy', [
      rule('r1', 'A', { ga: 'BB' }),
      rule('r2', 'B', { ga: '' }, seq), // 空は適用されない
    ]);
    expect(file.text).toBe('xBBy');
    expect(file.segments).toEqual([
      { text: 'x', hit: false },
      { text: 'BB', hit: true },
      { text: 'y', hit: false },
    ]);
  });

  it('正規表現の後方参照を展開する', () => {
    const { file } = convertOne('2026-09-26', [
      rule('r1', '(\\d{4})-(\\d{2})', { ga: '$2/$1' }, { regex: true }),
    ]);
    expect(file.text).toBe('09/2026-26');
  });

  it('正規表現エラーの行は無視して他の行を適用する', () => {
    const { file } = convertOne('ab', [
      rule('r1', '(', { ga: 'X' }, { regex: true }),
      rule('r2', 'b', { ga: 'B' }),
    ]);
    expect(file.text).toBe('aB');
  });

  it('空一致する正規表現でも無限ループしない', () => {
    const { file } = convertOne('abc', [rule('r1', 'x*', { ga: '-' }, { regex: true })]);
    expect(file.text).toBe('abc');
    expect(file.hits).toBe(0);
  });

  // u フラグ付きの正規表現は、サロゲートペアの途中を指す lastIndex を文字の先頭へ戻す。
  // 1 code unit ずつ進めると同じ空一致が返り続け、変換が終わらなくなっていた。
  it.each([
    ['^', '😀abc'],
    ['^', '𠮷abc'],
    ['\\s*', '本😀'],
    ['x*', '𠮷野家'],
    ['x*', '😀'],
    ['(?=😀)', 'a😀b😀'],
    ['\\b', '😀a😀'],
    ['$', 'abc😀'],
  ])('補助面の文字を含む入力で空一致しても終わる（%s × %s）', (src, text) => {
    const { file } = convertOne(text, [rule('r1', src, { ga: '-' }, { regex: true })]);
    expect(file.text).toBe(text);
    expect(file.hits).toBe(0);
  });

  it('空一致を読み飛ばした後も、補助面の文字の後ろの一致を拾う', () => {
    const { file } = convertOne('😀a😀aa𠮷', [rule('r1', 'a*', { ga: 'X' }, { regex: true })]);
    expect(file.text).toBe('😀X😀X𠮷');
    expect(file.hits).toBe(2);
  });

  it('空一致を読み飛ばしても、補助面の文字そのものへの一致は分断しない', () => {
    const { file } = convertOne('a😀b', [rule('r1', '😀?', { ga: '[$&]' }, { regex: true })]);
    expect(file.text).toBe('a[😀]b');
    expect(file.hits).toBe(1);
  });

  it('ヒット数をグループ×ルールで数える', () => {
    const { result, file } = convertOne('aa b', [
      rule('r1', 'a', { ga: 'X' }),
      rule('r2', 'b', { ga: 'Y' }),
      rule('r3', 'z', { ga: 'Z' }),
    ]);
    expect(result.hitsByGroupRule.ga).toEqual({ r1: 2, r2: 1, r3: 0 });
    expect(file.hits).toBe(3);
  });

  it('断片を連結すると本文と一致し、置換部分だけ hit になる', () => {
    const { file } = convertOne('xAy', [rule('r1', 'A', { ga: 'B' })]);
    expect(file.segments.map((segment) => segment.text).join('')).toBe(file.text);
    expect(file.segments).toEqual([
      { text: 'x', hit: false },
      { text: 'B', hit: true },
      { text: 'y', hit: false },
    ]);
  });

  it('同じファイル名の入力には連番を振る', () => {
    const result = runConversion({
      inputs: [input('a.md', '1'), { id: 'i2', title: 'a.md', text: '2' }],
      groups: [GROUP_A],
      rules: [],
    });
    expect(result.groups[0]?.files.map((file) => file.title)).toEqual(['a.md', 'a (2).md']);
  });

  it('グループ名が空ならディレクトリ名を代わりに使う', () => {
    const result = runConversion({
      inputs: [input('a.txt', '')],
      groups: [{ id: 'g1', name: '' }],
      rules: [],
    });
    expect(result.groups[0]?.dir).toBe('group-1');
    expect(result.groups[0]?.name).toBe('group-1');
  });
});

describe('toSegments', () => {
  it('ハイライト範囲の無いテキストは1断片になる', () => {
    expect(toSegments(createMarkedText('abc'))).toEqual([{ text: 'abc', hit: false }]);
  });

  it('空テキストは断片ゼロ', () => {
    expect(toSegments(createMarkedText(''))).toEqual([]);
  });

  it('範囲の前後を非ヒット断片として挟む', () => {
    expect(toSegments({ text: 'abcde', ranges: [{ start: 1, end: 3 }] })).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'de', hit: false },
    ]);
  });

  it('先頭と末尾に接する範囲では空断片を作らない', () => {
    expect(toSegments({ text: 'ab', ranges: [{ start: 0, end: 2 }] })).toEqual([
      { text: 'ab', hit: true },
    ]);
  });
});

describe('Unicode 正規化', () => {
  it('合成済みと結合文字列は別物として扱う（正規化しない）', () => {
    const composed = '\u304c'; // が
    const decomposed = '\u304b\u3099'; // か + 濁点
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFD')).toBe(decomposed);

    const result = runConversion({
      inputs: [{ id: 'i1', title: 'a.txt', text: `${composed}/${decomposed}` }],
      groups: [{ id: 'g1', name: 'G' }],
      rules: [
        {
          id: 'r1',
          src: composed,
          regex: false,
          cs: true,
          order: 'sim',
          values: { g1: 'X' },
        },
      ],
    });
    // 合成済みの側だけが置換される。正規化していたら両方 X になる。
    expect(result.groups[0]?.files[0]?.text).toBe(`X/${decomposed}`);
    expect(result.groups[0]?.files[0]?.hits).toBe(1);
  });
});

describe('グループ名の一意化', () => {
  it('同名のグループでも、タブ名と ZIP のディレクトリ名が一致し重ならない', () => {
    const result = runConversion({
      inputs: [{ id: 'i1', title: 'a.txt', text: 'アリス' }],
      groups: [
        { id: 'g1', name: 'A用' },
        { id: 'g2', name: 'A用' },
      ],
      rules: [
        {
          id: 'r1',
          src: 'アリス',
          regex: false,
          cs: true,
          order: 'sim',
          values: { g1: 'あー', g2: 'びー' },
        },
      ],
    });
    const names = result.groups.map((group) => group.name);
    const dirs = result.groups.map((group) => group.dir);
    expect(names).toEqual(['A用', 'A用 (2)']);
    // 見えている名前と ZIP の中の名前がずれない。
    expect(dirs).toEqual(names);
    expect(new Set(dirs).size).toBe(2);
  });

  it('名前が空のグループにも連番の名前が付く', () => {
    const result = runConversion({
      inputs: [],
      groups: [
        { id: 'g1', name: '' },
        { id: 'g2', name: '' },
      ],
      rules: [],
    });
    expect(result.groups.map((group) => group.name)).toEqual(['group-1', 'group-2']);
  });
});

describe('advanceStringIndex', () => {
  it('BMP の文字は 1 code unit 進める', () => {
    expect(advanceStringIndex('本a', 0)).toBe(1);
    expect(advanceStringIndex('本a', 1)).toBe(2);
  });

  it('補助面の文字はサロゲートペアの 2 code unit 進める', () => {
    expect(advanceStringIndex('😀a', 0)).toBe(2);
    expect(advanceStringIndex('a𠮷', 1)).toBe(3);
  });

  it('末尾とその先では 1 進める', () => {
    expect(advanceStringIndex('ab', 1)).toBe(2);
    expect(advanceStringIndex('ab', 2)).toBe(3);
    expect(advanceStringIndex('', 0)).toBe(1);
  });

  it('対になっていないサロゲートは 1 code unit 進める', () => {
    const loneHigh = String.fromCharCode(0xd83d);
    const loneLow = String.fromCharCode(0xde00);
    expect(advanceStringIndex(`${loneHigh}a`, 0)).toBe(1);
    expect(advanceStringIndex(`${loneLow}a`, 0)).toBe(1);
    expect(advanceStringIndex(`a${loneHigh}`, 1)).toBe(2);
  });
});

describe('変換結果の上限（issue #31）', () => {
  const groups: Group[] = [GROUP_A, { id: 'gb', name: 'B用' }];

  it('上限以内なら、上限を渡さないときと同じ結果になる', () => {
    const rules = [rule('r1', 'a', { ga: 'xyz', gb: 'b' })];
    const inputs = [input('a.txt', 'aaa')];
    const limited = runConversion({ inputs, groups, rules }, { maxOutputCodeUnits: 12 });
    const free = runConversion({ inputs, groups, rules });
    expect(limited.groups.map((g) => g.files[0]?.text)).toEqual(
      free.groups.map((g) => g.files[0]?.text),
    );
  });

  it('置換で膨らんで上限を超えたら、どのルール・グループ・ファイルかを添えて止める', () => {
    // 順次適用で毎回2倍になる（$& の繰り返し）。
    const rules = [
      rule('r1', '.+', { ga: '$&$&' }, { regex: true, order: 'seq' }),
      rule('r2', '.+', { ga: '$&$&' }, { regex: true, order: 'seq' }),
      rule('r3', '.+', { ga: '$&$&' }, { regex: true, order: 'seq' }),
    ];
    const inputs = [input('a.txt', 'ab'), input('b.txt', 'abcd')];
    let error: unknown;
    try {
      runConversion({ inputs, groups: [GROUP_A], rules }, { maxOutputCodeUnits: 40 });
    } catch (caught) {
      error = caught;
    }
    // a.txt は 2 → 16 で収まり（残り 24）、b.txt は 4 → 8 → 16 → 32 の3回目で超える。
    expect(error).toBeInstanceOf(ConversionOutputLimitError);
    expect(error).toMatchObject({ ruleId: 'r3', groupId: 'ga', inputIndex: 1 });
  });

  it('置換が無くても、グループへ複製した合計が上限を超えたら止める', () => {
    const inputs = [input('a.txt', 'abcdef')];
    expect(() => runConversion({ inputs, groups, rules: [] }, { maxOutputCodeUnits: 10 })).toThrow(
      ConversionOutputLimitError,
    );
    try {
      runConversion({ inputs, groups, rules: [] }, { maxOutputCodeUnits: 10 });
    } catch (error) {
      expect(error).toMatchObject({ ruleId: null, groupId: 'gb', inputIndex: 0 });
    }
  });

  it('同じパスの後ろの置換で縮んで収まるなら、途中で止めない', () => {
    // 先頭の x で 1 増え、後ろの a×8 で 7 減る。残りを見込みで足すと途中で超えて見える。
    const rules = [rule('r1', 'x', { ga: 'yy' }), rule('r2', 'aaaaaaaa', { ga: 'a' })];
    const { groups: out } = runConversion(
      { inputs: [input('a.txt', 'xaaaaaaaa')], groups: [GROUP_A], rules },
      { maxOutputCodeUnits: 9 },
    );
    expect(out[0]?.files[0]?.text).toBe('yya');
  });

  it('パスの最後の複写で超えたら、そのパスで置換したルールを示す', () => {
    // 先頭の置換は上限内に収まり、後ろの未置換の部分を足したところで超える。
    const rules = [rule('r1', 'x', { ga: 'yyyy' })];
    expect(() =>
      runConversion(
        { inputs: [input('a.txt', 'xabcd')], groups: [GROUP_A], rules },
        { maxOutputCodeUnits: 6 },
      ),
    ).toThrow(expect.objectContaining({ ruleId: 'r1', groupId: 'ga', inputIndex: 0 }));
  });

  it('置換の前から上限を超えている入力は、ルールのせいにしない', () => {
    const rules = [rule('r1', 'x', { ga: 'y' })];
    expect(() =>
      runConversion(
        { inputs: [input('a.txt', 'xabcdef')], groups: [GROUP_A], rules },
        { maxOutputCodeUnits: 3 },
      ),
    ).toThrow(expect.objectContaining({ ruleId: null }));
  });

  it('上限ちょうどは超えていない', () => {
    const rules = [rule('r1', 'a', { ga: 'bb' })];
    const { groups: out } = runConversion(
      { inputs: [input('a.txt', 'aa')], groups: [GROUP_A], rules },
      { maxOutputCodeUnits: 4 },
    );
    expect(out[0]?.files[0]?.text).toBe('bbbb');
  });
});

describe('変換の進み（onPass）', () => {
  it('各パスを当てる直前に、グループ・ファイル・パスのルールを知らせる', () => {
    const rules = [
      rule('r1', 'a', { ga: 'b' }),
      rule('r2', 'c', { ga: 'd' }),
      rule('r3', 'e', { ga: 'f' }, { order: 'seq' }),
      rule('r4', 'g', {}),
    ];
    const seen: ConversionProgress[] = [];
    runConversion(
      { inputs: [input('a.txt', 'x'), input('b.txt', 'y')], groups: [GROUP_A], rules },
      { onPass: (progress) => seen.push(progress) },
    );
    expect(seen).toEqual([
      { groupIndex: 0, inputIndex: 0, ruleIds: ['r1', 'r2'] },
      { groupIndex: 0, inputIndex: 0, ruleIds: ['r3'] },
      { groupIndex: 0, inputIndex: 1, ruleIds: ['r1', 'r2'] },
      { groupIndex: 0, inputIndex: 1, ruleIds: ['r3'] },
    ]);
  });
});
