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

describe('resolveFileNames（拡張子の扱い）', () => {
  it('保証している拡張子はそのまま', () => {
    expect(resolveFileNames(['a.txt', 'b.md', 'c.tex'])).toEqual(['a.txt', 'b.md', 'c.tex']);
  });

  it('大文字の拡張子も保証対象として扱う', () => {
    expect(resolveFileNames(['A.MD'])).toEqual(['A.MD']);
  });

  it('保証していない拡張子は消さずに .txt を足す（中身はプレーンテキストなので）', () => {
    expect(resolveFileNames(['title.html'])).toEqual(['title.html.txt']);
    expect(resolveFileNames(['script.js'])).toEqual(['script.js.txt']);
    expect(resolveFileNames(['data.exe'])).toEqual(['data.exe.txt']);
  });

  it('二重拡張子は最後だけを見る', () => {
    expect(resolveFileNames(['story.part1.md'])).toEqual(['story.part1.md']);
    expect(resolveFileNames(['title.html.txt'])).toEqual(['title.html.txt']);
  });

  it('拡張子が無ければ .txt', () => {
    expect(resolveFileNames(['第一章'])).toEqual(['第一章.txt']);
  });

  it('日本語の拡張子は保証対象ではないので .txt を足す', () => {
    expect(resolveFileNames(['第一章.小説'])).toEqual(['第一章.小説.txt']);
  });
});

describe('resolveFileNames（名前であってパスではない）', () => {
  it('区切りは階層にせず名前の一部として残す', () => {
    expect(resolveFileNames(['第一章/序'])).toEqual(['第一章_序.txt']);
  });

  it('出力名に区切りは残らない（ZIPだけ階層になる食い違いを作らない）', () => {
    for (const name of resolveFileNames(['a/b/c.md', '../x.txt'])) {
      expect(name).not.toContain('/');
    }
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

describe('sanitizeName（制御文字・双方向制御文字）', () => {
  it('名前の中の改行・タブ・C0 制御文字を _ にする', () => {
    expect(sanitizeName('a\nb', true)).toBe('a_b');
    expect(sanitizeName('a\r\nb', true)).toBe('a__b');
    expect(sanitizeName('a\tb', true)).toBe('a_b');
    expect(sanitizeName('a\u0000b\u001fc', true)).toBe('a_b_c');
  });

  it('DEL と C1 制御文字を _ にする', () => {
    expect(sanitizeName('a\u007fb', true)).toBe('a_b');
    expect(sanitizeName('a\u0080b\u0085c\u009fd', true)).toBe('a_b_c_d');
  });

  it('前後の空白としての改行は従来どおり落とす', () => {
    expect(sanitizeName('\n a.md \t\n', true)).toBe('a.md');
  });

  it('上書き・埋め込み・隔離の双方向制御文字を _ にする（拡張子の偽装を防ぐ）', () => {
    // `a\u202egpj.md` は画面上で `adm.jpg` に見える。
    expect(sanitizeName('a\u202egpj.md', true)).toBe('a_gpj.md');
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(sanitizeName(`x${String.fromCodePoint(code)}y`, true)).toBe('x_y');
    }
  });

  it('LRM / RLM / ALM と行区切り・段落区切りを _ にする', () => {
    for (const code of [0x200e, 0x200f, 0x061c, 0x2028, 0x2029]) {
      expect(sanitizeName(`x${String.fromCodePoint(code)}y`, true)).toBe('x_y');
    }
  });

  it('レビューで挙がった形がそのまま残らない', () => {
    expect(sanitizeName('a\nb\u202egpj.md', false)).toBe('a_b_gpj.md');
  });

  it('制御文字を置き換えても、階層の区切りは / のまま', () => {
    expect(sanitizeName('dir\n/file.md', true)).toBe('dir_/file.md');
  });

  it('通常の文字（日本語・絵文字・結合文字・全角空白・ZWJ 絵文字）は変えない', () => {
    expect(sanitizeName('第一章　序.md', true)).toBe('第一章　序.md');
    expect(sanitizeName('\u304b\u3099.md', true)).toBe('\u304b\u3099.md');
    expect(sanitizeName('\u{1F468}\u200d\u{1F469}.md', true)).toBe('\u{1F468}\u200d\u{1F469}.md');
    expect(sanitizeName('שלום.md', true)).toBe('שלום.md');
  });
});

describe('resolveFileNames / resolveDirNames（制御文字）', () => {
  it('出力ファイル名に改行や双方向制御文字を残さない', () => {
    expect(resolveFileNames(['a\nb\u202egpj.md'])).toEqual(['a_b_gpj.md']);
    expect(resolveFileNames(['\u202e'])).toEqual(['_.txt']);
  });

  it('ZIP のディレクトリ名にも残さない', () => {
    expect(resolveDirNames(['A\n\u2066B'])).toEqual(['A__B']);
  });
});

describe('sanitizeName（幅を持たない書式文字）', () => {
  it('ZWSP・単語結合子・BOM・ソフトハイフン・行間注記・タグ文字を _ にする', () => {
    for (const code of [
      0x00ad, 0x200b, 0x2060, 0x2064, 0x206a, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0xe0000, 0xe0041,
      0xe007f,
    ]) {
      expect(sanitizeName(`x${String.fromCodePoint(code)}y`, true)).toBe('x_y');
    }
  });

  it('ZWNJ と ZWJ は残す（合字や文字の形を決める）', () => {
    expect(sanitizeName('x\u200cy', true)).toBe('x\u200cy');
    expect(sanitizeName('x\u200dy', true)).toBe('x\u200dy');
  });

  it('見た目が同じ別名を作らない', () => {
    expect(resolveFileNames(['a\u200b.md', 'a.md', 'a\ufeff.md'])).toEqual([
      'a_.md',
      'a.md',
      'a_ (2).md',
    ]);
  });
});

describe('dedupeNames（Unicode の正規化形）', () => {
  it('正規化形だけが違う名前も重複として扱う（macOS へ展開すると衝突する）', () => {
    // NFD の「か + 濁点」と NFC の「が」。
    expect(dedupeNames(['\u304b\u3099.md', '\u304c.md'])).toEqual([
      '\u304b\u3099.md',
      '\u304c (2).md',
    ]);
    // 大文字小文字と正規化形の両方が違う場合も。
    expect(dedupeNames(['e\u0301.md', '\u00c9.md'])).toEqual(['e\u0301.md', '\u00c9 (2).md']);
  });

  it('名前そのものは正規化しない', () => {
    expect(dedupeNames(['\u304b\u3099.md'])).toEqual(['\u304b\u3099.md']);
  });

  it('連番先の重複判定にも同じキーを使う', () => {
    expect(dedupeNames(['\u304c.md', '\u304c (2).md', '\u304b\u3099.md'])).toEqual([
      '\u304c.md',
      '\u304c (2).md',
      '\u304b\u3099 (3).md',
    ]);
  });
});
