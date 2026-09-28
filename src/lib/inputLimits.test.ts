import { describe, expect, it } from 'vitest';
import {
  describeImportTotalTooLarge,
  formatLimit,
  MAX_IMPORT_TOTAL_BYTES,
  MAX_INPUT_BYTES,
  STORAGE_CONFIRM_CODE_UNITS,
} from './inputLimits';

describe('上限の値', () => {
  // 値を変えるときは docs/resource-policy.md の実測と根拠を見直すこと。
  it('1ファイルと1回の取り込みは 5MiB、保存の確認は 4Mi コード単位', () => {
    expect(MAX_INPUT_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_IMPORT_TOTAL_BYTES).toBe(5 * 1024 * 1024);
    expect(STORAGE_CONFIRM_CODE_UNITS).toBe(4 * 1024 * 1024);
  });

  it('画面の表記は MB 単位の整数', () => {
    expect(formatLimit(MAX_INPUT_BYTES)).toBe('5MB');
  });

  it('合計が上限を超えたときの文言に上限を入れる', () => {
    expect(describeImportTotalTooLarge()).toContain('合計が 5MB を超える');
  });
});
