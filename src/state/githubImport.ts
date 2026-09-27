import type { GitHubCandidate } from '../lib/githubApi';
import {
  emptyTreeSelection,
  setTreeSelection,
  type GitHubTreeSelection,
} from '../lib/githubSelection';
import type { GitHubRepository, GitHubSnapshot, GitHubTreeEntry } from '../types';

/**
 * 「GitHubから追加」ダイアログの状態。
 *
 * ワークスペース（`workspace.ts`）とは分けて持つ。ここにあるものは永続化しない
 * （トークンはこの state にすら入れず、フックがメモリにだけ持つ）。
 *
 * 通信の結果はすべて action で受け取り、**いま固定しているスナップショットと
 * 食い違う応答は捨てる**。遅れて返ってきた古いブランチ・古いディレクトリの
 * 応答で画面が巻き戻ると、一覧で見たものと取り込むものが食い違う。
 */

/** ディレクトリを辿った道筋の1段。ルートは path が空文字。 */
export interface TrailStep {
  path: string;
  treeSha: string;
}

export interface DirectoryListing {
  treeSha: string;
  /**
   * 一覧を取ったディレクトリのパス。項目の `path` はこれを元に組み立ててある。
   * 中身が同じディレクトリは別の場所でも同じ tree SHA になるので、SHA だけでは
   * どこの一覧かを決められない。
   */
  path: string;
  entries: GitHubTreeEntry[];
  truncated: boolean;
}

/** 画面に出す失敗。`recover` は利用者が取れる次の手。 */
export interface GitHubImportError {
  message: string;
  recover: 'retry' | 'reconnect' | 'dismiss';
}

export type ConnectionState =
  /** 未接続。同意画面を出す。 */
  | 'disconnected'
  /** 認可から戻ってトークンを交換している。 */
  | 'connecting'
  | 'connected';

export interface GitHubImportState {
  open: boolean;
  connection: ConnectionState;
  /** 同意画面に添える知らせ（期限切れで切断した、など）。 */
  notice: string | null;
  /** App がアクセスできるリポジトリ。null は未取得。 */
  repositories: GitHubRepository[] | null;
  repository: GitHubRepository | null;
  /** ブランチの一覧を開いているときだけ中身がある。 */
  branches: string[] | null;
  choosingBranch: boolean;
  snapshot: GitHubSnapshot | null;
  /** ルートから今いるディレクトリまで。スナップショットがあれば1段以上ある。 */
  trail: TrailStep[];
  /** 今いるディレクトリの一覧。null は取得中。 */
  listing: DirectoryListing | null;
  candidate: GitHubCandidate | null;
  /** 複数選択を全件取得・検証したあとの候補。null は確認画面ではない。 */
  batchCandidates: GitHubCandidate[] | null;
  /** lazy tree の選択。未展開ディレクトリの選択も規則として保持する。 */
  selection: GitHubTreeSelection;
  /** 取得中の内容。null なら待っていない。 */
  busy: string | null;
  error: GitHubImportError | null;
  /** 失敗ではない知らせ（「最新です」など）。次の操作で消える。 */
  info: string | null;
}

export type GitHubImportAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'connect/start' }
  | { type: 'connect/done' }
  /** 認可へ遷移したあと、戻ってきた（引き返した）。接続中なら未接続へ戻す。 */
  | { type: 'connect/abandon' }
  /** 切断する。トークンの失効やユーザーの操作で呼ぶ。 */
  | { type: 'disconnect'; notice: string | null }
  | { type: 'busy'; label: string }
  | { type: 'fail'; error: GitHubImportError }
  | { type: 'error/dismiss' }
  | { type: 'info'; message: string }
  | { type: 'repositories/loaded'; repositories: GitHubRepository[] }
  | { type: 'repository/select'; repository: GitHubRepository }
  | { type: 'repository/clear' }
  | { type: 'branches/show' }
  | { type: 'branches/loaded'; repositoryId: number; branches: string[] }
  | { type: 'branches/hide' }
  | { type: 'snapshot/pinned'; snapshot: GitHubSnapshot }
  | { type: 'listing/loaded'; commitSha: string; listing: DirectoryListing }
  | { type: 'dir/enter'; step: TrailStep }
  /** 道筋の index 番目（0 がルート）まで戻る。 */
  | { type: 'dir/goTo'; index: number }
  | { type: 'candidate/set'; candidate: GitHubCandidate }
  | { type: 'candidate/clear' }
  | { type: 'batch/set'; candidates: GitHubCandidate[] }
  | { type: 'batch/clear' }
  | { type: 'selection/set'; path: string; selected: boolean }
  | { type: 'selection/clear' };

export const initialGitHubImportState: GitHubImportState = {
  open: false,
  connection: 'disconnected',
  notice: null,
  repositories: null,
  repository: null,
  branches: null,
  choosingBranch: false,
  snapshot: null,
  trail: [],
  listing: null,
  candidate: null,
  batchCandidates: null,
  selection: emptyTreeSelection(),
  busy: null,
  error: null,
  info: null,
};

/** 今いるディレクトリ。 */
export function currentStep(state: GitHubImportState): TrailStep | undefined {
  return state.trail[state.trail.length - 1];
}

