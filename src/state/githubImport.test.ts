import { describe, expect, it } from 'vitest';
import type { GitHubCandidate } from '../lib/githubApi';
import type { GitHubRepository, GitHubSnapshot } from '../types';
import {
  currentStep,
  type GitHubImportAction,
  type GitHubImportState,
  githubImportReducer,
  initialGitHubImportState,
} from './githubImport';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);

const REPO: GitHubRepository = {
  id: 42,
  owner: 'octo',
  name: 'novel',
  defaultBranch: 'main',
  private: false,
};
const OTHER_REPO: GitHubRepository = { ...REPO, id: 7, name: 'other' };

const SNAPSHOT: GitHubSnapshot = {
  repository: REPO,
  ref: 'main',
  commitSha: SHA_A,
  treeSha: SHA_B,
};
/** 同じブランチが進んだあとのスナップショット。 */
const MOVED: GitHubSnapshot = { repository: REPO, ref: 'main', commitSha: SHA_C, treeSha: SHA_D };

function candidate(commitSha = SHA_A, repositoryId = REPO.id): GitHubCandidate {
  return {
    source: {
      kind: 'github',
      repositoryId,
      owner: 'octo',
      repo: 'novel',
      ref: 'main',
      commitSha,
      path: 'ch1.md',
      blobSha: SHA_D,
    },
    title: 'ch1.md',
    text: '本文',
    encoding: 'utf-8',
    size: 6,
  };
}

function run(actions: GitHubImportAction[], from = initialGitHubImportState): GitHubImportState {
  return actions.reduce(githubImportReducer, from);
}

const PINNED = run([
  { type: 'open' },
  { type: 'connect/start' },
  { type: 'connect/done' },
  { type: 'repositories/loaded', repositories: [REPO, OTHER_REPO] },
  { type: 'repository/select', repository: REPO },
  { type: 'snapshot/pinned', snapshot: SNAPSHOT },
]);

describe('接続', () => {
  it('開く・接続する', () => {
    const state = run([{ type: 'open' }, { type: 'connect/start' }]);
    expect(state).toMatchObject({ open: true, connection: 'connecting' });
    expect(run([{ type: 'connect/done' }], state).connection).toBe('connected');
  });

  it('認可から引き返したら、接続中を未接続へ戻す（接続済みなら何もしない）', () => {
    const connecting = run([{ type: 'open' }, { type: 'connect/start' }]);
    expect(githubImportReducer(connecting, { type: 'connect/abandon' }).connection).toBe(
      'disconnected',
    );
    expect(githubImportReducer(PINNED, { type: 'connect/abandon' })).toBe(PINNED);
  });

  it('切断すると選んでいたものを捨て、知らせだけ残す（開いたまま）', () => {
    const state = githubImportReducer(PINNED, { type: 'disconnect', notice: '期限切れ' });
    expect(state).toEqual({ ...initialGitHubImportState, open: true, notice: '期限切れ' });
  });

  it('閉じても接続と場所は残す（続けて取り込める）。待ちとエラーは片付ける', () => {
    const busy = run([{ type: 'busy', label: '取得中' }], PINNED);
    const closed = githubImportReducer(busy, { type: 'close' });
    expect(closed).toMatchObject({ open: false, busy: null, connection: 'connected' });
    expect(closed.snapshot).toEqual(SNAPSHOT);
  });

  it('失敗と、その片付け', () => {
    const failed = run(
      [
        { type: 'busy', label: 'x' },
        { type: 'fail', error: { message: 'm', recover: 'retry' } },
      ],
      PINNED,
    );
    expect(failed).toMatchObject({ busy: null, error: { message: 'm' } });
    expect(githubImportReducer(failed, { type: 'error/dismiss' }).error).toBeNull();
  });
});

describe('ブランチの選択とコミットの固定', () => {
  it('固定するとルートを1段目にして一覧を待つ', () => {
    expect(PINNED.snapshot).toEqual(SNAPSHOT);
    expect(PINNED.trail).toEqual([{ path: '', treeSha: SHA_B }]);
    expect(PINNED.listing).toBeNull();
  });

  it('リポジトリを選び直すとスナップショットは捨てる', () => {
    const state = githubImportReducer(PINNED, {
      type: 'repository/select',
      repository: OTHER_REPO,
    });
    expect(state).toMatchObject({ repository: OTHER_REPO, snapshot: null, trail: [] });
    expect(githubImportReducer(PINNED, { type: 'repository/clear' }).repository).toBeNull();
  });

  it('待っているあいだに別のリポジトリへ移っていたら、遅れて返った固定は捨てる', () => {
    const moved = githubImportReducer(PINNED, {
      type: 'repository/select',
      repository: OTHER_REPO,
    });
    expect(githubImportReducer(moved, { type: 'snapshot/pinned', snapshot: MOVED })).toBe(moved);
  });

  it('ブランチの一覧は開いているあいだだけ受け取る', () => {
    const showing = githubImportReducer(PINNED, { type: 'branches/show' });
    expect(showing.choosingBranch).toBe(true);
    const loaded = githubImportReducer(showing, {
      type: 'branches/loaded',
      repositoryId: REPO.id,
      branches: ['main', 'dev'],
    });
    expect(loaded.branches).toEqual(['main', 'dev']);
    // 別のリポジトリの一覧・閉じたあとの一覧は捨てる。
    expect(
      githubImportReducer(showing, { type: 'branches/loaded', repositoryId: 7, branches: [] }),
    ).toBe(showing);
    const hidden = githubImportReducer(loaded, { type: 'branches/hide' });
    expect(hidden).toMatchObject({ choosingBranch: false, branches: null, snapshot: SNAPSHOT });
    expect(
      githubImportReducer(hidden, { type: 'branches/loaded', repositoryId: REPO.id, branches: [] }),
    ).toBe(hidden);
  });

  it('別のブランチを選ぶと、そのブランチのコミットで固定し直す', () => {
    const dev = { ...SNAPSHOT, ref: 'dev', commitSha: SHA_C, treeSha: SHA_D };
    const state = run(
      [{ type: 'branches/show' }, { type: 'snapshot/pinned', snapshot: dev }],
      PINNED,
    );
    expect(state).toMatchObject({ snapshot: dev, choosingBranch: false });
    expect(currentStep(state)).toEqual({ path: '', treeSha: SHA_D });
  });
});

