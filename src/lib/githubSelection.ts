import type { GitHubTreeEntry } from '../types';
import { compareCodePoints } from './githubApi';

/**
 * 遅延読み込みする tree の選択。
 *
 * 選んだパスを「規則」として持ち、規則はそのパスと配下すべてに効く。いちばん具体的な
 * 祖先の規則が勝つ。配下を列挙せずに規則だけを持つので、まだ開いていないフォルダも
 * 選べる。あとから子を外すと、親は mixed になる。
 *
 * パスはリポジトリ内の任意の名前なので、素のオブジェクトのキーにはしない
 * （`__proto__` という名前のフォルダが選べなくなる）。
 */
export interface GitHubTreeSelection {
  rules: ReadonlyMap<string, boolean>;
}

export type GitHubSelectionMark = 'checked' | 'mixed' | 'unchecked';

export function emptyTreeSelection(): GitHubTreeSelection {
  return { rules: new Map() };
}

/** 文字列の前方一致ではなく、パスの区切り単位で比べる（`a` は `ab` を含まない）。 */
function isSameOrDescendant(path: string, root: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const result = [''];
  for (let index = 0; index < parts.length; index += 1) {
    result.push(parts.slice(0, index + 1).join('/'));
  }
  return result;
}

/** 未展開の祖先から受け継いだ分も含めて、そのパスが選ばれているか。 */
export function isPathSelected(selection: GitHubTreeSelection, path: string): boolean {
  let selected = false;
  for (const ancestor of ancestors(path)) {
    const rule = selection.rules.get(ancestor);
    if (rule !== undefined) selected = rule;
  }
  return selected;
}

/**
 * 部分木をまるごと選ぶ／外す。
 *
 * 明示的な操作で部分木の状態を置き換えるので、配下の上書き規則は消す。親から受け継ぐ
 * 値と同じなら、そのパスの規則も要らない（規則を最小に保ち、操作を重ねても膨らませない）。
 */
export function setTreeSelection(
  selection: GitHubTreeSelection,
  path: string,
  selected: boolean,
): GitHubTreeSelection {
  const next = new Map<string, boolean>();
  for (const [rulePath, value] of selection.rules) {
    if (!isSameOrDescendant(rulePath, path)) next.set(rulePath, value);
  }

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const inherited = path === '' ? false : isPathSelected({ rules: next }, parent);
  if (selected !== inherited) next.set(path, selected);
  return { rules: next };
}

/** そのディレクトリの配下に、選ばれたパスがあり得るか。辿る範囲を刈り込むのに使う。 */
export function selectionMayContainSelected(selection: GitHubTreeSelection, path: string): boolean {
  if (isPathSelected(selection, path)) return true;
  for (const [rulePath, selected] of selection.rules) {
    if (selected && rulePath !== path && isSameOrDescendant(rulePath, path)) return true;
  }
  return false;
}

export function hasAnySelection(selection: GitHubTreeSelection): boolean {
  for (const selected of selection.rules.values()) {
    if (selected) return true;
  }
  return false;
}

/**
 * 列挙の起点にする「選ぶ」規則。ほかの「選ぶ」規則の配下にあるものは省く。
 *
 * 外した部分木の下で選び直したパスも、選ばれた祖先があれば起点を増やさなくてよい。
 * 列挙のあとで、いちばん具体的な規則で最終的に絞り込むので。
 */
export function includedSelectionRoots(selection: GitHubTreeSelection): string[] {
  const included = [...selection.rules]
    .filter(([, selected]) => selected)
    .map(([path]) => path)
    .sort((a, b) => a.split('/').length - b.split('/').length || compareCodePoints(a, b));
  const roots: string[] = [];
  for (const path of included) {
    if (roots.some((root) => isSameOrDescendant(path, root))) continue;
    roots.push(path);
  }
  return roots;
}

export function selectionMark(selection: GitHubTreeSelection, path: string): GitHubSelectionMark {
  const selected = isPathSelected(selection, path);
  for (const rulePath of selection.rules.keys()) {
    if (rulePath === path || !isSameOrDescendant(rulePath, path)) continue;
    if (isPathSelected(selection, rulePath) !== selected) return 'mixed';
  }
  return selected ? 'checked' : 'unchecked';
}

export interface KnownSelectionSummary {
  files: number;
  directories: number;
  bytes: number;
}

/**
 * 読み込み済みの項目だけで数える。まだ開いていないフォルダの中身は数えられないので、
 * 正確な件数は列挙のあと（`planBatch`）で出す。
 */
export function summarizeKnownSelection(
  selection: GitHubTreeSelection,
  entries: Iterable<GitHubTreeEntry>,
): KnownSelectionSummary {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    if (entry.status === 'dir') {
      if (selectionMark(selection, entry.path) === 'checked') directories += 1;
      continue;
    }
    if (entry.status !== 'importable' || !isPathSelected(selection, entry.path)) continue;
    files += 1;
    if (entry.size !== null) bytes += entry.size;
  }
  return { files, directories, bytes };
}

// ---- 取得前の計画 --------------------------------------------------------------

/**
 * これを超えたら、取得前に GitHub API の消費を知らせる。blob は1件1リクエストで、
 * ユーザーのトークンは通常 1時間 5,000 リクエストまで。
 */
export const BATCH_WARN_FILES = 200;

/**
 * これを超えたら、ブラウザへの保存に失敗し得ることを知らせる。localStorage は
 * 数MBで打ち止めになり、取り込んだ本文はそこへ丸ごと入る。
 */
export const BATCH_WARN_BYTES = 2 * 1024 * 1024;

export type BatchWarning =
  | { kind: 'requests'; files: number }
  | { kind: 'storage'; bytes: number }
  /**
   * 大きさを事前に確かめられない項目がある。表示する合計は下限にすぎず、既知の分が
   * しきい値未満でも実際には大きくなり得るので、容量の警告とは別に必ず知らせる。
   */
  | { kind: 'unknownSize'; files: number };

export interface BatchPlanSummary {
  files: number;
  /** tree が大きさを返した分の合計。大きさ不明の項目があれば下限。 */
  bytes: number;
  /** 大きさの分からない項目の数。0 でなければ合計は下限。 */
  unknownSizes: number;
  warnings: BatchWarning[];
}

/** 列挙が終わった時点で、blob を取る前に見せる件数・容量・警告。 */
export function planBatch(entries: readonly GitHubTreeEntry[]): BatchPlanSummary {
  let bytes = 0;
  let unknownSizes = 0;
  for (const entry of entries) {
    if (entry.size === null) unknownSizes += 1;
    else bytes += entry.size;
  }
  const warnings: BatchWarning[] = [];
  if (entries.length > BATCH_WARN_FILES) warnings.push({ kind: 'requests', files: entries.length });
  if (bytes > BATCH_WARN_BYTES) warnings.push({ kind: 'storage', bytes });
  if (unknownSizes > 0) warnings.push({ kind: 'unknownSize', files: unknownSizes });
  return { files: entries.length, bytes, unknownSizes, warnings };
}
