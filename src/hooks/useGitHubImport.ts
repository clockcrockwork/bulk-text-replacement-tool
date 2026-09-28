import { useEffect, useReducer, useRef } from 'react';
import {
  createGitHubClient,
  GitHubBlobTooLargeError,
  type GitHubClient,
  GitHubRequestError,
} from '../github/client';
import { mapWithConcurrency } from '../lib/concurrency';
import {
  blobTooLargeMessage,
  buildCandidate,
  compareCodePoints,
  describeGitHubError,
  type GitHubCandidate,
  type GitHubFetchStage,
  type NormalizedTree,
  orderBranches,
  recoveryFor,
} from '../lib/githubApi';
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  callbackUrl,
  codeChallengeS256,
  describeCallbackFailure,
  describeTokenExchangeFailure,
  type GitHubAppConfig,
  type GitHubToken,
  installationUrl,
  isTokenUsable,
  nonCanonicalTarget,
  PENDING_AUTH_KEY,
  parseExchangeErrorCode,
  parsePendingAuth,
  parseTokenResponse,
  readCallbackParams,
  readGitHubAppConfig,
  serializePendingAuth,
  stripCallbackParams,
  TOKEN_EXCHANGE_PATH,
  validateCallback,
} from '../lib/githubAuth';
import type { BatchChoices } from '../lib/githubBatchReview';
import {
  type GitHubTreeSelection,
  hasAnySelection,
  includedSelectionRoots,
  isPathSelected,
  selectionMayContainSelected,
} from '../lib/githubSelection';
import {
  describeImportTotalTooLarge,
  MAX_IMPORT_TOTAL_BYTES,
  MAX_INPUT_BYTES,
} from '../lib/inputLimits';
import { shortSha } from '../lib/inputSource';
import { revealUnsafeChars } from '../lib/revealText';
import {
  currentStep,
  type GitHubImportState,
  githubImportReducer,
  initialGitHubImportState,
  rateLimitWaitMs,
  type SuspendedBatch,
  type TrailStep,
} from '../state/githubImport';
import type { GitHubRepository, GitHubSnapshot, GitHubTreeEntry } from '../types';

/** ビルド時に決まる公開設定。未設定の配信では null（ボタンを無効にする）。 */
const APP_CONFIG: GitHubAppConfig | null = readGitHubAppConfig(import.meta.env);

const EXPIRED_NOTICE = 'GitHub との接続の有効期限が切れました。もう一度接続してください。';

const BLOB_CONCURRENCY = 4;

/**
 * やり直しても結果が変わらない失敗（「再試行」を出さずに閉じてもらう）。一括の準備で
 * 使い始めたが、1件の取得で上限を超えたときも同じ扱いにする。
 */
export class GitHubBatchPreparationError extends Error {}

class GitHubBatchRequestError extends Error {
  constructor(
    readonly path: string,
    readonly requestError: GitHubRequestError,
  ) {
    super(`${path}: ${requestError.message}`);
  }
}

async function loadBatchTree(
  api: GitHubClient,
  snapshot: GitHubSnapshot,
  step: { path: string; treeSha: string },
  signal: AbortSignal,
  recursive: boolean,
): Promise<NormalizedTree> {
  try {
    return recursive
      ? await api.getTreeRecursive(snapshot, step.treeSha, step.path, signal)
      : await api.getTree(snapshot, step.treeSha, step.path, signal);
  } catch (error) {
    if (error instanceof GitHubRequestError) {
      throw new GitHubBatchRequestError(step.path || 'ルート', error);
    }
    throw error;
  }
}

/** 選択範囲を列挙した結果。 */
export interface SelectedEntries {
  /** 取り込める（対応する）ファイル。パス順。 */
  files: GitHubTreeEntry[];
  /**
   * 選択範囲にあったが取り込めない項目（非対応の形式・上限超え・シンボリックリンク・
   * サブモジュール）。開かずにフォルダごと選ぶと一覧で見えないので、計画画面で件数を出す。
   */
  excluded: GitHubTreeEntry[];
}

