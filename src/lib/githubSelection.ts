import type { GitHubTreeEntry } from '../types';

/**
 * Lazy tree picker selection.
 *
 * A rule applies to its path and every descendant; the most specific ancestor rule wins.
 * This lets an unopened directory be selected without enumerating its descendants, while a
 * later child exclusion can make the parent mixed.
 */
export interface GitHubTreeSelection {
  rules: Readonly<Record<string, boolean>>;
}

export type GitHubSelectionMark = 'checked' | 'mixed' | 'unchecked';

export function emptyTreeSelection(): GitHubTreeSelection {
  return { rules: {} };
}

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

/** Whether a path is conceptually selected, including inheritance from an unopened ancestor. */
export function isPathSelected(selection: GitHubTreeSelection, path: string): boolean {
  let selected = false;
  for (const ancestor of ancestors(path)) {
    const rule = selection.rules[ancestor];
    if (typeof rule === 'boolean') selected = rule;
  }
  return selected;
}

/**
 * Set an entire subtree to selected/unselected.
 * Descendant overrides are removed because this explicit action replaces the subtree state.
 * If the requested value already matches the inherited parent value, the local rule is redundant.
 */
export function setTreeSelection(
  selection: GitHubTreeSelection,
  path: string,
  selected: boolean,
): GitHubTreeSelection {
  const next: Record<string, boolean> = {};
  for (const [rulePath, value] of Object.entries(selection.rules)) {
    if (!isSameOrDescendant(rulePath, path)) next[rulePath] = value;
  }

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const inherited = path === '' ? false : isPathSelected({ rules: next }, parent);
  if (selected !== inherited) next[path] = selected;
  return { rules: next };
}

/**
 * Directory checkbox state. A descendant override that differs from the directory's effective
 * state makes it mixed, even if that descendant has not been expanded in the current view.
 */
export function selectionMark(
  selection: GitHubTreeSelection,
  path: string,
): GitHubSelectionMark {
  const selected = isPathSelected(selection, path);
  for (const rulePath of Object.keys(selection.rules)) {
    if (rulePath === path || !isSameOrDescendant(rulePath, path)) continue;
    if (isPathSelected(selection, rulePath) !== selected) return 'mixed';
  }
  return selected ? 'checked' : 'unchecked';
}

export interface KnownSelectionSummary {
  files: number;
  bytes: number;
}

/** Count only importable entries that have actually been loaded; bulk enumeration resolves the rest. */
export function summarizeKnownSelection(
  selection: GitHubTreeSelection,
  entries: readonly GitHubTreeEntry[],
): KnownSelectionSummary {
  let files = 0;
  let bytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      entry.status !== 'importable' ||
      seen.has(entry.path) ||
      !isPathSelected(selection, entry.path)
    ) {
      continue;
    }
    seen.add(entry.path);
    files += 1;
    if (entry.size !== null) bytes += entry.size;
  }
  return { files, bytes };
}
