import type { Group, InputText, PersistedWorkspace, Rule, RuleOrder, Theme } from '../types';
import { createGroupId, createId, isUsableId } from './id';
import { STORAGE_CONFIRM_CODE_UNITS } from './inputLimits';
import { normalizeInputSource } from './inputSource';

/** 永続化キー。スキーマを壊す変更をしたら末尾の版を上げること。 */
export const STORAGE_KEY = 'bt-bulk-replace-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  // 配列も typeof 'object' なので明示的に外す。外さないと `[]` が
  // 「全項目が既定値のオブジェクト」として通り、空の行が復元されてしまう。
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * グループID → 置換先。文字列でない値は落とす。
 *
 * `renamed` は、使えない ID だったために振り直したグループの対応（保存データの ID → 新しい ID）。
 * 置換先はその新しい ID へ付け替え、グループとの対応を切らない。それ以外の使えない ID の
 * キーは、対応するグループが無いので落とす（辞書に `__proto__` などを持ち込まない）。
 */
function normalizeValues(
  value: unknown,
  renamed: ReadonlyMap<string, string>,
): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, string]> = [];
  // Object.entries は自身のプロパティだけを返す（JSON.parse は `__proto__` も自身の
  // プロパティとして作る）。代入ではなく fromEntries で作り、`__proto__` の setter を通さない。
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') continue;
    const id = renamed.get(key) ?? key;
    if (isUsableId(id)) entries.push([id, entry]);
  }
  return Object.fromEntries(entries);
}

function normalizeInput(value: unknown): InputText | null {
  if (!isRecord(value)) return null;
  const input: InputText = {
    // 空の ID は normalizeList が振り直す（ここで振ると、置換先の付け替えに記録されない）。
    id: asString(value.id),
    title: asString(value.title),
    text: asString(value.text),
  };
  // 出自が壊れていても本文は利用者の原稿なので、入力は残して出自だけ落とす。
  // 古い保存データには無い（＝手入力・ローカルファイル扱い）。
  const source = normalizeInputSource(value.source);
  if (source) input.source = source;
  return input;
}

function normalizeGroup(value: unknown): Group | null {
  if (!isRecord(value)) return null;
  // 空の ID もここでは振り直さず、normalizeList に任せる。以前の ID 生成は空文字を作り得たので、
  // `rule.values['']` に置換先が残っていることがある。ここで振ると対応（renamed）に記録されず失う。
  return { id: asString(value.id), name: asString(value.name) };
}

function normalizeRule(value: unknown, renamed: ReadonlyMap<string, string>): Rule | null {
  if (!isRecord(value)) return null;
  const order: RuleOrder = value.order === 'seq' ? 'seq' : 'sim';
  return {
    // 空の ID は normalizeList が振り直す（ここで振ると、置換先の付け替えに記録されない）。
    id: asString(value.id),
    src: asString(value.src),
    regex: asBoolean(value.regex, false),
    cs: asBoolean(value.cs, true),
    order,
    values: normalizeValues(value.values, renamed),
  };
}

/**
 * 配列を正規化する。ID が重複した要素と、使えない ID（`isUsableId`）の要素には
 * 新しい ID を振り直す。
 *
 * ID は React のキーと `patchById` の同定に使うので、重複したまま復元すると
 * 1行編集したつもりが2行変わる・行が入れ替わるといった直しようのない挙動になる。
 * 重複したグループの ID を振り直すと `rule.values` の対応が切れるが、そもそも対応先が
 * 一意に決まらない状態なので、空の列として復元する方を選ぶ。
 *
 * 使えない ID は、最初に現れたものなら対応先が一意に決まるので `renamed` に記録する
 * （グループなら、呼び出し側がルールの置換先を新しい ID へ付け替える）。
 */
function normalizeList<T extends { id: string }>(
  value: unknown,
  normalize: (item: unknown) => T | null,
  createFallbackId: () => string,
  renamed?: Map<string, string>,
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = normalize(item);
    if (!normalized) continue;
    const original = normalized.id;
    if (seen.has(original)) {
      normalized.id = createFallbackId();
    } else if (!isUsableId(original)) {
      normalized.id = createFallbackId();
      renamed?.set(original, normalized.id);
    }
    seen.add(original);
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

/** 保存されている生の文字列。復旧UIが中身を退避させるために使う。 */
export function readRawWorkspace(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 消せない環境なら、どのみち書き込めていないので放置してよい。
  }
}

/**
 * localStorage の内容を読み込む。
 *
 * 形が壊れていても**描画や変換の途中で落ちない形に正規化**してから返す。
 * 以前は `Array.isArray` だけ見てキャストで素通ししていたため、要素に `text` が
 * 無いだけで起動時に例外になり、状態が永続化されている以上リロードしても
 * 直らない（復旧不能な）状態を作れた。
 *
 * 復元しても使えない場合（グループが1つも無い）は null を返し、呼び出し側が
 * 初期値にフォールバックする。
 */
/**
 * 外から来た値を、描画や変換の途中で落ちない形へ正規化する。
 *
 * localStorage とバックアップファイルの両方がここを通る。取り込み側で検証を
 * 緩めると、保存データ経由では防いだ壊れ方をファイル経由で作れてしまう。
 *
 * 復元しても使えない場合（グループが1つも無い）は null を返す。
 */
