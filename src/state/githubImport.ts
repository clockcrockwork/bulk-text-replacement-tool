import type { GitHubCandidate } from '../lib/githubApi';
import type { BatchChoices } from '../lib/githubBatchReview';
import {
  emptyTreeSelection,
  type GitHubTreeSelection,
  setTreeSelection,
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

/**
 * 列挙が終わり、blob を取る前の計画。件数と容量を見せてから取得に進む。
 * `selection` は列挙に使った選択そのもの（同一性で照合する）。
 */
export interface GitHubBatchPlan {
  entries: GitHubTreeEntry[];
  /** 選択範囲にあったが取り込めない項目。計画画面で件数を出す。 */
  excluded: GitHubTreeEntry[];
  selection: GitHubTreeSelection;
}

/** 画面に出す失敗。`recover` は利用者が取れる次の手。 */
export interface GitHubImportError {
  message: string;
  /** `reselect` はリポジトリの一覧を取り直して選び直す（`recoveryFor`）。 */
  recover: 'retry' | 'reconnect' | 'dismiss' | 'reselect';
}

/** rate limit が解けるまでの残り時間（ミリ秒）。0 なら GitHub へ要求してよい。 */
export function rateLimitWaitMs(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(0, until - now);
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
  /**
   * このスナップショットで一度読み込んだ項目（キーはパス）。場所を移っても選択の件数と
   * 既知の容量を数えられるように持つ。パスは任意の名前なので Map にする。
   */
  knownEntries: ReadonlyMap<string, GitHubTreeEntry>;
  candidate: GitHubCandidate | null;
  /** 複数選択を列挙し終え、取得の前に件数・容量を確かめる段階。 */
  batchPlan: GitHubBatchPlan | null;
  /** 複数選択を全件取得・検証したあとの候補。null は確認画面ではない。 */
  batchCandidates: GitHubCandidate[] | null;
  /**
   * 確認画面で利用者が決めた取り込み方法（キーはパス）。候補と同じく、ダイアログを
   * 閉じても残す。取得し直すと利用上限を使い、手で決めた内容も失うため。
   */
  batchChoices: BatchChoices;
  /**
   * 遅延読み込みする tree の選択。未展開のディレクトリの選択も規則として持つ。
   * 変わるたびに別のオブジェクトになるので、同一性で「その選択から作った結果か」を照合できる。
   */
  selection: GitHubTreeSelection;
  /** 取得中の内容。null なら待っていない。 */
  busy: string | null;
  /**
   * 取得中（または接続中）に、利用者に見える進みが `SLOW_NOTICE_MS` のあいだ無かった。
   * 「時間がかかっています。閉じると中断できます」を添える。進みがあれば（`busy` の更新で）消える。
   */
  slow: boolean;
  error: GitHubImportError | null;
  /** 失敗ではない知らせ（「最新です」など）。次の操作で消える。 */
  info: string | null;
  /**
   * GitHub の rate limit が解ける時刻（ミリ秒）。それまでは GitHub へ一切要求しない。
   *
   * 失敗の知らせ（`error`）とは別に持つ。知らせは選択を変える・閉じるなどで消えるが、
   * それで待ちまで消えると、別のボタンや開き直しから解除前の要求を出せてしまう。
   * GitHub は解除前に要求を続けないよう求めていて、一括取り込みでは1回で多数の要求を出す。
   */
  rateLimitedUntil: number | null;
}

export type GitHubImportAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'connect/start' }
  | { type: 'connect/done' }
  /** 認可へ遷移したあと、戻ってきた（引き返した）。接続中なら未接続へ戻す。 */
  | { type: 'connect/abandon' }
  /**
   * ページが bfcache に入る／から戻る（`persisted` な pagehide / pageshow）。
   * 接続済みなら切断して知らせる。トークンは呼び出し側が同時に捨てる。
   */
  | { type: 'page/persisted' }
  /** 切断する。トークンの失効やユーザーの操作で呼ぶ。 */
  | { type: 'disconnect'; notice: string | null }
  | { type: 'busy'; label: string }
  /** 進みが無いまま時間が経った。待っているときだけ効く。 */
  | { type: 'busy/slow' }
  /** `rateLimitedUntil` を渡すと、その時刻まで GitHub への要求を止める。 */
  | { type: 'fail'; error: GitHubImportError; rateLimitedUntil?: number }
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
  /** 列挙が終わった。`selection` は列挙を始めたときの選択。 */
  | {
      type: 'batch/planned';
      commitSha: string;
      selection: GitHubTreeSelection;
      entries: GitHubTreeEntry[];
      excluded: GitHubTreeEntry[];
    }
  /** 計画した全件を取得・検証し終えた。`selection` は計画を作ったときの選択。 */
  | { type: 'batch/set'; selection: GitHubTreeSelection; candidates: GitHubCandidate[] }
  | { type: 'batch/clear' }
  | { type: 'batch/choose'; choices: BatchChoices }
  /** 確定した一括取り込みを「元に戻す」で取り消したとき、確認画面を決めた内容ごと戻す。 */
  | { type: 'batch/restore'; batch: SuspendedBatch }
  | { type: 'selection/set'; path: string; selected: boolean }
  | { type: 'selection/clear' };