export async function enumerateSelectedEntries(
  api: GitHubClient,
  snapshot: GitHubSnapshot,
  selection: GitHubTreeSelection,
  knownEntries: ReadonlyMap<string, GitHubTreeEntry>,
  signal: AbortSignal,
): Promise<SelectedEntries> {
  const queue: Array<{ path: string; treeSha: string }> = [];
  const files: GitHubTreeEntry[] = [];
  const excluded: GitHubTreeEntry[] = [];
  const seen = new Set<string>();

  const collect = (entries: readonly GitHubTreeEntry[]): void => {
    for (const entry of entries) {
      if (entry.status === 'dir' || seen.has(entry.path)) continue;
      if (!isPathSelected(selection, entry.path)) continue;
      seen.add(entry.path);
      (entry.status === 'importable' ? files : excluded).push(entry);
    }
  };

  for (const path of includedSelectionRoots(selection)) {
    if (path === '') {
      queue.push({ path: '', treeSha: snapshot.treeSha });
      continue;
    }
    // 規則は画面に出たチェックボックスからしか作られないので、項目は読み込み済みのはず。
    // 無ければ想定外の状態。黙って落とすのも、ルートから全体を辿り直して GitHub の
    // 利用上限を使うのも避け、はっきり止める。
    const entry = knownEntries.get(path);
    if (!entry) {
      throw new GitHubBatchPreparationError(
        `${revealUnsafeChars(path)} の場所を確認できませんでした。フォルダを開き直して選び直してください。`,
      );
    }
    if (entry.status === 'dir') {
      queue.push({ path: entry.path, treeSha: entry.sha });
    } else {
      collect([entry]);
    }
  }

  while (queue.length > 0) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const step = queue.shift();
    if (!step) break;

    // まず recursive API で subtree を1回で列挙する。partial response は絶対に使わない。
    const recursiveTree = await loadBatchTree(api, snapshot, step, signal, true);
    if (!recursiveTree.truncated) {
      collect(recursiveTree.entries);
      continue;
    }

    // GitHub が recursive 応答を打ち切ったら、その partial list は捨てる。
    // 非再帰で1階層を取り直し、必要な子 tree だけを queue に積んで完全列挙する。
    const directTree = await loadBatchTree(api, snapshot, step, signal, false);
    if (directTree.truncated) {
      throw new GitHubBatchPreparationError(
        `${step.path ? revealUnsafeChars(step.path) : 'ルート'} の一覧が途中で打ち切られたため、安全に一括取り込みできません。`,
      );
    }
    collect(directTree.entries);
    for (const entry of directTree.entries) {
      if (entry.status === 'dir' && selectionMayContainSelected(selection, entry.path)) {
        queue.push({ path: entry.path, treeSha: entry.sha });
      }
    }
  }

  files.sort((a, b) => compareCodePoints(a.path, b.path));
  excluded.sort((a, b) => compareCodePoints(a.path, b.path));
  return { files, excluded };
}

/**
 * 1件の blob を上限付きで取る。上限を超えたら、どのファイルかを添えて「再試行」の無い
 * 失敗にする（何度取っても大きさは変わらない）。
 */
async function getBlobWithinLimit(
  api: GitHubClient,
  snapshot: GitHubSnapshot,
  entry: GitHubTreeEntry,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  try {
    return await api.getBlob(snapshot, entry.sha, signal, MAX_INPUT_BYTES);
  } catch (error) {
    if (error instanceof GitHubBlobTooLargeError) {
      throw new GitHubBatchPreparationError(blobTooLargeMessage(entry.path));
    }
    throw error;
  }
}

/**
 * 計画した全件の blob を取り、候補にする。1件でも失敗したら全体を失敗にする。
 *
 * 取れた分の合計が1回の上限（`MAX_IMPORT_TOTAL_BYTES`）を超えたら、その時点で止める。
 * 大きさの分かる分は計画の画面で断っているが、tree が大きさを返さない項目は取って
 * みるまで分からない。1件ずつの上限だけでは、上限以下のファイルを大量に選べば
 * 同じ量を一度に読めてしまう。
 *
 * `cache` は取り直しを避けるための控え（キーはリポジトリと blob SHA）。控えから使った
 * 分も合計に数える（今回の取り込みで読み込む量なので）。
 */
