import { describe, expect, it } from 'vitest';
import { dedupeNames, resolveDirNames, resolveFileNames, sanitizeName } from './fileName';

describe('sanitizeName', () => {
  it('使えない文字を _ にする', () => {
    expect(sanitizeName('a:b*c?"<>|d', true)).toBe('a_b_c_____d');
  });

  it('allowSlash が false なら / も潰す', () => {
    expect(sanitizeName('a/b', false)).toBe('a_b');
    expect(sanitizeName('a/b', true)).toBe('a/b');
  });

  it('先頭のスラッシュと前後の空白を落とす', () => {
    expect(sanitizeName('  /root/a.md ', true)).toBe('root/a.md');
  });

  it('.. を落として展開先を抜け出せなくする（Zip Slip）', () => {
    expect(sanitizeName('../../evil.txt', true)).toBe('evil.txt');
    expect(sanitizeName('a/../../b.md', true)).toBe('a/b.md');
    expect(sanitizeName('..', true)).toBe('');
  });

  it('. と空の区切りも落とす', () => {
    expect(sanitizeName('./a//b.md', true)).toBe('a/b.md');
  });

  it('ディレクトリ名では .. が空になりフォールバックに回る', () => {
    expect(sanitizeName('..', false)).toBe('');
  });

  it('末尾のドットと空白を落とす（Windows で黙って消えて別名になる）', () => {
    expect(sanitizeName('a.', true)).toBe('a');
    expect(sanitizeName('a ', true)).toBe('a');
    expect(sanitizeName('dir./file..', true)).toBe('dir/file');
  });

  it('Windows の予約デバイス名を避ける', () => {
    expect(sanitizeName('CON', true)).toBe('_CON');
    expect(sanitizeName('nul.txt', true)).toBe('_nul.txt');
    expect(sanitizeName('COM1', true)).toBe('_COM1');
    expect(sanitizeName('LPT9.md', true)).toBe('_LPT9.md');
  });

  it('予約名に似ているだけの名前は変えない', () => {
    expect(sanitizeName('console.md', true)).toBe('console.md');
    expect(sanitizeName('COM10', true)).toBe('COM10');
  });
});

describe('dedupeNames', () => {
  it('重複に連番を振り、拡張子は末尾に残す', () => {
    expect(dedupeNames(['a.md', 'a.md', 'a.md'])).toEqual(['a.md', 'a (2).md', 'a (3).md']);
  });

  it('拡張子がなくても動く', () => {
    expect(dedupeNames(['README', 'README'])).toEqual(['README', 'README (2)']);
  });

  it('連番先も既に埋まっていればさらにずらす', () => {
    expect(dedupeNames(['a.md', 'a (2).md', 'a.md'])).toEqual(['a.md', 'a (2).md', 'a (3).md']);
  });

  it('大文字小文字だけが違う名前も重複として扱う', () => {
    // ZIP の中では別でも、大小を区別しないファイルシステムへ展開すると衝突する。
    expect(dedupeNames(['A.txt', 'a.txt'])).toEqual(['A.txt', 'a (2).txt']);
    expect(dedupeNames(['README', 'readme', 'ReadMe'])).toEqual([
      'README',
      'readme (2)',
      'ReadMe (3)',
    ]);
  });

  it('Object.prototype のキーでも重複扱いしない', () => {
    expect(dedupeNames(['constructor', 'toString'])).toEqual(['constructor', 'toString']);
  });
});

describe('resolveFileNames', () => {
  it('拡張子が無ければ .txt を足す', () => {
    expect(resolveFileNames(['memo'])).toEqual(['memo.txt']);
  });

  it('空タイトルには連番名を割り当てる', () => {
    expect(resolveFileNames(['', ''])).toEqual(['text-1.txt', 'text-2.txt']);
  });

  it('既存の拡張子は保つ', () => {
    expect(resolveFileNames(['chapter1.md'])).toEqual(['chapter1.md']);
  });
});

describe('resolveDirNames', () => {
  it('空名にはグループ連番を割り当て、スラッシュは潰す', () => {
    expect(resolveDirNames(['', 'a/b'])).toEqual(['group-1', 'a_b']);
  });

  it('.. だけの名前はフォールバック名になる', () => {
    expect(resolveDirNames(['..'])).toEqual(['group-1']);
  });
});

describe('resolveFileNames（Zip Slip）', () => {
  it('親ディレクトリへ抜ける名前を無害化する', () => {
    expect(resolveFileNames(['../../evil.txt'])).toEqual(['evil.txt']);
  });

  it('名前が空になったらフォールバック名を使う', () => {
    expect(resolveFileNames(['../..'])).toEqual(['text-1.txt']);
  });
});
