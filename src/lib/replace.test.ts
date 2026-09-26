import { describe, expect, it } from 'vitest';
import type { Group, InputText, Rule, RuleOrder } from '../types';
import { mergeSegments, runConversion } from './replace';

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

describe('mergeSegments', () => {
  it('同種の隣接断片をまとめ、空断片を落とす', () => {
    expect(
      mergeSegments([
        { text: 'a', hit: false },
        { text: '', hit: true },
        { text: 'b', hit: false },
        { text: 'c', hit: true },
      ]),
    ).toEqual([
      { text: 'ab', hit: false },
      { text: 'c', hit: true },
    ]);
  });
});
