/**
 * 依存ライブラリなしで ZIP を組み立てる最小実装。
 * 無圧縮（store）・UTF-8 ファイル名固定。テキストしか入れないので圧縮は省いている。
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIR_SIZE = 22;
/** 汎用フラグ bit 11: ファイル名が UTF-8 であることを示す。 */
const UTF8_FLAG = 0x0800;
/** version needed / made by: 2.0（無圧縮＋ディレクトリ対応） */
const ZIP_VERSION = 20;
const STORE_METHOD = 0;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** ZIP のエントリごとに必要な CRC-32。 */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (table[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 形式の日時（ZIP ヘッダ用）に変換する。 */
function toDosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  /** ZIP 内のパス。`dir/file.txt` のように `/` で階層を表す。 */
  name: string;
  text: string;
}

/** テキストファイルの集合を ZIP の `Blob` にまとめる。 */
export function createZip(entries: readonly ZipEntry[], now: Date = new Date()): Blob {
  const encoder = new TextEncoder();
  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  const { time, date } = toDosDateTime(now);
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_SIZE));
    local.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    local.setUint16(4, ZIP_VERSION, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, STORE_METHOD, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    localParts.push(local.buffer, name, data);

    const central = new DataView(new ArrayBuffer(CENTRAL_HEADER_SIZE));
    central.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    central.setUint16(4, ZIP_VERSION, true);
    central.setUint16(6, ZIP_VERSION, true);
    central.setUint16(8, UTF8_FLAG, true);
    central.setUint16(10, STORE_METHOD, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centralParts.push(central.buffer, name);

    offset += LOCAL_HEADER_SIZE + name.length + data.length;
  }

  const centralSize = centralParts.reduce(
    (sum, part) =>
      sum + (part instanceof ArrayBuffer ? part.byteLength : (part as Uint8Array).byteLength),
    0,
  );
  const end = new DataView(new ArrayBuffer(END_OF_CENTRAL_DIR_SIZE));
  end.setUint32(0, END_OF_CENTRAL_DIR_SIGNATURE, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, end.buffer], { type: 'application/zip' });
}