/** 確定した一括取り込みの控え。「元に戻す」で確認画面へ戻すために持つ。 */
export interface SuspendedBatch {
  selection: GitHubTreeSelection;
  candidates: GitHubCandidate[];
  choices: BatchChoices;
}

/** 決めた取り込み方法が無い状態。読み取り専用なので、同じインスタンスを共有してよい。 */
const NO_CHOICES: BatchChoices = new Map();

/** bfcache に入った（ページを離れた）ために切断したときの知らせ。 */
export const PAGE_LEFT_NOTICE =
  'ページを離れたため、GitHub との接続を解除しました。もう一度接続してください。';

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
  knownEntries: new Map(),
  candidate: null,
  batchPlan: null,
  batchCandidates: null,
  batchChoices: NO_CHOICES,
  selection: emptyTreeSelection(),
  busy: null,
  slow: false,
  error: null,
  info: null,
  rateLimitedUntil: null,
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
  knownEntries: new Map(),
  candidate: null,
  batchPlan: null,
  batchCandidates: null,
  batchChoices: NO_CHOICES,
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

/**
 * 「時間がかかっています」を出す。待っている（取得中か接続中の）ときだけ効かせ、
 * 待ち終わったあとに遅れて届いた知らせで、次の画面に案内を残さない。
 */
function markSlow(state: GitHubImportState): GitHubImportState {
  const waiting = state.busy !== null || state.connection === 'connecting';
  return waiting ? { ...state, slow: true } : state;
}

function reduce(state: GitHubImportState, action: GitHubImportAction): GitHubImportState {
  switch (action.type) {
    case 'open':
      return { ...state, open: true };

    case 'close':
      // 接続と選んでいた場所は残す。続けてもう1件取り込むときに辿り直さなくて済む。
      // 一括取り込みの計画・取得済みの候補・決めた取り込み方法も残す。取り直すと利用上限を
      // 使い、手で決めた内容も失う（Escape や背景のクリックでも閉じるので、誤操作で失わせない）。
      // 捨てるのは「選択へ戻る」だけ。取得待ちは呼び出し側が中断するので、待ち表示と
      // エラーは片付ける（取得の途中なら計画の画面に戻り、もう一度取得できる）。
      return {
        ...state,
        open: false,
        busy: null,
        error: null,
        candidate: null,
      };

    case 'connect/start':
      return { ...state, connection: 'connecting', notice: null, error: null, slow: false };

    case 'connect/abandon':
      return state.connection === 'connecting' ? { ...state, connection: 'disconnected' } : state;

    case 'page/persisted':
      // bfcache から戻ると JS のヒープごと復元され、メモリにだけ持つトークンも生き返る。
      // 共用の端末で、タブを閉じずに別のサイトへ移ったあと次の人が「戻る」を押すと、
      // 前の利用者の権限でリポジトリを読めてしまうので、ページを離れた時点で切断する。
      // 接続中（認可の画面へ移る途中）は変えない。戻ったときの片付けは connect/abandon が行い、
      // 認可から正しく戻る流れ（新しいページの読み込み）には関わらない。
      // rate limit の待ちは残す。GitHub の利用者ごとに掛かるので、ページを離れても解けていない。
      return state.connection === 'connected'
        ? {
            ...initialGitHubImportState,
            open: state.open,
            notice: PAGE_LEFT_NOTICE,
            rateLimitedUntil: state.rateLimitedUntil,
          }
        : state;

    case 'connect/done':
      return { ...state, connection: 'connected', busy: null, error: null, slow: false };

    case 'disconnect':
      return {
        ...initialGitHubImportState,
        open: state.open,
        notice: action.notice,
        // rate limit は GitHub の利用者ごとに掛かるので、接続し直しても解けていない。
        rateLimitedUntil: state.rateLimitedUntil,
      };

    case 'busy':
      return { ...state, busy: action.label, error: null, slow: false };

    case 'busy/slow':
      return markSlow(state);

    case 'fail':
      return {
        ...state,
        busy: null,
        error: action.error,
        rateLimitedUntil: action.rateLimitedUntil ?? state.rateLimitedUntil,
      };

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
        knownEntries: new Map(),
        candidate: null,
        batchPlan: null,
        batchCandidates: null,
        batchChoices: NO_CHOICES,
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
      const knownEntries = new Map(state.knownEntries);
      for (const entry of action.listing.entries) knownEntries.set(entry.path, entry);
      return { ...state, listing: action.listing, knownEntries, busy: null, error: null };
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
      return {
        ...state,
        candidate: action.candidate,
        batchPlan: null,
        batchCandidates: null,
        batchChoices: NO_CHOICES,
        busy: null,
        error: null,
      };

    case 'candidate/clear':
      return { ...state, candidate: null, error: null };

    case 'batch/planned':
      return acceptBatchPlan(state, action);

    case 'batch/set':
      return acceptBatchCandidates(state, action);

    case 'batch/choose':
      // 確認画面にいるときだけ受け取る（候補が片付いたあとに届いた決定は使い道が無い）。
      if (!state.batchCandidates) return state;
      return { ...state, batchChoices: action.choices };

    case 'batch/restore':
      return restoreBatch(state, action.batch);

    case 'batch/clear':
      // 取得の途中で戻ったときも、呼び出し側が取得を中断するので待ち表示を片付ける。
      return {
        ...state,
        batchPlan: null,
        batchCandidates: null,
        batchChoices: NO_CHOICES,
        busy: null,
        error: null,
      };

    case 'selection/set':
      if (!state.snapshot) return state;
      return {
        ...state,
        selection: setTreeSelection(state.selection, action.path, action.selected),
        candidate: null,
        batchPlan: null,
        batchCandidates: null,
        batchChoices: NO_CHOICES,
        error: null,
      };

    case 'selection/clear':
      return {
        ...state,
        selection: emptyTreeSelection(),
        candidate: null,
        batchPlan: null,
        batchCandidates: null,
        batchChoices: NO_CHOICES,
        error: null,
      };
  }
}

