import { describe, expect, it } from 'vitest';
import type { GitHubTreeEntry } from '../types';
import {
  BATCH_WARN_BYTES,
  BATCH_WARN_FILES,
  emptyTreeSelection,
  hasAnySelection,
  includedSelectionRoots,
  isPathSelected,
  planBatch,
  selectionMark,
  selectionMayContainSelected,
  setTreeSelection,
  summarizeExcluded,
  summarizeKnownSelection,
} from './githubSelection';

function file(path: string, size: number | null = 10): GitHubTreeEntry {
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

describe('遅延読み込みする tree の選択', () => {
  it('未展開のフォルダを選ぶと、あとで開いた配下も選ばれている', () => {
    const selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    expect(isPathSelected(selected, 'chapters')).toBe(true);
    expect(isPathSelected(selected, 'chapters/one/ch1.md')).toBe(true);
    expect(selectionMark(selected, 'chapters')).toBe('checked');
  });

  it('配下を外すと、選んだ親は mixed になる', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    expect(isPathSelected(selected, 'chapters/live.md')).toBe(true);
    expect(isPathSelected(selected, 'chapters/drafts/old.md')).toBe(false);
    expect(selectionMark(selected, 'chapters')).toBe('mixed');
    expect(selectionMark(selected, 'chapters/drafts')).toBe('unchecked');
  });

  it('mixed の親を選び直すと、配下の上書きを消す', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    selected = setTreeSelection(selected, 'chapters', true);
    expect(selectionMark(selected, 'chapters')).toBe('checked');
    expect(isPathSelected(selected, 'chapters/drafts/old.md')).toBe(true);
    expect(selected.rules).toEqual(new Map([['chapters', true]]));
  });

  it('選んでいない親の下で子を選ぶと、親は mixed になる', () => {
    const selected = setTreeSelection(emptyTreeSelection(), 'chapters/ch1.md', true);
    expect(selectionMark(selected, 'chapters')).toBe('mixed');
    expect(isPathSelected(selected, 'chapters/ch1.md')).toBe(true);
    expect(isPathSelected(selected, 'chapters/ch2.md')).toBe(false);
  });

  it('文字列の前方一致ではなく、パスの区切り単位で照合する', () => {
    const selected = setTreeSelection(emptyTreeSelection(), 'a', true);
    expect(isPathSelected(selected, 'a/ch1.md')).toBe(true);
    expect(isPathSelected(selected, 'ab/ch1.md')).toBe(false);
    expect(selectionMayContainSelected(selected, 'ab')).toBe(false);
  });

  it('外した部分木の中で、より具体的なパスを選び直せる', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    selected = setTreeSelection(selected, 'chapters/drafts/keep.md', true);
    expect(isPathSelected(selected, 'chapters/drafts/old.md')).toBe(false);
    expect(isPathSelected(selected, 'chapters/drafts/keep.md')).toBe(true);
    expect(selectionMark(selected, 'chapters/drafts')).toBe('mixed');
    expect(selectionMark(selected, 'chapters')).toBe('mixed');
  });

  it('ルートを選んで外すと、規則は何も残らない', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters/drafts', true);
    selected = setTreeSelection(selected, '', true);
    expect(selected.rules).toEqual(new Map([['', true]]));
    selected = setTreeSelection(selected, '', false);
    expect(selected.rules.size).toBe(0);
  });

  it('列挙の起点は、ほかの「選ぶ」規則に含まれない最小の組だけ', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    selected = setTreeSelection(selected, 'chapters/drafts/keep.md', true);
    selected = setTreeSelection(selected, 'appendix', true);

    expect(includedSelectionRoots(selected)).toEqual(['appendix', 'chapters']);
  });

  it('選ばれていない枝は刈り込み、明示的に選んだ子孫がある枝は辿る', () => {
    let selected = emptyTreeSelection();
    expect(hasAnySelection(selected)).toBe(false);
    selected = setTreeSelection(selected, 'chapters/drafts/ch1.md', true);
    expect(hasAnySelection(selected)).toBe(true);
    expect(selectionMayContainSelected(selected, 'chapters')).toBe(true);
    expect(selectionMayContainSelected(selected, 'chapters/drafts')).toBe(true);
    expect(selectionMayContainSelected(selected, 'images')).toBe(false);
  });

  it('外す規則だけなら、何も選んでいない扱いになる', () => {
    let selected = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selected = setTreeSelection(selected, 'chapters/drafts', false);
    selected = setTreeSelection(selected, 'chapters', false);
    expect(hasAnySelection(selected)).toBe(false);
  });

  it('__proto__ のような名前のフォルダも、ほかの名前と同じように選べる', () => {
    const selected = setTreeSelection(emptyTreeSelection(), '__proto__', true);
    expect(isPathSelected(selected, '__proto__/ch1.md')).toBe(true);
    expect(selectionMark(selected, '__proto__')).toBe('checked');
    expect(includedSelectionRoots(selected)).toEqual(['__proto__']);
    // 規則に無い名前は、Object.prototype の値を拾わずに未選択のまま。
    expect(isPathSelected(emptyTreeSelection(), 'constructor/ch1.md')).toBe(false);
  });

  it('既知の件数は、読み込み済みの取り込める項目だけを数え、同じパスは1回にする', () => {
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
        file('chapters/ch3.md', null),
        unsupported,
        file('other.md', 30),
      ]),
    ).toEqual({ files: 3, directories: 2, bytes: 30 });
  });
});