/** リポジトリ以下の選択を捨てる。接続は保ったまま。 */
const CLEARED_SELECTION = {
  repository: null,
  branches: null,
  choosingBranch: false,
  snapshot: null,
  trail: [],
  listing: null,
  candidate: null,
  batchCandidates: null,
  selection: emptyTreeSelection(),
} satisfies Partial<GitHubImportState>;

export function githubImportReducer(
  state: GitHubImportState,
  action: GitHubImportAction,
): GitHubImportState {
  const next = reduce(state, action);
  // 知らせは、それを出した操作の直後にだけ意味がある。
  return action.type === 'info' || next === state || next.info === null
    ? next
    : { ...next, info: null };
}

function reduce(state: GitHubImportState, action: GitHubImportAction): GitHubImportState {
  switch (action.type) {
    case 'open':
      return { ...state, open: true };

    case 'close':
      // 接続と選んでいた場所は残す。続けてもう1件取り込むときに辿り直さなくて済む。
      // 取得待ちは呼び出し側が中断するので、待ち表示とエラーは片付ける。
      return {
        ...state,
        open: false,
        busy: null,
        error: null,
        candidate: null,
        batchCandidates: null,
      };

    case 'connect/start':
      return { ...state, connection: 'connecting', notice: null, error: null };

    case 'connect/abandon':
      return state.connection === 'connecting' ? { ...state, connection: 'disconnected' } : state;

    case 'connect/done':
      return { ...state, connection: 'connected', busy: null, error: null };

    case 'disconnect':
      return {
        ...initialGitHubImportState,
        open: state.open,
        notice: action.notice,
      };

    case 'busy':
      return { ...state, busy: action.label, error: null };

    case 'fail':
      return { ...state, busy: null, error: action.error };

    case 'error/dismiss':
      return { ...state, error: null };

    case 'info':
      return { ...state, busy: null, info: action.message };

    case 'repositories/loaded':
      return { ...state, repositories: action.repositories, busy: null, error: null };

    case 'repository/select':
      return { ...state, ...CLEARED_SELECTION, repository: action.repository, error: null };

    case 'repository/clear':
      return { ...state, ...CLEARED_SELECTION, busy: null, error: null };

    case 'branches/show':
      return { ...state, choosingBranch: true, branches: null, error: null };

    case 'branches/loaded':
      // 一覧を待つあいだに別のリポジトリへ移っていたら捨てる。
      if (state.repository?.id !== action.repositoryId || !state.choosingBranch) return state;
      return { ...state, branches: action.branches, busy: null, error: null };

    case 'branches/hide':
      return { ...state, choosingBranch: false, branches: null, busy: null, error: null };

    case 'snapshot/pinned': {
      // 選び直している最中に別のリポジトリへ移っていたら捨てる。
      if (state.repository?.id !== action.snapshot.repository.id) return state;
      return {
        ...state,
        snapshot: action.snapshot,
        choosingBranch: false,
        branches: null,
        trail: [{ path: '', treeSha: action.snapshot.treeSha }],
        listing: null,
        candidate: null,
        batchCandidates: null,
        selection: emptyTreeSelection(),
        busy: null,
        error: null,
      };
    }

    case 'listing/loaded': {
      // 固定し直す前のスナップショットや、もう離れたディレクトリの応答は使わない。
      if (state.snapshot?.commitSha !== action.commitSha) return state;
      // SHA とパスの両方で照合する（同じ SHA の別のフォルダの一覧を取り違えない）。
      const here = currentStep(state);
      if (here?.treeSha !== action.listing.treeSha || here.path !== action.listing.path) {
        return state;
      }
      return { ...state, listing: action.listing, busy: null, error: null };
    }

    case 'dir/enter':
      if (!state.snapshot) return state;
      return {
        ...state,
        trail: [...state.trail, action.step],
        listing: null,
        candidate: null,
        error: null,
      };

    case 'dir/goTo': {
      if (action.index < 0 || action.index >= state.trail.length) return state;
      if (action.index === state.trail.length - 1) return state;
      return {
        ...state,
        trail: state.trail.slice(0, action.index + 1),
        listing: null,
        candidate: null,
        error: null,
      };
    }

    case 'candidate/set':
      // 取得中にスナップショットを変えていたら、古いコミットの内容なので使わない。
      if (state.snapshot?.commitSha !== action.candidate.source.commitSha) return state;
      if (state.snapshot.repository.id !== action.candidate.source.repositoryId) return state;
      return { ...state, candidate: action.candidate, batchCandidates: null, busy: null, error: null };

    case 'candidate/clear':
      return { ...state, candidate: null, error: null };

    case 'batch/set':
      if (!state.snapshot) return state;
      if (
        action.candidates.some(
          (candidate) =>
            candidate.source.commitSha !== state.snapshot?.commitSha ||
            candidate.source.repositoryId !== state.snapshot?.repository.id,
        )
      ) {
        return state;
      }
      return { ...state, candidate: null, batchCandidates: action.candidates, busy: null, error: null };

    case 'batch/clear':
      return { ...state, batchCandidates: null, error: null };

    case 'selection/set':
      if (!state.snapshot) return state;
      return {
        ...state,
        selection: setTreeSelection(state.selection, action.path, action.selected),
        candidate: null,
        batchCandidates: null,
        error: null,
      };

    case 'selection/clear':
      return {
        ...state,
        selection: emptyTreeSelection(),
        candidate: null,
        batchCandidates: null,
        error: null,
      };
  }
}
