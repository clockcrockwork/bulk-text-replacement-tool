import type { InputText } from '../types';
import { createId } from './id';
import { decodeText } from './text';

/** 取り込めるテキストファイルの拡張子。 */
export const ACCEPTED_EXTENSIONS = ['md', 'txt', 'tex'] as const;

/** `<input type="file">` の accept 属性。 */
/** MIME で選ばせたい種類。拡張子は ACCEPTED_EXTENSIONS から導出する。 */
const ACCEPTED_MIME_TYPES = ['text/plain', 'text/markdown'] as const;

/** `<input type="file">` の accept 属性。拡張子を足したらここも自動で追従する。 */
export const ACCEPT_ATTRIBUTE = [
  ...ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`),
  ...ACCEPTED_MIME_TYPES,
].join(',');

/** 画面に出す拡張子の案内文。 */
export const ACCEPTED_EXTENSIONS_LABEL = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(' / ');

const ACCEPTED_PATTERN = new RegExp(`\\.(${ACCEPTED_EXTENSIONS.join('|')})$`, 'i');

export function isAcceptedFile(name: string): boolean {
  return ACCEPTED_PATTERN.test(name);
}

export interface ReadFilesResult {
  inputs: InputText[];
  /** 拡張子が対象外でスキップした件数。 */
  skipped: number;
  /** UTF-8 として読めず Shift_JIS とみなしたファイル名。推測なので画面で知らせる。 */
  guessedShiftJis: string[];
}

/** ドロップ／選択されたファイルを読み込んで入力テキストに変換する。BOM は落とす。 */
export async function readInputFiles(fileList: FileList | File[] | null): Promise<ReadFilesResult> {
  const files = [...(fileList ?? [])];
  const accepted = files.filter((file) => isAcceptedFile(file.name));
  const decoded = await Promise.all(
    accepted.map(async (file) => ({ file, ...decodeText(await file.arrayBuffer()) })),
  );
  return {
    inputs: decoded.map(({ file, text }) => ({ id: createId(), title: file.name, text })),
    skipped: files.length - accepted.length,
    guessedShiftJis: decoded
      .filter(({ encoding }) => encoding === 'shift_jis')
      .map(({ file }) => file.name),
  };
}
