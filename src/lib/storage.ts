import type { Group, InputText, PersistedWorkspace, Rule, RuleOrder, Theme } from '../types';
import { createGroupId, createId } from './id';
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

/** グループID → 置換先。文字列でない値は落とす。 */
function normalizeValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function normalizeInput(value: unknown): InputText | null {
  if (!isRecord(value)) return null;
  const input: InputText = {
    id: asString(value.id) || createId(),
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
  return { id: asString(value.id) || createGroupId(), name: asString(value.name) };
}

function normalizeRule(value: unknown): Rule | null {
  if (!isRecord(value)) return null;
  const order: RuleOrder = value.order === 'seq' ? 'seq' : 'sim';
  return {
    id: asString(value.id) || createId(),
    src: asString(value.src),
    regex: asBoolean(value.regex, false),
    cs: asBoolean(value.cs, true),
    order,
    values: normalizeValues(value.values),
  };
}

/**
 * 配列を正規化する。ID が重複した要素には新しい ID を振り直す。
 *
 * ID は React のキーと `patchById` の同定に使うので、重複したまま復元すると
 * 1行編集したつもりが2行変わる・行が入れ替わるといった直しようのない挙動になる。
 * グループの ID を振り直すと `rule.values` の対応が切れるが、そもそも対応先が
 * 一意に決まらない状態なので、空の列として復元する方を選ぶ。
 */
function normalizeList<T extends { id: string }>(
  value: unknown,
  normalize: (item: unknown) => T | null,
  createFallbackId: () => string,
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = normalize(item);
    if (!normalized) continue;
    if (seen.has(normalized.id)) normalized.id = createFallbackId();
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

  const groups = normalizeList(value.groups, normalizeGroup, createGroupId);
  // グループが無い状態は復元しても置換先を書く場所が無い。
  if (groups.length === 0) return null;

  return {
    inputs: normalizeList(value.inputs, normalizeInput, createId),
    groups,
    rules: normalizeList(value.rules, normalizeRule, createId),
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

/** 保存する形。容量の見込み（`mayExceedStorage`）と実際の保存で同じものを使う。 */
function serializeWorkspace(workspace: PersistedWorkspace): string {
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
 * 保存する。書けたかどうかを返す。
 *
 * 以前は失敗を握り潰していた。容量超過（localStorage は数MBで打ち止め）に達しても
 * 画面は何も言わず、保存されないまま編集が続き、リロードした時点でその間の作業が
 * 消える。呼び出し側が気づけるように結果を返す。
 */
export function saveWorkspace(workspace: PersistedWorkspace): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, serializeWorkspace(workspace));
    return true;
  } catch {
    return false;
  }
}

/** OS のダークモード設定を初期テーマとして使う。 */
export function preferredTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
