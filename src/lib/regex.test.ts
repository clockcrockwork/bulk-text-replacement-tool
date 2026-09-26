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
    expect(result.kind === 'ok' && result.re.flags).toBe('gi');
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

  it('存在しない名前付きキャプチャは空になる', () => {
    expect(expandReplacement('[$<z>]', exec('(?<y>a)', 'a'))).toBe('[]');
  });
});
