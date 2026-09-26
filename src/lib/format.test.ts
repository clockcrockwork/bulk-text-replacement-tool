import { describe, expect, it } from 'vitest';
import {
  formatIndex,
  formatInputSummary,
  formatTextMeta,
  formatTime,
  timestampForFileName,
} from './format';

describe('formatTextMeta', () => {
  it('行数を出す', () => {
    expect(formatTextMeta('あい\nうえ')).toBe('2行');
  });

  it('空文字は0行として扱う', () => {
    expect(formatTextMeta('')).toBe('0行');
  });

  it('末尾の改行も1行として数える（textarea の見た目に合わせる）', () => {
    expect(formatTextMeta('a\n')).toBe('2行');
  });

  it('改行の無い長文でも1行', () => {
    expect(formatTextMeta('a'.repeat(12345))).toBe('1行');
  });

  it('大きい行数は桁区切りを入れる', () => {
    expect(formatTextMeta('a\n'.repeat(1234))).toBe('1,235行');
  });
});

describe('formatInputSummary', () => {
  it('件数を出す', () => {
    expect(formatInputSummary(3)).toBe('3件');
  });

  it('0件でも成り立つ', () => {
    expect(formatInputSummary(0)).toBe('0件');
  });
});

describe('formatIndex', () => {
  it('1始まりの2桁ゼロ埋め', () => {
    expect(formatIndex(0)).toBe('01');
    expect(formatIndex(8)).toBe('09');
  });

  it('2桁を超えたら桁を増やす', () => {
    expect(formatIndex(99)).toBe('100');
  });
});

describe('formatTime', () => {
  it('HH:MM にゼロ埋めする', () => {
    expect(formatTime(new Date(2026, 8, 26, 9, 5))).toBe('09:05');
    expect(formatTime(new Date(2026, 8, 26, 23, 59))).toBe('23:59');
  });
});

describe('timestampForFileName', () => {
  it('YYYYMMDD-HHmm を作る', () => {
    expect(timestampForFileName(new Date(2026, 0, 2, 3, 4))).toBe('20260102-0304');
  });
});
