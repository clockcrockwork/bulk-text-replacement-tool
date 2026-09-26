import { describe, expect, it } from 'vitest';
import { crc32, createZip } from './zip';

/**
 * テスト用の最小 ZIP リーダー。無圧縮前提でローカルヘッダを順に読む。
 * 実装と同じ知識を共有しないよう、オフセットは仕様の値をそのまま書いている。
 */
function readZip(buffer: ArrayBuffer): { names: string[]; texts: string[]; entryCount: number } {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const names: string[] = [];
  const texts: string[] = [];

  let offset = 0;
  while (offset + 4 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 22, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    names.push(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)));
    texts.push(decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }

  // End of central directory は末尾 22 バイト（コメント無しの場合）。
  const endOffset = buffer.byteLength - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
  return { names, texts, entryCount: view.getUint16(endOffset + 10, true) };
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
