import { describe, expect, it } from 'vitest';
import { sanitizeName } from './fileName';
import { hasUnsafeDisplayChars, revealUnsafeChars, UNSAFE_DISPLAY_CHARS } from './revealText';

describe('revealUnsafeChars', () => {
  it('RLO で拡張子を偽装した名前を、見える形にする', () => {
    expect(revealUnsafeChars('invoice\u202etxt.md')).toBe('invoice⟨U+202E⟩txt.md');
  });

  it('双方向制御文字をすべて可視化する', () => {
    const bidi = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ];
    for (const codePoint of bidi) {
      const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
      expect(revealUnsafeChars(`a${String.fromCodePoint(codePoint)}b`)).toBe(`a⟨U+${hex}⟩b`);
    }
  });

  it('C0 / C1 制御文字（改行・タブ・DEL を含む）を可視化する', () => {
    expect(revealUnsafeChars('a\nb\tc\u0000d\u007fe\u0085f\u009fg')).toBe(
      'a⟨U+000A⟩b⟨U+0009⟩c⟨U+0000⟩d⟨U+007F⟩e⟨U+0085⟩f⟨U+009F⟩g',
    );
  });

  it('幅を持たない書式文字と行区切りを可視化する', () => {
    expect(revealUnsafeChars('a\u200b\u2060\ufeff\u00ad\ufff9\u2028\u2029.md')).toBe(
      'a⟨U+200B⟩⟨U+2060⟩⟨U+FEFF⟩⟨U+00AD⟩⟨U+FFF9⟩⟨U+2028⟩⟨U+2029⟩.md',
    );
  });

  it('補助面のタグ文字は5桁で出し、サロゲートを1文字として扱う', () => {
    expect(revealUnsafeChars('a\u{e0041}.md')).toBe('a⟨U+E0041⟩.md');
  });

  it('ZWJ / ZWNJ と通常の文字（日本語・絵文字・結合文字）はそのまま', () => {
    const kept = [
      'が.md',
      'か\u3099.md',
      '👨\u200d👩\u200d👧.md',
      'क्\u200dष',
      'می\u200cخواهم',
      'Ａｂｃ　全角.txt',
    ];
    for (const text of kept) {
      expect(revealUnsafeChars(text)).toBe(text);
      expect(hasUnsafeDisplayChars(text)).toBe(false);
    }
  });

  it('元の文字列は変えない（表示用の新しい文字列を返す）', () => {
    const title = 'a\u202eb';
    revealUnsafeChars(title);
    expect(title).toBe('a\u202eb');
    expect(title).toHaveLength(3);
  });
});

describe('hasUnsafeDisplayChars', () => {
  it('該当する文字の有無を返す', () => {
    expect(hasUnsafeDisplayChars('a\u202eb')).toBe(true);
    expect(hasUnsafeDisplayChars('plain.md')).toBe(false);
    expect(hasUnsafeDisplayChars('')).toBe(false);
  });

  it('g 付きの共有パターンを使っても、呼ぶたびに同じ結果になる', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(hasUnsafeDisplayChars('\u202e')).toBe(true);
      expect(hasUnsafeDisplayChars('x\u202e')).toBe(true);
    }
    // test() で lastIndex が進んでいても影響しない。
    UNSAFE_DISPLAY_CHARS.test('abc\u202e');
    expect(hasUnsafeDisplayChars('\u202e')).toBe(true);
    UNSAFE_DISPLAY_CHARS.lastIndex = 0;
  });
});

describe('出力名との対応', () => {
  it('画面で可視化する文字は、出力名ではすべて _ になる（集合を共有している）', () => {
    const samples = ['\u0001', '\u0085', '\u061c', '\u200b', '\u202e', '\u2066', '\ufeff'];
    for (const char of samples) {
      expect(hasUnsafeDisplayChars(`a${char}b`)).toBe(true);
      expect(sanitizeName(`a${char}b.md`, true)).toBe('a_b.md');
    }
  });
});
