import { describe, expect, it } from 'vitest';
import { BOM, stripBom, withBom } from './text';

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