export function normalizeWorkspace(value: unknown): PersistedWorkspace | null {
  if (!isRecord(value)) return null;

  const renamedGroups = new Map<string, string>();
  const groups = normalizeList(value.groups, normalizeGroup, createGroupId, renamedGroups);
  // グループが無い状態は復元しても置換先を書く場所が無い。
  if (groups.length === 0) return null;

  return {
    inputs: normalizeList(value.inputs, normalizeInput, createId),
    groups,
    rules: normalizeList(value.rules, (item) => normalizeRule(item, renamedGroups), createId),
    theme: value.theme === 'dark' ? 'dark' : 'light',
    // 古い保存データには無いので、既定は「サンプルではない」。
    isSample: value.isSample === true,
  };
}

export function loadWorkspace(): PersistedWorkspace | null {
  const raw = readRawWorkspace();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeWorkspace(parsed);
}

/**
 * 保存する形。容量の見込み（`mayExceedStorage`）と実際の保存で同じものを使う。
 * `storage` イベントの値と比べるときも、この形どうしで比べる。
 */
export function serializeWorkspace(workspace: PersistedWorkspace): string {
  return JSON.stringify(workspace);
}

/**
 * 保存すると容量を超えそうか。取り込む前の確認に使う。
 *
 * 本文の文字数ではなく、保存する JSON の長さ（キーを含む UTF-16 のコード単位。
 * localStorage はこの単位で数える）で見る。改行や引用符はエスケープで長くなるので、
 * 文字数では足りない。超えなくても保存に失敗することはあり（容量はブラウザ次第）、
 * そのときは `saveWorkspace` の失敗として出したままの警告になる。
 */
export function mayExceedStorage(workspace: PersistedWorkspace): boolean {
  return STORAGE_KEY.length + serializeWorkspace(workspace).length > STORAGE_CONFIRM_CODE_UNITS;
}

/**
 * 保存する。書けたら書いた文字列を、書けなければ null を返す。
 *
 * 書いた文字列は、`storage` イベントで届いた値が自分の書いたものか（他のタブが書いたか）を
 * 見分けるのに使う（`isForeignWorkspaceChange`）。
 */
export function writeWorkspace(workspace: PersistedWorkspace): string | null {
  try {
    const raw = serializeWorkspace(workspace);
    localStorage.setItem(STORAGE_KEY, raw);
    return raw;
  } catch {
    return null;
  }
}

/**
 * 保存する。書けたかどうかを返す。
 *
 * 以前は失敗を握り潰していた。容量超過（localStorage は数MBで打ち止め）に達しても
 * 画面は何も言わず、保存されないまま編集が続き、リロードした時点でその間の作業が
 * 消える。呼び出し側が気づけるように結果を返す。
 */
export function saveWorkspace(workspace: PersistedWorkspace): boolean {
  return writeWorkspace(workspace) !== null;
}

/**
 * 保存データをいま読んだ値。読めない環境（localStorage が例外を投げる）なら null。
 * `readRawWorkspace` と違い「保存データが無い」（`raw: null`）と「読めない」を分ける。
 * 読めないのを「無い」と取り違えると、別のタブが消したと誤って判定する。
 */
export function peekWorkspace(): { raw: string | null } | null {
  try {
    return { raw: localStorage.getItem(STORAGE_KEY) };
  } catch {
    return null;
  }
}

/** `storage` イベントのうち、判定に使う部分。 */
export interface StorageChange {
  /** 変わったキー。`localStorage.clear()` なら null。 */
  key: string | null;
  newValue: string | null;
}

/**
 * 保存データの値が、このタブの知らない値か（他のタブが書いた・消した）。
 *
 * `known` は、このタブが「保存データはこれのはず」と分かっている値。書いたあとは書いた文字列、
 * 起動時は読んだ生の文字列と、それを今の形で保存し直した文字列の両方（別のタブが同じ内容を
 * 今の形で書き直しただけで食い違いにしない）。
 */
export function isForeignWorkspaceValue(
  value: string | null,
  known: readonly (string | null)[],
): boolean {
  return !known.includes(value);
}

/**
 * `storage` イベントが、他のタブによる作業データの書き換えか。
 *
 * `storage` イベントは書いたタブ自身には届かず、同じオリジンの他のタブにだけ届く。
 * 届いた値がこのタブの知っている値（`known`）なら、中身は食い違っていない（別のタブが
 * 同じ内容を書いただけ）ので数えない。数えると、片方のタブが読み込んだ内容をそのまま
 * 書き戻しただけで、もう片方に「更新されました」が出続ける。
 * `clear()`（キーが null）は作業データも消すので、消えた値（null）として比べる。
 */
export function isForeignWorkspaceChange(
  change: StorageChange,
  known: readonly (string | null)[],
): boolean {
  if (change.key !== null && change.key !== STORAGE_KEY) return false;
  return isForeignWorkspaceValue(change.key === null ? null : change.newValue, known);
}

/** OS のダークモード設定を初期テーマとして使う。 */
export function preferredTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
