import { readFile } from 'node:fs/promises';

export interface ZipEntry {
  name: string;
  text: string;
}

/**
 * テスト用の最小 ZIP リーダー（無圧縮前提）。
 * 実装と同じ知識を共有しないよう、オフセットは仕様の値をそのまま書いている。
 */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
  const buffer = await readFile(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  let offset = 0;
  while (offset + 4 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 22, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      name: decoder.decode(buffer.subarray(nameStart, nameStart + nameLength)),
      text: decoder.decode(buffer.subarray(dataStart, dataStart + size)),
    });
    offset = dataStart + size;
  }
  return entries;
}
