import { describe, expect, it } from 'vitest';
import type { GitHubClient } from '../github/client';
import { emptyTreeSelection, setTreeSelection } from '../lib/githubSelection';
import type { GitHubRepository, GitHubSnapshot, GitHubTreeEntry } from '../types';
import { enumerateSelectedEntries, mapWithConcurrency } from './useGitHubImport';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const REPOSITORY: GitHubRepository = {
  id: 42,
  owner: 'octo',
  name: 'novel',
  defaultBranch: 'main',
  private: false,
};

const SNAPSHOT: GitHubSnapshot = {
  repository: REPOSITORY,
  ref: 'main',
  commitSha: SHA_A,
  treeSha: SHA_B,
};

function entry(
  path: string,
  status: GitHubTreeEntry['status'] = 'importable',
  sha = SHA_C,
): GitHubTreeEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha,
    status,
    size: status === 'dir' ? null : 10,
  };
}

function client(overrides: Partial<GitHubClient>): GitHubClient {
  return {
    listRepositories: async () => [],
    listBranches: async () => [],
    resolveSnapshot: async () => SNAPSHOT,
    getTree: async () => ({ entries: [], truncated: false }),
    getTreeRecursive: async () => ({ entries: [], truncated: false }),
    getBlob: async () => new ArrayBuffer(0),
    ...overrides,
  };
}

describe('enumerateSelectedEntries', () => {
  it('recursive fast path を使い、同じ path は1回だけ返す', async () => {
    const calls: string[] = [];
    const api = client({
      getTreeRecursive: async (_snapshot, _sha, dir) => {
        calls.push(dir);
        return {
          entries: [
            entry('chapters/ch1.md'),
            entry('chapters/ch1.md'),
            entry('chapters/ch2.txt'),
            entry('other.md'),
          ],
          truncated: false,
        };
      },
    });
    const selection = setTreeSelection(emptyTreeSelection(), 'chapters', true);

    const files = await enumerateSelectedEntries(
      api,
      SNAPSHOT,
      selection,
      { chapters: entry('chapters', 'dir', SHA_C) },
      new AbortController().signal,
    );

    expect(calls).toEqual(['chapters']);
    expect(files.map((item) => item.path)).toEqual(['chapters/ch1.md', 'chapters/ch2.txt']);
  });

  it('recursive response が truncated なら partial を捨てて非再帰 traversal へ fallback する', async () => {
    const recursiveCalls: string[] = [];
    const directCalls: string[] = [];
    const api = client({
      getTreeRecursive: async (_snapshot, _sha, dir) => {
        recursiveCalls.push(dir);
        return { entries: [entry('chapters/ch1.md')], truncated: true };
      },
      getTree: async (_snapshot, _sha, dir) => {
        directCalls.push(dir);
        return {
          entries: [entry('chapters/ch1.md'), entry('chapters/ch2.txt')],
          truncated: false,
        };
      },
    });
    const selection = setTreeSelection(emptyTreeSelection(), 'chapters', true);

    const files = await enumerateSelectedEntries(
      api,
      SNAPSHOT,
      selection,
      { chapters: entry('chapters', 'dir', SHA_C) },
      new AbortController().signal,
    );

    expect(recursiveCalls).toEqual(['chapters']);
    expect(directCalls).toEqual(['chapters']);
    expect(files.map((item) => item.path)).toEqual(['chapters/ch1.md', 'chapters/ch2.txt']);
  });
});

describe('mapWithConcurrency', () => {
  it('同時実行数を指定値以下に抑える', async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      2,
      new AbortController().signal,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      },
    );

    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('1件失敗したら新しい worker を始めず、実行中の worker も abort する', async () => {
    const started: number[] = [];
    const aborted: number[] = [];

    await expect(
      mapWithConcurrency(
        [1, 2, 3, 4, 5],
        2,
        new AbortController().signal,
        async (value, signal) => {
          started.push(value);
          if (value === 1) throw new Error('boom');
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 50);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                aborted.push(value);
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
          return value;
        },
      ),
    ).rejects.toThrow('boom');

    expect(started).toEqual([1, 2]);
    expect(aborted).toEqual([2]);
  });
});