function acceptBatchPlan(
  state: GitHubImportState,
  action: Extract<GitHubImportAction, { type: 'batch/planned' }>,
): GitHubImportState {
  // 列挙のあいだに固定し直した、または選択を変えたなら、その一覧は今の選択ではない。
  if (state.snapshot?.commitSha !== action.commitSha) return state;
  if (state.selection !== action.selection) return state;
  return {
    ...state,
    candidate: null,
    batchPlan: { entries: action.entries, excluded: action.excluded, selection: action.selection },
    batchCandidates: null,
    batchChoices: NO_CHOICES,
    busy: null,
    error: null,
  };
}

function acceptBatchCandidates(
  state: GitHubImportState,
  action: Extract<GitHubImportAction, { type: 'batch/set' }>,
): GitHubImportState {
  const snapshot = state.snapshot;
  if (!snapshot) return state;
  // 確かめた計画と、それを作った選択のままのときだけ受け取る。
  if (state.batchPlan?.selection !== action.selection) return state;
  if (state.selection !== action.selection) return state;
  // 取得中に固定し直していたら、古いコミットの内容なので使わない（1件でも混じれば全体を捨てる）。
  const stale = action.candidates.some(
    (candidate) =>
      candidate.source.commitSha !== snapshot.commitSha ||
      candidate.source.repositoryId !== snapshot.repository.id,
  );
  if (stale) return state;
  return {
    ...state,
    candidate: null,
    batchPlan: null,
    batchCandidates: action.candidates,
    batchChoices: NO_CHOICES,
    busy: null,
    error: null,
  };
}

/**
 * 取り消した一括取り込みを、確認画面へ戻す。
 *
 * 候補は取得済みなので取り直さない。戻せるのは、同じスナップショットを見ていて、
 * 別の一括や取得を始めていないときだけ（そうでなければ、今の作業を上書きしてしまう）。
 */
function restoreBatch(state: GitHubImportState, batch: SuspendedBatch): GitHubImportState {
  const snapshot = state.snapshot;
  const first = batch.candidates[0];
  if (!snapshot || !first) return state;
  if (state.busy !== null || state.batchPlan || state.batchCandidates) return state;
  const sameSnapshot = batch.candidates.every(
    (candidate) =>
      candidate.source.commitSha === snapshot.commitSha &&
      candidate.source.repositoryId === snapshot.repository.id,
  );
  if (!sameSnapshot) return state;
  return {
    ...state,
    selection: batch.selection,
    candidate: null,
    batchPlan: null,
    batchCandidates: batch.candidates,
    batchChoices: batch.choices,
    error: null,
  };
}
