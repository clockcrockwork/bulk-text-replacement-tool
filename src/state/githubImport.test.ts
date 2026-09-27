import { describe, expect, it } from 'vitest';
import type { GitHubCandidate } from '../lib/githubApi';
import { isPathSelected, selectionMark } from '../lib/githubSelection';
import type { GitHubRepository, GitHubSnapshot, GitHubTreeEntry } from '../types';
import {
  currentStep,
  type GitHubImportAction,
  type GitHubImportState,
  githubImportReducer,
  initialGitHubImportState,
  rateLimitWaitMs,
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

const ENTRY: GitHubTreeEntry = {
  name: 'ch1.md',
  path: 'chapters/ch1.md',
  sha: SHA_D,
  status: 'importable',
  size: 6,
};

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
  const listing = (treeSha: string, path = '') => ({
    treeSha,
    path,
    entries: [],
    truncated: false,
  });

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

  it('同じ tree SHA でも、別のディレクトリの一覧は使わない（中身が同じフォルダ）', () => {
    // a/ と b/ が同じ中身なら同じ tree SHA になる。b/ にいるときに a/ の一覧を受け取らない。
    const inB = githubImportReducer(PINNED, {
      type: 'dir/enter',
      step: { path: 'b', treeSha: SHA_C },
    });
    expect(
      githubImportReducer(inB, {
        type: 'listing/loaded',
        commitSha: SHA_A,
        listing: listing(SHA_C, 'a'),
      }),
    ).toBe(inB);
    expect(
      githubImportReducer(inB, {
        type: 'listing/loaded',
        commitSha: SHA_A,
        listing: listing(SHA_C, 'b'),
      }).listing?.path,
    ).toBe('b');
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

describe('複数選択', () => {
  it('未展開フォルダの選択を移動しても保持し、snapshot を固定し直すと捨てる', () => {
    const selected = githubImportReducer(PINNED, {
      type: 'selection/set',
      path: 'chapters',
      selected: true,
    });
    expect(isPathSelected(selected.selection, 'chapters/deep/ch1.md')).toBe(true);

    const inside = githubImportReducer(selected, {
      type: 'dir/enter',
      step: { path: 'other', treeSha: SHA_C },
    });
    expect(isPathSelected(inside.selection, 'chapters/deep/ch1.md')).toBe(true);

    const repinned = githubImportReducer(inside, { type: 'snapshot/pinned', snapshot: MOVED });
    expect(isPathSelected(repinned.selection, 'chapters/deep/ch1.md')).toBe(false);
  });

  it('親選択から子を外すと mixed になり、選び直すと配下を再選択する', () => {
    let selected = githubImportReducer(PINNED, {
      type: 'selection/set',
      path: 'chapters',
      selected: true,
    });
    selected = githubImportReducer(selected, {
      type: 'selection/set',
      path: 'chapters/drafts',
      selected: false,
    });
    expect(selectionMark(selected.selection, 'chapters')).toBe('mixed');

    selected = githubImportReducer(selected, {
      type: 'selection/set',
      path: 'chapters',
      selected: true,
    });
    expect(selectionMark(selected.selection, 'chapters')).toBe('checked');
    expect(isPathSelected(selected.selection, 'chapters/drafts/old.md')).toBe(true);
  });

  it('読み込んだ項目は場所を跨いで覚え、__proto__ のような名前もパスとして持つ', () => {
    const entry: GitHubTreeEntry = {
      name: '__proto__',
      path: '__proto__',
      sha: SHA_C,
      status: 'dir',
      size: null,
    };
    const loaded = githubImportReducer(PINNED, {
      type: 'listing/loaded',
      commitSha: SHA_A,
      listing: { treeSha: SHA_B, path: '', entries: [entry], truncated: false },
    });
    expect(loaded.knownEntries.get('__proto__')).toEqual(entry);
    expect(loaded.knownEntries.size).toBe(1);
  });
});

describe('一括取り込みの段階', () => {
  const SELECTED = githubImportReducer(PINNED, {
    type: 'selection/set',
    path: 'chapters',
    selected: true,
  });
  const PLANNED = githubImportReducer(SELECTED, {
    type: 'batch/planned',
    commitSha: SHA_A,
    selection: SELECTED.selection,
    entries: [ENTRY],
  });

  it('列挙の結果は、始めたときと同じ選択・同じコミットのときだけ計画にする', () => {
    expect(PLANNED.batchPlan).toEqual({ entries: [ENTRY], selection: SELECTED.selection });
    expect(PLANNED.busy).toBeNull();
  });

  it('列挙の途中で選択を変えていたら、遅れて返った一覧は捨てる', () => {
    const changed = githubImportReducer(SELECTED, {
      type: 'selection/set',
      path: 'chapters/drafts',
      selected: false,
    });
    expect(
      githubImportReducer(changed, {
        type: 'batch/planned',
        commitSha: SHA_A,
        selection: SELECTED.selection,
        entries: [ENTRY],
      }),
    ).toBe(changed);
  });

  it('列挙の途中で固定し直していたら、古いコミットの一覧は捨てる', () => {
    expect(
      githubImportReducer(SELECTED, {
        type: 'batch/planned',
        commitSha: SHA_C,
        selection: SELECTED.selection,
        entries: [ENTRY],
      }),
    ).toBe(SELECTED);
  });

  it('計画を確かめたあとの取得結果だけを、確認画面の候補にする', () => {
    const fetched = githubImportReducer(PLANNED, {
      type: 'batch/set',
      selection: SELECTED.selection,
      candidates: [candidate()],
    });
    expect(fetched.batchCandidates).toHaveLength(1);
    expect(fetched.batchPlan).toBeNull();
  });

  it('計画が無い（選択へ戻った）あとに届いた取得結果は捨てる', () => {
    const back = githubImportReducer(PLANNED, { type: 'batch/clear' });
    expect(back.batchPlan).toBeNull();
    expect(
      githubImportReducer(back, {
        type: 'batch/set',
        selection: SELECTED.selection,
        candidates: [candidate()],
      }),
    ).toBe(back);
  });

  it('別の選択から作った取得結果は捨てる', () => {
    expect(
      githubImportReducer(PLANNED, {
        type: 'batch/set',
        selection: PINNED.selection,
        candidates: [candidate()],
      }),
    ).toBe(PLANNED);
  });

  it('固定中と違うコミットやリポジトリの候補が混じっていたら、全体を捨てる', () => {
    expect(
      githubImportReducer(PLANNED, {
        type: 'batch/set',
        selection: SELECTED.selection,
        candidates: [candidate(), candidate(SHA_C)],
      }),
    ).toBe(PLANNED);
    expect(
      githubImportReducer(PLANNED, {
        type: 'batch/set',
        selection: SELECTED.selection,
        candidates: [candidate(SHA_A, OTHER_REPO.id)],
      }),
    ).toBe(PLANNED);
  });

  it('取得の途中で選択へ戻ると、待ち表示も片付ける（呼び出し側が取得を中断する）', () => {
    const fetching = githubImportReducer(PLANNED, {
      type: 'busy',
      label: '選択したファイルを取得しています',
    });
    const back = githubImportReducer(fetching, { type: 'batch/clear' });
    expect(back.batchPlan).toBeNull();
    expect(back.busy).toBeNull();
    // 選択は残す（選び直してから、もう一度確かめられる）。
    expect(back.selection).toBe(SELECTED.selection);
  });

  it('選択を変えたり1ファイルの確認へ進んだりすると、計画は捨てる', () => {
    expect(
      githubImportReducer(PLANNED, { type: 'selection/set', path: 'x', selected: true }).batchPlan,
    ).toBeNull();
    expect(
      githubImportReducer(PLANNED, { type: 'candidate/set', candidate: candidate() }).batchPlan,
    ).toBeNull();
    expect(githubImportReducer(PLANNED, { type: 'close' }).batchPlan).toBeNull();
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

describe('rate limit の待ち', () => {
  const limited = {
    message: 'GitHub API の利用上限に達しました。',
    recover: 'retry' as const,
  };

  it('解除時刻までは残り時間を返し、過ぎたら 0 にする', () => {
    expect(rateLimitWaitMs(10_000, 4_000)).toBe(6_000);
    expect(rateLimitWaitMs(10_000, 10_000)).toBe(0);
    expect(rateLimitWaitMs(10_000, 12_000)).toBe(0);
    expect(rateLimitWaitMs(null, 0)).toBe(0);
  });

  it('失敗の知らせとは別に持ち、知らせが消えても待ちは残る', () => {
    const failed = githubImportReducer(PINNED, {
      type: 'fail',
      error: limited,
      rateLimitedUntil: 10_000,
    });
    expect(failed.rateLimitedUntil).toBe(10_000);

    const dismissed = githubImportReducer(failed, { type: 'error/dismiss' });
    const reselected = githubImportReducer(dismissed, {
      type: 'selection/set',
      path: 'chapters',
      selected: true,
    });
    const closed = githubImportReducer(reselected, { type: 'close' });
    expect(closed.error).toBeNull();
    expect(closed.rateLimitedUntil).toBe(10_000);
  });

  it('rate limit でない失敗は、待ちを変えない', () => {
    const failed = githubImportReducer(PINNED, {
      type: 'fail',
      error: limited,
      rateLimitedUntil: 10_000,
    });
    const other = githubImportReducer(failed, {
      type: 'fail',
      error: { message: '見つかりませんでした。', recover: 'retry' },
    });
    expect(other.rateLimitedUntil).toBe(10_000);
  });

  it('rate limit は利用者ごとなので、接続し直しても待ちは残る', () => {
    const failed = githubImportReducer(PINNED, {
      type: 'fail',
      error: limited,
      rateLimitedUntil: 10_000,
    });
    expect(githubImportReducer(failed, { type: 'disconnect', notice: null }).rateLimitedUntil).toBe(
      10_000,
    );
  });
});
