import { describe, expect, it } from 'vitest';
import { parseZip } from '../../testing/zipReader';
import { crc32, createZip } from './zip';

/** 名前と本文を配列で比べたいテストが多いので、その形に整える。 */
function readZip(buffer: ArrayBuffer): { names: string[]; texts: string[]; entryCount: number } {
  const { entries, entryCount } = parseZip(new Uint8Array(buffer));
  return {
    names: entries.map((entry) => entry.name),
    texts: entries.map((entry) => entry.text),
    entryCount,
  };
}

describe('crc32', () => {
  it('標準のチェック値と一致する', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('空データは 0', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('createZip', () => {
  const entries = [
    { name: 'A用/chapter1.md', text: '# 第一章\nあーちゃん\n' },
    { name: 'B用/chapter1.md', text: 'びーちゃん' },
  ];

  it('全エントリを読み戻せる', async () => {
    const buffer = await createZip(entries, new Date(2026, 8, 26, 10, 30, 0)).arrayBuffer();
    const read = readZip(buffer);
    expect(read.entryCount).toBe(2);
    expect(read.names).toEqual(entries.map((entry) => entry.name));
    expect(read.texts).toEqual(entries.map((entry) => entry.text));
  });

  it('MIME タイプが application/zip', () => {
    expect(createZip(entries).type).toBe('application/zip');
  });

  it('空の入力でも壊れた ZIP にならない', async () => {
    const buffer = await createZip([]).arrayBuffer();
    expect(buffer.byteLength).toBe(22);
    expect(readZip(buffer).entryCount).toBe(0);
  });

  it('ファイル名を UTF-8 として印づける（汎用フラグ bit 11）', async () => {
    const buffer = await createZip([{ name: '日本語.txt', text: 'x' }]).arrayBuffer();
    expect(new DataView(buffer).getUint16(6, true) & 0x0800).toBe(0x0800);
  });
});