describe('取得前の計画', () => {
  it('件数と、大きさの分かる分の合計を出す', () => {
    expect(planBatch([file('a.md', 10), file('b.md', 20)])).toEqual({
      files: 2,
      bytes: 30,
      unknownSizes: 0,
      warnings: [],
    });
  });

  it('大きさ不明の項目があれば、既知の合計が小さくても警告する', () => {
    expect(planBatch([file('a.md', 10), file('b.md', null), file('c.md', null)])).toEqual({
      files: 3,
      bytes: 10,
      unknownSizes: 2,
      warnings: [{ kind: 'unknownSize', files: 2 }],
    });
  });

  it('しきい値ちょうどまでは警告しない', () => {
    const entries = Array.from({ length: BATCH_WARN_FILES - 1 }, (_, index) =>
      file(`f${index}.md`, 0),
    );
    entries.push(file('big.md', BATCH_WARN_BYTES));
    expect(entries).toHaveLength(BATCH_WARN_FILES);
    expect(planBatch(entries).warnings).toEqual([]);
  });

  it('件数と容量がしきい値を超えたら、それぞれ警告する', () => {
    const entries = Array.from({ length: BATCH_WARN_FILES + 1 }, (_, index) =>
      file(`f${index}.md`, 0),
    );
    entries.push(file('big.md', BATCH_WARN_BYTES + 1));
    expect(planBatch(entries).warnings).toEqual([
      { kind: 'requests', files: BATCH_WARN_FILES + 2 },
      { kind: 'storage', bytes: BATCH_WARN_BYTES + 1 },
    ]);
  });
});

describe('対象外の項目の内訳', () => {
  it('種類ごとに決まった順で数え、フォルダと取り込める項目は数えない', () => {
    const at = (path: string, status: GitHubTreeEntry['status']): GitHubTreeEntry => ({
      name: path,
      path,
      sha: 'x',
      status,
      size: 1,
    });
    expect(
      summarizeExcluded([
        at('a.png', 'unsupported'),
        at('sub', 'submodule'),
        at('b.rst', 'unsupported'),
        at('c.md', 'importable'),
        at('d', 'dir'),
      ]),
    ).toEqual([
      { status: 'unsupported', count: 2 },
      { status: 'submodule', count: 1 },
    ]);
    expect(summarizeExcluded([])).toEqual([]);
  });
});
