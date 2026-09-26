import { describe, expect, it } from 'vitest';
import { BOM, decodeText, stripBom, trimAscii, withBom } from './text';

describe('BOM', () => {
  // 生の U+FEFF がソースに紛れ込んでいないことの歯止め。
  it('U+FEFF の1文字である', () => {
    expect(BOM).toHaveLength(1);
    expect(BOM.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('stripBom', () => {
  it('先頭の BOM だけを外す', () => {
    expect(stripBom(`${BOM}abc`)).toBe('abc');
  });

  it('BOM が無ければそのまま', () => {
    expect(stripBom('abc')).toBe('abc');
  });

  it('途中の U+FEFF は残す（本文の一部かもしれない）', () => {
    expect(stripBom(`a${BOM}b`)).toBe(`a${BOM}b`);
  });

  it('空文字でも落ちない', () => {
    expect(stripBom('')).toBe('');
  });
});

describe('withBom', () => {
  it('先頭に BOM を足す', () => {
    expect(withBom('abc')).toBe(`${BOM}abc`);
  });
});

describe('trimAscii', () => {
  it('半角の空白・タブ・改行を前後から落とす', () => {
    expect(trimAscii('  a\t\n')).toBe('a');
  });

  it('全角空白は落とさない（字下げの指定として意味を持つ）', () => {
    expect(trimAscii('\u3000')).toBe('\u3000');
    expect(trimAscii(' \u3000a\u3000 ')).toBe('\u3000a\u3000');
  });

  it('String.prototype.trim との違いを固定する', () => {
    expect('\u3000'.trim()).toBe('');
    expect(trimAscii('\u3000')).toBe('\u3000');
  });
});

describe('decodeText', () => {
  const utf8 = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it('UTF-8 をそのまま読む', () => {
    expect(decodeText(utf8('名前,太郎'))).toBe('名前,太郎');
  });

  it('BOM 付き UTF-8 は BOM を落とす', () => {
    expect(decodeText(utf8(`${BOM}名前`))).toBe('名前');
  });

  // 旧原稿や Excel が書き出した CSV は Shift_JIS のことがある。
  it('Shift_JIS(CP932) を読める', () => {
    const cp932 = new Uint8Array([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x91, 0xbe, 0x98, 0x59]);
    expect(decodeText(cp932.buffer as ArrayBuffer)).toBe('名前,太郎');
  });

  it('空のバイト列でも落ちない', () => {
    expect(decodeText(new ArrayBuffer(0))).toBe('');
  });
});