describe('固定したスナップショットからだけ読む', () => {
  const listing = (treeSha: string) => ({ treeSha, entries: [], truncated: false });

  it('いまのコミット・いまのディレクトリの一覧だけを受け取る', () => {
    const loaded = githubImportReducer(PINNED, {
      type: 'listing/loaded',
      commitSha: SHA_A,
      listing: listing(SHA_B),
    });
    expect(loaded.listing).toEqual(listing(SHA_B));
  });

  it('ブランチが進んだコミットの一覧は、固定し直すまで使わない', () => {
    expect(
      githubImportReducer(PINNED, {
        type: 'listing/loaded',
        commitSha: SHA_C,
        listing: listing(SHA_B),
      }),
    ).toBe(PINNED);
  });

  it('離れたディレクトリの一覧が遅れて返っても使わない', () => {
    const inside = githubImportReducer(PINNED, {
      type: 'dir/enter',
      step: { path: 'docs', treeSha: SHA_C },
    });
    expect(
      githubImportReducer(inside, {
        type: 'listing/loaded',
        commitSha: SHA_A,
        listing: listing(SHA_B),
      }),
    ).toBe(inside);
  });

  it('取得中に固定し直したら、古いコミットの内容は候補にしない', () => {
    const repinned = githubImportReducer(PINNED, { type: 'snapshot/pinned', snapshot: MOVED });
    expect(githubImportReducer(repinned, { type: 'candidate/set', candidate: candidate() })).toBe(
      repinned,
    );
    expect(
      githubImportReducer(repinned, { type: 'candidate/set', candidate: candidate(SHA_C) })
        .candidate,
    ).not.toBeNull();
    expect(
      githubImportReducer(PINNED, { type: 'candidate/set', candidate: candidate(SHA_A, 7) }),
    ).toBe(PINNED);
  });

  it('候補を戻すと一覧に戻る', () => {
    const withCandidate = githubImportReducer(PINNED, {
      type: 'candidate/set',
      candidate: candidate(),
    });
    expect(withCandidate.candidate?.title).toBe('ch1.md');
    expect(githubImportReducer(withCandidate, { type: 'candidate/clear' }).candidate).toBeNull();
  });
});

describe('ディレクトリの移動', () => {
  const deep = run(
    [
      { type: 'dir/enter', step: { path: 'a', treeSha: SHA_C } },
      { type: 'dir/enter', step: { path: 'a/b', treeSha: SHA_D } },
    ],
    PINNED,
  );

  it('入ると道筋が伸びる', () => {
    expect(deep.trail.map((step) => step.path)).toEqual(['', 'a', 'a/b']);
    expect(currentStep(deep)?.path).toBe('a/b');
  });

  it('道筋の途中へ戻れる', () => {
    const back = githubImportReducer(deep, { type: 'dir/goTo', index: 0 });
    expect(back.trail).toEqual([{ path: '', treeSha: SHA_B }]);
    expect(back.listing).toBeNull();
  });

  it('範囲外や今いる場所への移動は何もしない', () => {
    expect(githubImportReducer(deep, { type: 'dir/goTo', index: 2 })).toBe(deep);
    expect(githubImportReducer(deep, { type: 'dir/goTo', index: 5 })).toBe(deep);
    expect(githubImportReducer(deep, { type: 'dir/goTo', index: -1 })).toBe(deep);
  });

  it('固定する前は入れない', () => {
    expect(
      githubImportReducer(initialGitHubImportState, {
        type: 'dir/enter',
        step: { path: 'a', treeSha: SHA_C },
      }),
    ).toBe(initialGitHubImportState);
  });
});

describe('知らせ', () => {
  it('出した直後だけ残り、次の操作で消える', () => {
    const informed = githubImportReducer(PINNED, { type: 'info', message: '最新です' });
    expect(informed.info).toBe('最新です');
    expect(githubImportReducer(informed, { type: 'busy', label: 'x' }).info).toBeNull();
    // 何も変わらない action では消さない。
    expect(githubImportReducer(informed, { type: 'dir/goTo', index: 0 }).info).toBe('最新です');
  });
});
