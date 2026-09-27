import { describe, expect, it } from 'vitest';
import { compileRule, escapeRegExp, expandReplacement } from './regex';

describe('escapeRegExp', () => {
  it('メタ文字をエスケープする', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c');
    expect(new RegExp(escapeRegExp('(x)')).test('(x)')).toBe(true);
  });
});

describe('compileRule', () => {
  it('置換元が空なら empty を返す', () => {
    expect(compileRule({ src: '', regex: false, cs: true })).toEqual({ kind: 'empty' });
  });

  it('リテラルはエスケープしてコンパイルする', () => {
    const result = compileRule({ src: 'a.b', regex: false, cs: true });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.re.test('axb')).toBe(false);
    expect(result.re.test('a.b')).toBe(true);
  });

  it('cs が false なら大小を無視する', () => {
    const result = compileRule({ src: 'abc', regex: false, cs: false });
    expect(result.kind === 'ok' && result.re.flags).toBe('giu');
  });

  it('u フラグを付けてサロゲートペアを1文字として扱う', () => {
    const result = compileRule({ src: '.', regex: true, cs: true });
    expect(result.kind === 'ok' && result.re.flags).toContain('u');
    // u が無いと '𠮷' が2回一致して "XX" になる
    expect(result.kind === 'ok' && '\u{20BB7}'.replace(result.re, 'X')).toBe('X');
  });

  it('Unicode プロパティエスケープが使える', () => {
    const result = compileRule({ src: '\\p{Script=Han}', regex: true, cs: true });
    expect(result.kind === 'ok' && result.re.test('漢')).toBe(true);
  });

  // u フラグでのみ不正になる書き方は、黙って u 無しに退避せずエラーにする。
  // 退避すると、同じ `.` がルールによって1文字にも2文字にもなり、仕様が1つに定まらない。
  it.each(['{', '}', '\\-', '\\a', '[a-\\d]'])(
    'u では不正になる書き方「%s」はエラーにする（黙って意味を変えない）',
    (src) => {
      const result = compileRule({ src, regex: true, cs: true });
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.message).toContain('正規表現エラー');
    },
  );

  it('コンパイルできたルールは必ず u 付き（Unicode の扱いがルールで変わらない）', () => {
    for (const src of ['アリス', '\\d+', '\\p{Script=Han}', '.']) {
      const result = compileRule({ src, regex: true, cs: true });
      expect(result.kind === 'ok' && result.re.flags).toContain('u');
    }
  });

  it('リテラルは常に u 付きでコンパイルできる', () => {
    const result = compileRule({ src: '\u{20BB7}さん', regex: false, cs: true });
    expect(result.kind === 'ok' && result.re.flags).toContain('u');
  });

  it('不正な正規表現はエラーを返す', () => {
    const result = compileRule({ src: '(', regex: true, cs: true });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toMatch(/^正規表現エラー: /);
    expect(result.message).not.toMatch(/Invalid regular expression/);
  });
});

describe('expandReplacement', () => {
  const exec = (pattern: string, text: string): RegExpExecArray => {
    const match = new RegExp(pattern).exec(text);
    if (!match) throw new Error('マッチしませんでした');
    return match;
  };

  it('$& は一致全体に展開する', () => {
    expect(expandReplacement('[$&]', exec('b+', 'abbc'))).toBe('[bb]');
  });

  it('$1 はキャプチャに展開する', () => {
    expect(expandReplacement('$2-$1', exec('(a)(b)', 'ab'))).toBe('b-a');
  });

  it('$<name> は名前付きキャプチャに展開する', () => {
    expect(expandReplacement('$<y>/$<m>', exec('(?<y>\\d{4})-(?<m>\\d{2})', '2026-09'))).toBe(
      '2026/09',
    );
  });

  it('$$ はドル記号1つになる', () => {
    expect(expandReplacement('$$1', exec('a', 'a'))).toBe('$1');
  });

  it('存在しない番号の参照はそのまま残す', () => {
    expect(expandReplacement('$3', exec('(a)', 'a'))).toBe('$3');
  });

  it('$0 はキャプチャ参照ではなくそのまま残る（native の replace と同じ）', () => {
    expect(expandReplacement('$0', exec('a', 'a'))).toBe('$0');
    expect('a'.replace(/a/, '$0')).toBe('$0');
  });

  it('存在しない名前付きキャプチャは空になる', () => {
    expect(expandReplacement('[$<z>]', exec('(?<y>a)', 'a'))).toBe('[]');
  });
});
