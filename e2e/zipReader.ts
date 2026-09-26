import { readFile } from 'node:fs/promises';
import { parseZip, type ZipEntry } from '../testing/zipReader';

export type { ZipEntry };

/** ダウンロードされた ZIP ファイルを読んでエントリ一覧にする。 */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
  return parseZip(await readFile(path)).entries;
}