export async function fetchBatchCandidates(
  api: GitHubClient,
  snapshot: GitHubSnapshot,
  entries: readonly GitHubTreeEntry[],
  cache: Map<string, ArrayBuffer>,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<GitHubCandidate[]> {
  let done = 0;
  let fetchedBytes = 0;
  return mapWithConcurrency(entries, BLOB_CONCURRENCY, signal, async (entry, requestSignal) => {
    const key = JSON.stringify([snapshot.repository.id, entry.sha]);
    let buffer = cache.get(key);
    if (!buffer) {
      try {
        buffer = await getBlobWithinLimit(api, snapshot, entry, requestSignal);
      } catch (error) {
        if (error instanceof GitHubRequestError) {
          throw new GitHubBatchRequestError(entry.path, error);
        }
        throw error;
      }
      cache.set(key, buffer);
    }
    fetchedBytes += buffer.byteLength;
    if (fetchedBytes > MAX_IMPORT_TOTAL_BYTES) {
      throw new GitHubBatchPreparationError(describeImportTotalTooLarge());
    }
    const result = buildCandidate(snapshot, entry, buffer);
    if (result.kind === 'error') throw new GitHubBatchPreparationError(result.message);
    done += 1;
    if (!requestSignal.aborted) onProgress(done, entries.length);
    return result.candidate;
  });
}

const CANCELLED_NOTICE = 'GitHub への接続を取り消しました。';

export interface GitHubImport {
  config: GitHubAppConfig | null;
  /** App のインストール・権限設定の画面。 */
  installUrl: string | null;
  /**
   * 正規でないオリジンで開かれているとき、正規のオリジンの URL。接続は始めさせない。
   * 正規のオリジン（または固定していない配信）なら null。
   */
  canonicalUrl: string | null;
  state: GitHubImportState;
  open: () => void;
  close: () => void;
  /** 同意のうえで認可を始める。GitHub へ画面遷移する。 */
  connect: () => Promise<void>;
  disconnect: () => void;
  retry: () => void;
  dismissError: () => void;
  reloadRepositories: () => void;
  selectRepository: (repository: GitHubRepository) => void;
  clearRepository: () => void;
  /**
   * リポジトリの一覧を取り直して選び直す。リポジトリが消えた・見えなくなった・空だった
   * ときの次の手（手元の一覧は古いので、選び直す前に取り直す）。
   */
  reselectRepository: () => void;
  showBranches: () => void;
  hideBranches: () => void;
  selectBranch: (ref: string) => void;
  /** 同じブランチの最新コミットを解決し直す。明示的な操作でだけ追従する。 */
  refreshSnapshot: () => void;
  enterDirectory: (entry: GitHubTreeEntry) => void;
  goTo: (index: number) => void;
  selectFile: (entry: GitHubTreeEntry) => void;
  setSelected: (path: string, selected: boolean) => void;
  clearCandidate: () => void;
  /** 選択を列挙し、取得の前に件数・容量を確かめる画面へ進む。 */
  prepareSelection: () => void;
  /** 確かめた計画の全件を取得・検証する。 */
  fetchBatch: () => void;
  /** 確認画面で決めた取り込み方法を覚える。ダイアログを閉じても残る。 */
  chooseBatch: (choices: BatchChoices) => void;
  clearBatch: () => void;
  /** 1件の取り込みを確定したあとに呼ぶ。ダイアログを閉じ、複数選択は残す。 */
  finish: () => void;
  /** 一括取り込みを確定したあとに呼ぶ。選択を片付けてダイアログを閉じる。 */
  finishBatch: () => void;
  /**
   * 確定した一括取り込みを「元に戻す」で取り消したとき、確認画面を決めた内容ごと開き直す。
   * 取得済みの候補を使うので、GitHub へは要求しない。
   */
  restoreBatch: () => void;
}

/** 暗号学的な乱数を base64url にする。32 バイトで verifier は 43 文字になる。 */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function removePendingAuth(): void {
  try {
    sessionStorage.removeItem(PENDING_AUTH_KEY);
  } catch {
    // 読めない環境なら、そもそも書けていない。
  }
}

function readPendingAuth(): string | null {
  try {
    return sessionStorage.getItem(PENDING_AUTH_KEY);
  } catch {
    return null;
  }
}

export interface GitHubImportOptions {
  /**
   * 認可のために GitHub の画面へ移る直前に呼ぶ。false を返したら移らない。
   *
   * 移ると今のページは破棄され、戻ってきたときは保存済みの内容から始まる。
   * 保存できていない作業があるまま離れさせないために、App が保存の書き出しを渡す。
   */
  beforeNavigate?: () => boolean;
}

/**
 * 「GitHubから追加」の通信と状態をまとめる。
 *
 * - アクセストークンは**この中の ref にだけ**持つ。localStorage・sessionStorage・
 *   ワークスペース・作業データのどこにも書かない（リロードやタブを閉じたら接続し直す）。
 * - sessionStorage に置くのは、リダイレクトを跨ぐ state と PKCE verifier だけ。
 *   戻ってきたら、検証の成否にかかわらず読んだ時点で消す。
 * - 取得した内容はワークスペースへ直接入れない。候補として返し、確定は App が行う。
 */
export function useGitHubImport(options: GitHubImportOptions = {}): GitHubImport {
  const [state, dispatch] = useReducer(githubImportReducer, initialGitHubImportState);

  // 一括取り込みの途中の内容（計画・取得した本文・決めた取り込み方法）はメモリにだけある。
  // ダイアログを閉じても残すようにしたので、次に起きやすい取り違えは再読み込みやタブを閉じること。
  // 対応するブラウザでは離れる前に確かめる（スマホでは出ないことがあるので、画面にも書いてある）。
  const batchInProgress = state.batchPlan !== null || state.batchCandidates !== null;
  useEffect(() => {
    if (!batchInProgress) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [batchInProgress]);
  const tokenRef = useRef<GitHubToken | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * tree は SHA で内容が決まるので、一度取ったものは使い回す（戻る操作で取り直さない）。
   * キーはリポジトリ・tree SHA・パスの組（`loadListing` を参照）。
   */
  const treeCache = useRef(new Map<string, NormalizedTree>());
  /**
   * 一括取り込みで取れた blob（キーはリポジトリと blob SHA）。blob は内容で決まる SHA で
   * 取るので中身は変わらない。1件の失敗や1件の選び直し、通信切れの再試行で、取れていた分まで
   * 取り直して利用上限を使わないように持つ。固定し直し・切断・一括の確定で捨てる。
   */
  const blobCache = useRef(new Map<string, ArrayBuffer>());
  /** 直前に失敗した操作。「再試行」で同じことをやり直す。 */
  const lastTask = useRef<(() => void) | null>(null);
  /** 直前に確定した一括取り込みの控え。「元に戻す」で確認画面へ戻すのに使う。 */
  const suspendedBatch = useRef<SuspendedBatch | null>(null);
  const handledCallback = useRef(false);
  /**
   * ページを離れた（bfcache に入った）回数。トークン交換は中断口を共有しないので、
   * 離れる前に始めた交換が戻ったあとに返ってきても、その結果でトークンを持ち直さない。
   */
  const pageLeft = useRef(0);
  /**
   * 接続の手続き（認可の画面へ移る準備と、戻ったあとのトークン交換）の世代。
   * 途中で「閉じる」と進め、それより前に始めた手続きの結果を捨てる。
   * 交換はコードが1回しか使えないので fetch 自体は止めないが、閉じたあとに返った
   * トークンは持たない（閉じたのに裏で接続が完了し、一覧を取りに行く、を起こさない）。
   *
   * `pageLeft` とは契機が別（こちらは閉じる、あちらは bfcache）なので、交換の結果は
   * 両方の世代が変わっていないときだけ採用する。
   */
  const attempt = useRef(0);
  const canonicalUrl = APP_CONFIG ? nonCanonicalTarget(APP_CONFIG, window.location.origin) : null;

  /** 進行中の取得を止めて、新しい取得の中断口を作る。 */
  const begin = (): AbortController => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };

  const dropConnection = (notice: string | null): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    tokenRef.current = null;
    treeCache.current.clear();
    blobCache.current.clear();
    lastTask.current = null;
    dispatch({ type: 'disconnect', notice });
  };

  /** 使えるトークンがあればクライアントを作る。期限切れなら接続を切る。 */
  const client = (): GitHubClient | null => {
    const token = tokenRef.current;
    if (!token || !isTokenUsable(token, Date.now())) {
      dropConnection(token ? EXPIRED_NOTICE : null);
      return null;
    }
    return createGitHubClient(token.accessToken);
  };

  /**
   * GitHub への取得を1つ走らせる。失敗は分類して画面に出し、401 なら接続を切る。
   * 新しい取得を始めると前の取得は中断する（遅れて返った古い応答で画面を戻さない）。
   */
  const run = <T>(
    stage: GitHubFetchStage,
    label: string,
    task: (api: GitHubClient, signal: AbortSignal) => Promise<T>,
    onDone: (value: T) => void,
    /** 選んでいたブランチが見つからないとき、ブランチの一覧へ戻す（`recoveryFor`）。 */
    chooseBranch?: () => void,
  ): void => {
    const api = client();
    if (!api) return;
    const again = (): void => run(stage, label, task, onDone, chooseBranch);
    lastTask.current = again;
    // rate limit が解けるまでは、どの操作から来ても GitHub へ要求しない。止めるのが
    // 「再試行」ボタンだけだと、計画画面の「取得」や開き直しから解除前に要求できてしまう。
    const until = state.rateLimitedUntil;
    if (until !== null && rateLimitWaitMs(until, Date.now()) > 0) {
      dispatch({
        type: 'fail',
        error: {
          message: describeGitHubError({ kind: 'rateLimited', status: null, resetAt: until }),
          recover: 'retry',
        },
      });
      return;
    }
    const controller = begin();
    dispatch({ type: 'busy', label });
    task(api, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) onDone(value);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GitHubBatchPreparationError) {
          dispatch({ type: 'fail', error: { message: error.message, recover: 'dismiss' } });
          return;
        }
        const requestFailure =
          error instanceof GitHubBatchRequestError
            ? { detail: error.requestError.detail, prefix: `${revealUnsafeChars(error.path)}: ` }
            : error instanceof GitHubRequestError
              ? { detail: error.detail, prefix: '' }
              : null;
        if (requestFailure) {
          const { detail, prefix } = requestFailure;
          const message = `${prefix}${describeGitHubError(detail)}`;
          if (detail.kind === 'unauthorized') {
            dropConnection(message);
            return;
          }
          // やり直しても変わらない失敗に「再試行」を出さない（段階ごとに戻る先を決める）。
          const recovery = recoveryFor(detail, stage);
          if (recovery === 'chooseBranch' && chooseBranch) {
            chooseBranch();
            return;
          }
          dispatch({
            type: 'fail',
            error: {
              message,
              recover: recovery === 'chooseBranch' ? 'retry' : recovery,
            },
            // rate limit は解除時刻まで GitHub への要求そのものを止める（表示している時刻と一致させる）。
            ...(detail.kind === 'rateLimited' && detail.resetAt !== null
              ? { rateLimitedUntil: detail.resetAt }
              : {}),
          });
          return;
        }
        console.error('GitHub からの取得に失敗しました', error);
        dispatch({
          type: 'fail',
          error: { message: 'GitHub からの取得に失敗しました。', recover: 'retry' },
        });
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
      });
  };

  const prepareSelection = (): void => {
    const snapshot = state.snapshot;
    const selection = state.selection;
    if (!snapshot || !hasAnySelection(selection)) {
      dispatch({
        type: 'fail',
        error: { message: '取り込むファイルまたはフォルダを選んでください。', recover: 'dismiss' },
      });
      return;
    }
    const knownEntries = state.knownEntries;

    run(
      'tree',
      '選択範囲を確認しています（ファイルの本文はまだ取得していません）',
      async (api, signal) => {
        const found = await enumerateSelectedEntries(
          api,
          snapshot,
          selection,
          knownEntries,
          signal,
        );
        if (found.files.length === 0) {
          throw new GitHubBatchPreparationError(
            found.excluded.length > 0
              ? `選択範囲に取り込めるファイルがありません（対象外 ${found.excluded.length}件）。`
              : '選択範囲に取り込めるファイルがありません。',
          );
        }
        return found;
      },
      ({ files, excluded }) =>
        dispatch({
          type: 'batch/planned',
          commitSha: snapshot.commitSha,
          selection,
          entries: files,
          excluded,
        }),
    );
  };

  const fetchBatch = (): void => {
    const snapshot = state.snapshot;
    const plan = state.batchPlan;
    if (!snapshot || !plan) return;

    run(
      'blob',
      '選択したファイルを取得しています',
      (api, signal) =>
        fetchBatchCandidates(
          api,
          snapshot,
          plan.entries,
          blobCache.current,
          signal,
          // 件数が多いと長くかかるので、進んでいることを見せる。変わらない表示のままだと
          // 固まったと思って閉じたりやり直したりしやすい。中断したあとは表示を戻さない。
          (done, total) =>
            dispatch({
              type: 'busy',
              label: `選択したファイルを取得しています（${done} / ${total}）`,
            }),
        ),
      (candidates) => dispatch({ type: 'batch/set', selection: plan.selection, candidates }),
    );
  };

  const loadRepositories = (): void => {
    run(
      'repositories',
      'リポジトリを読み込んでいます',
      (api, signal) => api.listRepositories(signal),
      (repositories) => dispatch({ type: 'repositories/loaded', repositories }),
    );
  };

  const loadListing = (snapshot: GitHubSnapshot, step: TrailStep, info?: string): void => {
    // パスもキーに含める。中身が同じディレクトリは別の場所でも同じ tree SHA になるが、
    // 一覧の各項目はパス（出自と取り込み元の同一性に使う）を焼き込んでいるので、
    // SHA だけで使い回すと別のフォルダのパスで取り込んでしまう。
    const key = JSON.stringify([snapshot.repository.id, step.treeSha, step.path]);
    const deliver = (tree: NormalizedTree): void => {
      dispatch({
        type: 'listing/loaded',
        commitSha: snapshot.commitSha,
        listing: { treeSha: step.treeSha, path: step.path, ...tree },
      });
      if (info) dispatch({ type: 'info', message: info });
    };
    const cached = treeCache.current.get(key);
    if (cached) {
      // 裏で走っている取得（別の場所のファイルなど）が、移動のあとで割り込まないように止める。
      abortRef.current?.abort();
      abortRef.current = null;
      deliver(cached);
      return;
    }
    run(
      'tree',
      'フォルダを読み込んでいます',
      (api, signal) => api.getTree(snapshot, step.treeSha, step.path, signal),
      (tree) => {
        treeCache.current.set(key, tree);
        deliver(tree);
      },
    );
  };

  /**
   * ブランチの HEAD を解決して固定し、ルートを開く。
   *
   * 固定し直すと選択は捨てる（古いコミットで選んだものを新しいコミットへ持ち越さない）ので、
   * 捨てる選択があったときはそれも知らせる。黙って消えると、選び直しが要ることに気づけない。
   *
   * `resume` は「最新に更新」で先頭が変わっていなかったときに開き直す場所。確認を始めた
   * 時点で一覧の取得が終わっていなかったなら、その取得は確認のために中断している
   * （`run` は前の取得を止める）。「最新です」とだけ言って戻ると、一覧の無い画面に残る。
   */
  const pin = (
    repository: GitHubRepository,
    ref: string,
    options: {
      previous?: GitHubSnapshot;
      hadSelection?: boolean;
      resume?: TrailStep | undefined;
    } = {},
  ): void => {
    const { previous, hadSelection = false, resume } = options;
    run(
      'snapshot',
      `${ref} の最新コミットを確認しています`,
      (api, signal) => api.resolveSnapshot(repository, ref, signal),
      (snapshot) => {
        if (previous && previous.commitSha === snapshot.commitSha) {
          const message = `最新です（${shortSha(snapshot.commitSha)} のまま）`;
          if (resume) loadListing(previous, resume, message);
          else dispatch({ type: 'info', message });
          return;
        }
        blobCache.current.clear();
        dispatch({ type: 'snapshot/pinned', snapshot });
        const notes = [
          previous ? `${shortSha(snapshot.commitSha)} に更新しました` : null,
          hadSelection ? '選択は解除しました' : null,
        ].filter((note) => note !== null);
        loadListing(
          snapshot,
          { path: '', treeSha: snapshot.treeSha },
          notes.length > 0 ? notes.join('。') : undefined,
        );
      },
      // 一覧を取ったあとで既定ブランチが改名・削除されると、同じ ref は何度解決しても 404。
      // 再試行を押させ続けず、今あるブランチから選び直してもらう。
      () =>
        loadBranches(
          repository,
          `ブランチ ${revealUnsafeChars(ref)} が見つかりませんでした（名前が変わったか、削除された可能性があります）。ブランチを選んでください。`,
        ),
    );
  };

  /** ブランチの一覧を開く。`notice` は一覧が出たあとに添える知らせ（ここへ戻された理由）。 */
  const loadBranches = (repository: GitHubRepository, notice?: string): void => {
    dispatch({ type: 'branches/show' });
    run(
      'branches',
      'ブランチを読み込んでいます',
      (api, signal) => api.listBranches(repository, signal),
      (names) => {
        dispatch({
          type: 'branches/loaded',
          repositoryId: repository.id,
          branches: orderBranches(names, repository.defaultBranch),
        });
        if (notice) dispatch({ type: 'info', message: notice });
      },
    );
  };

  const exchangeCode = async (code: string, verifier: string): Promise<void> => {
    dispatch({ type: 'connect/start' });
    const startedPage = pageLeft.current;
    const started = attempt.current;
    /** 交換を始めてから、閉じられたか bfcache に入ったか。どちらでも結果は捨てる。 */
    const superseded = (): boolean =>
      pageLeft.current !== startedPage || attempt.current !== started;
    // 交換は中断口を共有しない。コードは1回しか使えないので、他の操作や
    // （開発時の Strict Mode による）effect の片付けで止めると、やり直せなくなる。
    try {
      const response = await fetch(new URL(TOKEN_EXCHANGE_PATH, window.location.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 送るのは交換に要る3つだけ。原稿・ルール・リポジトリの内容は載せない。
        body: JSON.stringify({
          code,
          code_verifier: verifier,
          redirect_uri: callbackUrl(window.location.origin),
        }),
        cache: 'no-store',
        credentials: 'same-origin',
      });
      // 失敗の本文は理由コードだけを読む（読めなくても状態コードで知らせる）。
      const payload: unknown = await response.json().catch(() => null);
      const token = response.ok ? parseTokenResponse(payload, Date.now()) : null;
      // 交換の途中でページを離れたか閉じられていたら、返ってきたトークンは捨てる
      // （接続は解除・取り消し済み）。
      if (superseded()) return;
      if (!token) {
        dropConnection(
          describeTokenExchangeFailure(
            response.status,
            response.ok ? null : parseExchangeErrorCode(payload),
          ),
        );
        return;
      }
      tokenRef.current = token;
      dispatch({ type: 'connect/done' });
      loadRepositories();
    } catch (error) {
      if (superseded()) return;
      console.error('GitHub のトークン交換に失敗しました', error);
      dropConnection(
        'GitHub との接続に失敗しました。ネットワークを確認して、もう一度接続してください。',
      );
    }
  };

  // 認可から戻ってきた URL を、起動直後に1回だけ処理する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 起動時の URL を1回だけ読む
  useEffect(() => {
    // Strict Mode は effect を2回走らせる。コードは1回しか交換できないので、二重に処理しない。
    if (handledCallback.current) return;
    handledCallback.current = true;

    const params = readCallbackParams(window.location.search);
    const raw = readPendingAuth();
    // 一時情報は使っても使わなくても、ここで消す（戻りでない起動なら、途中で
    // 引き返した認可の残り）。
    removePendingAuth();
    if (params.kind === 'none') return;

    const result = validateCallback(params, parsePendingAuth(raw), Date.now());
    // 検証が済んだら、成否にかかわらずコードと state を履歴とアドレスバーから消す。
    // 共有・ブックマーク・リロードで使い済みのコードが再送されないように。
    window.history.replaceState(
      window.history.state,
      '',
      stripCallbackParams(window.location.href),
    );

    dispatch({ type: 'open' });
    if (result.kind === 'error') {
      dispatch({ type: 'disconnect', notice: describeCallbackFailure(result.reason) });
      return;
    }
    void exchangeCode(result.code, result.verifier);
  }, []);

  // GitHub の画面からブラウザの「戻る」で帰ってくると、bfcache から「接続中」のまま
  // 復元される（ボタンが押せないまま残る）。引き返した認可として片付ける。
  //
  // 接続済みのまま bfcache に入ったページも、戻るとトークンごと復元される（JS のヒープが
  // そのまま戻る）。共用の端末で次の人が「戻る」を押すと、前の利用者の権限でリポジトリを
  // 読めてしまうので、bfcache に入る時点（persisted な pagehide）でトークンを捨てる。
  // 戻ったとき（persisted な pageshow）にも念のため同じ片付けをする。
  // タブの切り替え（visibilitychange）では切らない。ページはそのまま残っているため。
  useEffect(() => {
    const releaseToken = (): void => {
      pageLeft.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      tokenRef.current = null;
      treeCache.current.clear();
      lastTask.current = null;
      dispatch({ type: 'page/persisted' });
    };
    const onPageHide = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      // 認可の画面へ移るとき（接続中）もここを通る。戻り先で使う state と verifier は
      // 消さない（新しいページの読み込みで使う）。
      releaseToken();
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      removePendingAuth();
      dispatch({ type: 'connect/abandon' });
      releaseToken();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  // 画面を離れるときに取得中の通信を止める。
  useEffect(() => () => abortRef.current?.abort(), []);

  const connect = async (): Promise<void> => {
    if (!APP_CONFIG || canonicalUrl || state.connection !== 'disconnected') return;
    // 押した時点で「接続中」にしてボタンを止める。二重に押すと認可が2本走り、
    // 保存した state と戻ってきた state が食い違う。
    dispatch({ type: 'connect/start' });
    if (!crypto.subtle) {
      dispatch({
        type: 'disconnect',
        notice: 'このブラウザでは安全な接続の準備ができません（HTTPS で開いてください）。',
      });
      return;
    }
    const started = attempt.current;
    const pending = { state: randomToken(), verifier: randomToken(), createdAt: Date.now() };
    const codeChallenge = await codeChallengeS256(pending.verifier, crypto.subtle);
    // 準備の間に閉じられていたら、認可の画面へは移らない。
    if (attempt.current !== started) return;
    try {
      sessionStorage.setItem(PENDING_AUTH_KEY, serializePendingAuth(pending));
    } catch {
      dispatch({
        type: 'disconnect',
        notice: 'このブラウザの設定では接続の一時情報を保存できないため、接続できません。',
      });
      return;
    }
    // 保存はデバウンスしているので、押す直前の編集はまだ書かれていないことがある。
    // 表示中の「保存に失敗している」は最後に実行済みの保存の結果でしかないため、
    // 離れる直前にその場で書き出し、書けなければ移らない。
    if (options.beforeNavigate && !options.beforeNavigate()) {
      removePendingAuth();
      dispatch({
        type: 'disconnect',
        // 書き出しの案内は、同時に出る保存失敗の警告（saveFailed）に任せる。
        notice: 'ブラウザへの保存に失敗したため、GitHub への接続を中止しました。',
      });
      return;
    }
    window.location.assign(
      buildAuthorizeUrl({
        clientId: APP_CONFIG.clientId,
        redirectUri: callbackUrl(window.location.origin),
        state: pending.state,
        codeChallenge,
      }),
    );
  };

  return {
    config: APP_CONFIG,
    installUrl: APP_CONFIG ? installationUrl(APP_CONFIG) : null,
    canonicalUrl,
    state,
    open: () => {
      dispatch({ type: 'open' });
      if (state.connection !== 'connected') return;
      if (!client()) return;
      // 閉じたときに取得を中断しているので、途中だったものをやり直す。
      const step = currentStep(state);
      if (state.repositories === null) loadRepositories();
      else if (state.choosingBranch && state.branches === null && state.repository) {
        loadBranches(state.repository);
      } else if (state.snapshot && state.listing === null && step) {
        loadListing(state.snapshot, step);
      } else if (state.repository && !state.snapshot && !state.choosingBranch) {
        // 既定ブランチが分からないリポジトリでは、選ぶ前の一覧に戻す（空の ref で固定しない）。
        if (state.repository.defaultBranch) pin(state.repository, state.repository.defaultBranch);
        else loadBranches(state.repository);
      }
    },
    close: () => {
      abortRef.current?.abort();
      abortRef.current = null;
      // 接続の途中で閉じたら、手続きを取り消す（裏で接続を完了させない）。
      // 閉じたら終わり、という見た目どおりの意味にする。
      if (state.connection === 'connecting') {
        attempt.current += 1;
        removePendingAuth();
        dispatch({ type: 'disconnect', notice: CANCELLED_NOTICE });
      }
      dispatch({ type: 'close' });
    },
    connect,
    disconnect: () => dropConnection(null),
    retry: () => {
      // ボタンは解除時刻まで押せないが、手続きの側でも解除前の再試行を通さない。
      if (rateLimitWaitMs(state.rateLimitedUntil, Date.now()) > 0) return;
      lastTask.current?.();
    },
    dismissError: () => dispatch({ type: 'error/dismiss' }),
    reloadRepositories: loadRepositories,
    selectRepository: (repository) => {
      dispatch({ type: 'repository/select', repository });
      // 既定ブランチが分からなければ、推測せずに選んでもらう。
      if (!repository.defaultBranch) {
        loadBranches(repository);
        return;
      }
      pin(repository, repository.defaultBranch);
    },
    clearRepository: () => {
      abortRef.current?.abort();
      dispatch({ type: 'repository/clear' });
    },
    reselectRepository: () => {
      abortRef.current?.abort();
      dispatch({ type: 'repository/clear' });
      loadRepositories();
    },
    showBranches: () => {
      if (state.repository) loadBranches(state.repository);
    },
    hideBranches: () => {
      abortRef.current?.abort();
      dispatch({ type: 'branches/hide' });
      // ブランチの一覧を開いた時点で、元の一覧の取得を中断していることがある
      // （一覧を待たずに「ブランチを変更」を押した）。戻る先に一覧が無ければ取り直す。
      const step = currentStep(state);
      if (state.snapshot && state.listing === null && step) loadListing(state.snapshot, step);
    },
    selectBranch: (ref) => {
      if (state.repository) {
        pin(state.repository, ref, { hadSelection: hasAnySelection(state.selection) });
      }
    },
    refreshSnapshot: () => {
      const snapshot = state.snapshot;
      if (!snapshot) return;
      // 一覧を待っている途中で押されたら、先頭が変わっていなくても今の場所を開き直す。
      const resume = state.listing === null ? currentStep(state) : undefined;
      pin(snapshot.repository, snapshot.ref, {
        previous: snapshot,
        hadSelection: hasAnySelection(state.selection),
        resume,
      });
    },
    enterDirectory: (entry) => {
      const snapshot = state.snapshot;
      if (!snapshot || entry.status !== 'dir') return;
      const step = { path: entry.path, treeSha: entry.sha };
      dispatch({ type: 'dir/enter', step });
      loadListing(snapshot, step);
    },
    goTo: (index) => {
      const snapshot = state.snapshot;
      const step = state.trail[index];
      if (!snapshot || !step || index === state.trail.length - 1) return;
      dispatch({ type: 'dir/goTo', index });
      loadListing(snapshot, step);
    },
    setSelected: (path, selected) => dispatch({ type: 'selection/set', path, selected }),
    selectFile: (entry) => {
      const snapshot = state.snapshot;
      if (!snapshot || entry.status !== 'importable') return;
      run(
        'blob',
        `${entry.name} を取得しています`,
        (api, signal) => getBlobWithinLimit(api, snapshot, entry, signal),
        (buffer) => {
          const result = buildCandidate(snapshot, entry, buffer);
          if (result.kind === 'error') {
            dispatch({ type: 'fail', error: { message: result.message, recover: 'dismiss' } });
            return;
          }
          dispatch({ type: 'candidate/set', candidate: result.candidate });
        },
      );
    },
    clearCandidate: () => dispatch({ type: 'candidate/clear' }),
    prepareSelection,
    fetchBatch,
    chooseBatch: (choices) => dispatch({ type: 'batch/choose', choices }),
    clearBatch: () => {
      // 取得の途中で戻ったら、残りの取得も止める（GitHub の利用上限を使い続けない）。
      abortRef.current?.abort();
      abortRef.current = null;
      dispatch({ type: 'batch/clear' });
    },
    finish: () => {
      // 1件だけ確かめて取り込む操作は、複数選択を組んでいる途中でも自然に行う。
      // 組んだ選択は黙って捨てず、開き直せば続けられるように残す。
      dispatch({ type: 'candidate/clear' });
      dispatch({ type: 'close' });
    },
    finishBatch: () => {
      // 取り消されたら確認画面へ戻せるよう、候補と決めた内容を控えておく（取り直させない）。
      suspendedBatch.current = state.batchCandidates
        ? {
            selection: state.selection,
            candidates: state.batchCandidates,
            choices: state.batchChoices,
          }
        : null;
      // 一括で取り込んだ選択は役目を終えたので片付ける。取り消しで戻る確認画面は控えた候補を
      // 使うので、blob の控えはもう要らない。
      blobCache.current.clear();
      dispatch({ type: 'batch/clear' });
      dispatch({ type: 'selection/clear' });
      dispatch({ type: 'close' });
    },
    restoreBatch: () => {
      const batch = suspendedBatch.current;
      suspendedBatch.current = null;
      if (!batch) return;
      dispatch({ type: 'batch/restore', batch });
      dispatch({ type: 'open' });
    },
  };
}
