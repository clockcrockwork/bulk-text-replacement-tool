import type { InputText } from '../types';
import { createId } from './id';
import { formatLimit, MAX_IMPORT_TOTAL_BYTES, MAX_INPUT_BYTES } from './inputLimits';
import { revealUnsafeChars } from './revealText';
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

/** 大きさだけで決められる、読む前の振り分け。 */
export interface FileImportPlan<T> {
  /** 読んで取り込むファイル。`overTotal` なら読まない。 */
  accepted: T[];
  /** 拡張子が対象外でスキップする件数。 */
  unsupported: number;
  /** 1ファイルの上限（`MAX_INPUT_BYTES`）を超えるため読まないファイル。 */
  tooLarge: T[];
  /** `accepted` の合計バイト数。 */
  totalBytes: number;
  /** 合計が1回の取り込みの上限を超えている。1件も読まない。 */
  overTotal: boolean;
}

/**
 * 選ばれたファイルを、中身を読む前に大きさで振り分ける。
 *
 * `File.size` は読まずに分かるので、上限を超えるものは `arrayBuffer()` も decode も
 * しない（読んでから断ると、断る前にタブが止まる・落ちる）。上限を超える1件だけを
 * 外して残りは取り込むが、合計が上限を超えたときは、どれを残すかを決められないので
 * 1件も読まない。
 */
export function planFileImport<T extends { name: string; size: number }>(
  files: readonly T[],
): FileImportPlan<T> {
  const supported = files.filter((file) => isAcceptedFile(file.name));
  const accepted = supported.filter((file) => file.size <= MAX_INPUT_BYTES);
  const totalBytes = accepted.reduce((sum, file) => sum + file.size, 0);
  return {
    accepted,
    unsupported: files.length - supported.length,
    tooLarge: supported.filter((file) => file.size > MAX_INPUT_BYTES),
    totalBytes,
    overTotal: totalBytes > MAX_IMPORT_TOTAL_BYTES,
  };
}

export interface ReadFilesResult {
  inputs: InputText[];
  /** 拡張子が対象外でスキップした件数。 */
  skipped: number;
  /** 1ファイルの上限を超えたため読まなかったファイル名。 */
  tooLarge: string[];
  /** 合計が1回の取り込みの上限を超えたため、1件も読まなかったときの合計バイト数。 */
  overTotalBytes: number | null;
  /** UTF-8 として読めず Shift_JIS とみなしたファイル名。推測なので画面で知らせる。 */
  guessedShiftJis: string[];
  /**
   * 読めなかったファイル名（クラウド上にしか無くて未ダウンロード、選んだあとで変わった・
   * 消えた、など）。1件でもあれば、ほかのファイルも取り込まない（`inputs` は空）。
   */
  unreadable: string[];
}

/** ドロップ／選択されたファイルを読み込んで入力テキストに変換する。BOM は落とす。 */
export async function readInputFiles(fileList: FileList | File[] | null): Promise<ReadFilesResult> {
  const plan = planFileImport([...(fileList ?? [])]);
  const tooLarge = plan.tooLarge.map((file) => file.name);
  if (plan.overTotal) {
    return {
      inputs: [],
      skipped: plan.unsupported,
      tooLarge,
      overTotalBytes: plan.totalBytes,
      guessedShiftJis: [],
      unreadable: [],
    };
  }
  // 1件の失敗で残りを待たずに投げると、どれが読めなかったか分からないうえ、呼び出し側で
  // 受けなければ未処理の reject になる。全件の成否をそろえてから決める。
  // 読めたものだけを取り込むことはしない。選んだ一式の一部だけが入ると、欠けたことに
  // 気づかないまま変換・書き出しまで進みやすい（合計の超過と同じく、1件も取り込まない）。
  const settled = await Promise.allSettled(
    plan.accepted.map(async (file) => ({ file, ...decodeText(await file.arrayBuffer()) })),
  );
  const unreadable = plan.accepted
    .filter((_, index) => settled[index]?.status !== 'fulfilled')
    .map((file) => file.name);
  if (unreadable.length > 0) {
    return {
      inputs: [],
      skipped: plan.unsupported,
      tooLarge,
      overTotalBytes: null,
      guessedShiftJis: [],
      unreadable,
    };
  }
  const decoded = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  return {
    inputs: decoded.map(({ file, text }) => ({ id: createId(), title: file.name, text })),
    skipped: plan.unsupported,
    tooLarge,
    overTotalBytes: null,
    guessedShiftJis: decoded
      .filter(({ encoding }) => encoding === 'shift_jis')
      .map(({ file }) => file.name),
    unreadable: [],
  };
}

/**
 * 読めなかったファイルの知らせ。1件なら名前を出す。
 * 読めた分も取り込んでいないことを添える（一部だけ入ったと思わせない）。
 */
export function describeUnreadableFiles(names: readonly string[]): string {
  const subject =
    names.length === 1
      ? `${revealUnsafeChars(names[0] ?? '')} を`
      : `${names.length}件のファイルを`;
  return `${subject}読み込めなかったため、1件も取り込みませんでした。ファイルが端末に保存されているか確かめて、選び直してください`;
}

/**
 * 上限を超えたため読まなかったファイルの知らせ。無ければ null。
 *
 * 読まずに外しているので、黙っていると欠けたまま取り込みが成功したように見える。
 * 1件なら名前を出す（どれが外れたか分かるように）。
 */
export function describeTooLargeFiles(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const subject =
    names.length === 1 ? `${revealUnsafeChars(names[0] ?? '')} は` : `${names.length}件は`;
  return `${subject} ${formatLimit(MAX_INPUT_BYTES)} を超えるため取り込みませんでした`;
}
