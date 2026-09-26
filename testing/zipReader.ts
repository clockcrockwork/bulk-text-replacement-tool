/**
 * テスト用の最小 ZIP リーダー（無圧縮 store 前提）。
 *
 * ユニットテストと E2E の両方が ZIP のバイト列を検証するので、読み手はここ1つに置く。
 * 実装（`src/lib/zip.ts`）の定数は意図的に import せず、オフセットもシグネチャも
 * 仕様の値を直接書いている。実装と同じ思い違いをしていたら気づけないため。
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
/** コメント無しの End of central directory のサイズ。 */
const END_OF_CENTRAL_DIR_SIZE = 22;

export interface ZipEntry {
  name: string;
  text: string;
}

export interface ParsedZip {
  entries: ZipEntry[];
  /** central directory が申告しているエントリ数。 */
  entryCount: number;
}

export function parseZip(bytes: Uint8Array): ParsedZip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  let offset = 0;
  while (
    offset + 4 <= bytes.byteLength &&
    view.getUint32(offset, true) === LOCAL_HEADER_SIGNATURE
  ) {
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      text: decoder.decode(bytes.subarray(dataStart, dataStart + size)),
    });
    offset = dataStart + size;
  }

  // ヘルパーなので expect ではなく例外にする（どのテストが落ちたか分かるように）。
  const endOffset = bytes.byteLength - END_OF_CENTRAL_DIR_SIZE;
  if (endOffset < 0 || view.getUint32(endOffset, true) !== END_OF_CENTRAL_DIR_SIGNATURE) {
    throw new Error('End of central directory のシグネチャが見つからない');
  }
  return { entries, entryCount: view.getUint16(endOffset + 10, true) };
}
