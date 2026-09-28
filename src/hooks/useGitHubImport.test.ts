import { describe, expect, it } from 'vitest';
import { GitHubBlobTooLargeError, type GitHubClient } from '../github/client';
import { emptyTreeSelection, setTreeSelection } from '../lib/githubSelection';
import { MAX_IMPORT_TOTAL_BYTES, MAX_INPUT_BYTES } from '../lib/inputLimits';
import type { GitHubRepository, GitHubSnapshot, GitHubTreeEntry } from '../types';
import {
  enumerateSelectedEntries,
  fetchBatchCandidates,
  GitHubBatchPreparationError,
} from './useGitHubImport';

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

    const { files } = await enumerateSelectedEntries(
      api,
      SNAPSHOT,
      selection,
      new Map([['chapters', entry('chapters', 'dir', SHA_C)]]),
      new AbortController().signal,
    );

    expect(calls).toEqual(['chapters']);
    expect(files.map((item) => item.path)).toEqual(['chapters/ch1.md', 'chapters/ch2.txt']);
  });

  it('選択範囲にある取り込めない項目は、捨てずに対象外として返す', async () => {
    const api = client({
      getTreeRecursive: async () => ({
        entries: [
          entry('chapters/ch1.md'),
          entry('chapters/cover.png', 'unsupported'),
          entry('chapters/link.md', 'symlink'),
          entry('chapters/sub', 'dir'),
        ],
        truncated: false,
      }),
    });
    const selection = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    const found = await enumerateSelectedEntries(
      api,
      SNAPSHOT,
      selection,
      new Map([['chapters', entry('chapters', 'dir', SHA_C)]]),
      new AbortController().signal,
    );
    expect(found.files.map((item) => item.path)).toEqual(['chapters/ch1.md']);
    // フォルダ自体は対象外に数えない。
    expect(found.excluded.map((item) => [item.path, item.status])).toEqual([
      ['chapters/cover.png', 'unsupported'],
      ['chapters/link.md', 'symlink'],
    ]);
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

    const { files } = await enumerateSelectedEntries(
      api,
      SNAPSHOT,
      selection,
      new Map([['chapters', entry('chapters', 'dir', SHA_C)]]),
      new AbortController().signal,
    );

    expect(recursiveCalls).toEqual(['chapters']);
    expect(directCalls).toEqual(['chapters']);
    expect(files.map((item) => item.path)).toEqual(['chapters/ch1.md', 'chapters/ch2.txt']);
  });
  it('除外した部分木の下で選び直したファイルも、truncated の fallback で拾う', async () => {
    const api = client({
      getTreeRecursive: async () => ({ entries: [], truncated: true }),
      getTree: async (_snapshot, _sha, dir) => {
        if (dir === 'chapters') {
          return {
            entries: [entry('chapters/drafts', 'dir', SHA_A), entry('chapters/live.md')],
            truncated: false,
          };
        }
        return {
          entries: [entry('chapters/drafts/old.md'), entry('chapters/drafts/keep.md')],
          truncated: false,
        };
      },
    });
    let selection = setTreeSelection(emptyTreeSelection(), 'chapters', true);
    selection = setTreeSelection(selection, 'chapters/drafts', false);
    selection = setTreeSelection(selection, 'chapters/drafts/keep.md', true);

    const { files } = await enumerateSelectedEntries(
      api,
      SNAPSHOT,
      selection,
      new Map([['chapters', entry('chapters', 'dir', SHA_C)]]),
      new AbortController().signal,
    );

    expect(files.map((item) => item.path)).toEqual(['chapters/drafts/keep.md', 'chapters/live.md']);
  });

  it('非再帰でも打ち切られた一覧は、途中までで成功させずに止める', async () => {
    const api = client({
      getTreeRecursive: async () => ({ entries: [], truncated: true }),
      getTree: async () => ({ entries: [entry('chapters/ch1.md')], truncated: true }),
    });
    const selection = setTreeSelection(emptyTreeSelection(), 'chapters', true);

    await expect(
      enumerateSelectedEntries(
        api,
        SNAPSHOT,
        selection,
        new Map([['chapters', entry('chapters', 'dir', SHA_C)]]),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(GitHubBatchPreparationError);
  });

  it('読み込んでいない場所の規則があれば、ルートから全体を辿り直さずに止める', async () => {
    const calls: string[] = [];
    const api = client({
      getTreeRecursive: async (_snapshot, _sha, dir) => {
        calls.push(dir);
        return { entries: [], truncated: false };
      },
    });
    const selection = setTreeSelection(emptyTreeSelection(), 'unknown', true);

    await expect(
      enumerateSelectedEntries(api, SNAPSHOT, selection, new Map(), new AbortController().signal),
    ).rejects.toBeInstanceOf(GitHubBatchPreparationError);
    expect(calls).toEqual([]);
  });

  it('ファイルを直接選んだ規則は、tree を取らずにそのまま候補にする', async () => {
    const calls: string[] = [];
    const api = client({
      getTreeRecursive: async (_snapshot, _sha, dir) => {
        calls.push(dir);
        return { entries: [], truncated: false };
      },
    });
    const selection = setTreeSelection(emptyTreeSelection(), 'ch1.md', true);

    const { files } = await enumerateSelectedEntries(
      api,
      SNAPSHOT,
      selection,
      new Map([['ch1.md', entry('ch1.md')]]),
      new AbortController().signal,
    );
    expect(files.map((item) => item.path)).toEqual(['ch1.md']);
    expect(calls).toEqual([]);
  });

  it('中断されていたら、次の tree を取りに行かない', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = client({
      getTreeRecursive: async () => {
        throw new Error('呼ばれないはず');
      },
    });
    const selection = setTreeSelection(emptyTreeSelection(), '', true);

    await expect(
      enumerateSelectedEntries(api, SNAPSHOT, selection, new Map(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchBatchCandidates', () => {
  /** パスごとに決まった大きさの本文を返す。要求された上限と回数を記録する。 */
  function blobs(sizes: Record<string, number>) {
    const requested: { sha: string; maxBytes: number }[] = [];
    const api = client({
      getBlob: async (_snapshot, sha, _signal, maxBytes) => {
        requested.push({ sha, maxBytes });
        const size = sizes[sha] ?? 0;
        if (size > maxBytes) throw new GitHubBlobTooLargeError(maxBytes);
        return new ArrayBuffer(size);
      },
    });
    return { api, requested };
  }

  const at = (path: string, sha: string): GitHubTreeEntry => ({
    ...entry(path, 'importable', sha),
    size: null,
  });

  it('1件ずつ上限付きで取り、全件を候補にする', async () => {
    const { api, requested } = blobs({ [SHA_A]: 3, [SHA_B]: 4 });
    const progress: string[] = [];
    const candidates = await fetchBatchCandidates(
      api,
      SNAPSHOT,
      [at('a.md', SHA_A), at('b.md', SHA_B)],
      new Map(),
      new AbortController().signal,
      (done, total) => progress.push(`${done}/${total}`),
    );
    expect(candidates.map((candidate) => candidate.size)).toEqual([3, 4]);
    expect(requested.every(({ maxBytes }) => maxBytes === MAX_INPUT_BYTES)).toBe(true);
    expect(progress).toEqual(['1/2', '2/2']);
  });

  it('1件が上限を超えたら、そのファイルを名指しして再試行の無い失敗にする', async () => {
    const { api } = blobs({ [SHA_A]: MAX_INPUT_BYTES + 1 });
    const result = fetchBatchCandidates(
      api,
      SNAPSHOT,
      [at('big/huge.md', SHA_A)],
      new Map(),
      new AbortController().signal,
      () => {},
    );
    await expect(result).rejects.toBeInstanceOf(GitHubBatchPreparationError);
    await expect(result).rejects.toThrow('big/huge.md は 5MB を超えるため取り込めません。');
  });

  it('1件ずつは上限内でも、合計が1回の上限を超えたら止める（大きさ不明の項目）', async () => {
    const half = MAX_IMPORT_TOTAL_BYTES / 2;
    const { api } = blobs({ [SHA_A]: half, [SHA_B]: half, [SHA_C]: 1 });
    const result = fetchBatchCandidates(
      api,
      SNAPSHOT,
      [at('a.md', SHA_A), at('b.md', SHA_B), at('c.md', SHA_C)],
      new Map(),
      new AbortController().signal,
      () => {},
    );
    await expect(result).rejects.toThrow('合計が 5MB を超える');
  });

  it('控えから使った分も合計に数え、取り直さない', async () => {
    const { api, requested } = blobs({ [SHA_B]: 1 });
    const cache = new Map([
      [JSON.stringify([REPOSITORY.id, SHA_A]), new ArrayBuffer(MAX_IMPORT_TOTAL_BYTES)],
    ]);
    const result = fetchBatchCandidates(
      api,
      SNAPSHOT,
      [at('a.md', SHA_A), at('b.md', SHA_B)],
      cache,
      new AbortController().signal,
      () => {},
    );
    await expect(result).rejects.toThrow('合計が 5MB を超える');
    expect(requested.map(({ sha }) => sha)).toEqual([SHA_B]);
  });
});
