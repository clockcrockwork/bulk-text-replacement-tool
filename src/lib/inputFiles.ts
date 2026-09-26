import type { InputText } from '../types';
import { createId } from './id';

/** 取り込めるテキストファイルの拡張子。 */
export const ACCEPTED_EXTENSIONS = ['md', 'txt', 'tex'] as const;

/** `<input type="file">` の accept 属性。 */
export const ACCEPT_ATTRIBUTE = '.md,.txt,.tex,text/plain,text/markdown';

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
}

/** ドロップ／選択されたファイルを読み込んで入力テキストに変換する。BOM は落とす。 */
export async function readInputFiles(fileList: FileList | File[] | null): Promise<ReadFilesResult> {
  const files = [...(fileList ?? [])];
  const accepted = files.filter((file) => isAcceptedFile(file.name));
  const inputs = await Promise.all(
    accepted.map(async (file) => ({
      id: createId(),
      title: file.name,
      text: (await file.text()).replace(/^﻿/, ''),
    })),
  );
  return { inputs, skipped: files.length - accepted.length };
}
