import { describe, expect, it } from 'vitest';
import type { GitHubTreeEntry } from '../types';
import {
  emptyTreeSelection,
  hasAnySelection,
  includedSelectionRoots,
  isPathSelected,
  selectionMark,
  selectionMayContainSelected,
  setTreeSelection,
  summarizeKnownSelection,
} from './githubSelection';

function file(path: string, size = 10): GitHubTreeEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha: 'a'.repeat(40),
    status: 'importable',
    size,
  };
}

function directory(path: string): GitHubTreeEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha: 'b'.repeat(40),
    status: 'dir',
    size: null,
  };
}

describe('GitHub lazy tree selection', () => {
  it('selects an unopened directory conceptually and later children inherit it', () => {
    const selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    expect(isPathSelected(selected, 'chapters')).toBe(true);
    expect(isPathSelected(selected, 'chapters/one/ch1.md')).toBe(true);
    expect(selectionMark(selected, 'chapters')).toBe('checked');
  });

  it('a descendant exclusion makes the selected parent mixed', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    expect(isPathSelected(selected, 'chapters/live.md')).toBe(true);
    expect(isPathSelected(selected, 'chapters/drafts/old.md')).toBe(false);
    expect(selectionMark(selected, 'chapters')).toBe('mixed');
    expect(selectionMark(selected, 'chapters/drafts')).toBe('unchecked');
  });

  it('reselecting a mixed parent clears descendant overrides', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    selected = setTreeSelection(selected, 'chapters', true);
    expect(selectionMark(selected, 'chapters')).toBe('checked');
    expect(isPathSelected(selected, 'chapters/drafts/old.md')).toBe(true);
    expect(selected.rules).toEqual({ chapters: true });
  });

  it('selecting a child below an unselected parent makes the parent mixed', () => {
    const selected = setTreeSelection(emptyTreeSelection(), 'chapters/ch1.md', true);
    expect(selectionMark(selected, 'chapters')).toBe('mixed');
    expect(isPathSelected(selected, 'chapters/ch1.md')).toBe(true);
    expect(isPathSelected(selected, 'chapters/ch2.md')).toBe(false);
  });

  it('matches path segments, not string prefixes', () => {
    const selected = setTreeSelection(emptyTreeSelection(), 'a', true);
    expect(isPathSelected(selected, 'a/ch1.md')).toBe(true);
    expect(isPathSelected(selected, 'ab/ch1.md')).toBe(false);
    expect(selectionMayContainSelected(selected, 'ab')).toBe(false);
  });

  it('can exclude a subtree and re-include a more specific descendant', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    selected = setTreeSelection(selected, 'chapters/drafts/keep.md', true);
    expect(isPathSelected(selected, 'chapters/drafts/old.md')).toBe(false);
    expect(isPathSelected(selected, 'chapters/drafts/keep.md')).toBe(true);
    expect(selectionMark(selected, 'chapters/drafts')).toBe('mixed');
    expect(selectionMark(selected, 'chapters')).toBe('mixed');
  });

  it('uses only minimal include roots for enumeration', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    selected = setTreeSelection(selected, 'chapters/drafts/keep.md', true);
    selected = setTreeSelection(selected, 'appendix', true);

    expect(includedSelectionRoots(selected)).toEqual(['appendix', 'chapters']);
  });

  it('prunes unselected branches but follows an explicitly selected descendant', () => {
    let selected = emptyTreeSelection();
    expect(hasAnySelection(selected)).toBe(false);
    selected = setTreeSelection(selected, 'chapters/drafts/ch1.md', true);
    expect(hasAnySelection(selected)).toBe(true);
    expect(selectionMayContainSelected(selected, 'chapters')).toBe(true);
    expect(selectionMayContainSelected(selected, 'chapters/drafts')).toBe(true);
    expect(selectionMayContainSelected(selected, 'images')).toBe(false);
  });

  it('known summary counts only loaded importable selected files and dedupes paths', () => {
    const selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    const unsupported: GitHubTreeEntry = {
      ...file('chapters/image.png', 99),
      status: 'unsupported',
    };
    expect(
      summarizeKnownSelection(selected, [
        directory('chapters'),
        directory('chapters/drafts'),
        file('chapters/ch1.md', 10),
        file('chapters/ch1.md', 10),
        file('chapters/ch2.txt', 20),
        unsupported,
        file('other.md', 30),
      ]),
    ).toEqual({ files: 2, directories: 2, bytes: 30 });
  });
});
