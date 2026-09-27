import { useEffect, useReducer, useRef } from 'react';
import { createGitHubClient, type GitHubClient, GitHubRequestError } from '../github/client';
import { mapWithConcurrency } from '../lib/concurrency';
import {
  buildCandidate,
  compareCodePoints,
  describeGitHubError,
  type NormalizedTree,
  orderBranches,
} from '../lib/githubApi';
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  callbackUrl,
  codeChallengeS256,
  describeCallbackFailure,
  type GitHubAppConfig,
  type GitHubToken,
  installationUrl,
  isTokenUsable,
  PENDING_AUTH_KEY,
  parsePendingAuth,
  parseTokenResponse,
  readCallbackParams,
  readGitHubAppConfig,
  serializePendingAuth,
  stripCallbackParams,
  TOKEN_EXCHANGE_PATH,
  validateCallback,
} from '../lib/githubAuth';
import {
  type GitHubTreeSelection,
  hasAnySelection,
  includedSelectionRoots,
  isPathSelected,
  selectionMayContainSelected,
} from '../lib/githubSelection';
import { shortSha } from '../lib/inputSource';
import {
  currentStep,
  type GitHubImportState,
  githubImportReducer,
  initialGitHubImportState,
  rateLimitWaitMs,
  type TrailStep,
} from '../state/githubImport';
import type { GitHubRepository, GitHubSnapshot, GitHubTreeEntry } from '../types';

/** ビルド時に決まる公開設定。未設定の配信では null（ボタンを無効にする）。 */
const APP_CONFIG: GitHubAppConfig | null = readGitHubAppConfig(import.meta.env);

const EXPIRED_NOTICE = 'GitHub との接続の有効期限が切れました。もう一度接続してください。';

const BLOB_CONCURRENCY = 4;

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

export async function enumerateSelectedEntries(
  api: GitHubClient,
  snapshot: GitHubSnapshot,
  selection: GitHubTreeSelection,
  knownEntries: ReadonlyMap<string, GitHubTreeEntry>,
  signal: AbortSignal,
): Promise<GitHubTreeEntry[]> {
  const queue: Array<{ path: string; treeSha: string }> = [];
  const files: GitHubTreeEntry[] = [];
  const seen = new Set<string>();

  const collect = (entries: readonly GitHubTreeEntry[]): void => {
    for (const entry of entries) {
      if (
        entry.status === 'importable' &&
        isPathSelected(selection, entry.path) &&
        !seen.has(entry.path)
      ) {
        seen.add(entry.path);
        files.push(entry);
      }
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
        `${path} の場所を確認できませんでした。フォルダを開き直して選び直してください。`,
      );
    }
    if (entry.status === 'importable') {
      collect([entry]);
    } else if (entry.status === 'dir') {
      queue.push({ path: entry.path, treeSha: entry.sha });
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
        `${step.path || 'ルート'} の一覧が途中で打ち切られたため、安全に一括取り込みできません。`,
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
  return files;
}

export interface GitHubImport {
  config: GitHubAppConfig | null;
  /** App のインストール・権限設定の画面。 */
  installUrl: string | null;
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
  clearBatch: () => void;
  /** 1件の取り込みを確定したあとに呼ぶ。ダイアログを閉じ、複数選択は残す。 */
  finish: () => void;
  /** 一括取り込みを確定したあとに呼ぶ。選択を片付けてダイアログを閉じる。 */
  finishBatch: () => void;
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

/**
 * 「GitHubから追加」の通信と状態をまとめる。
 *
 * - アクセストークンは**この中の ref にだけ**持つ。localStorage・sessionStorage・
 *   ワークスペース・作業データのどこにも書かない（リロードやタブを閉じたら接続し直す）。
 * - sessionStorage に置くのは、リダイレクトを跨ぐ state と PKCE verifier だけ。
 *   戻ってきたら、検証の成否にかかわらず読んだ時点で消す。
 * - 取得した内容はワークスペースへ直接入れない。候補として返し、確定は App が行う。
 */
export function useGitHubImport(): GitHubImport {
  const [state, dispatch] = useReducer(githubImportReducer, initialGitHubImportState);
  const tokenRef = useRef<GitHubToken | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * tree は SHA で内容が決まるので、一度取ったものは使い回す（戻る操作で取り直さない）。
   * キーはリポジトリ・tree SHA・パスの組（`loadListing` を参照）。
   */
  const treeCache = useRef(new Map<string, NormalizedTree>());
  /** 直前に失敗した操作。「再試行」で同じことをやり直す。 */
  const lastTask = useRef<(() => void) | null>(null);
  const handledCallback = useRef(false);

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
    label: string,
    task: (api: GitHubClient, signal: AbortSignal) => Promise<T>,
    onDone: (value: T) => void,
  ): void => {
    const api = client();
    if (!api) return;
    const again = (): void => run(label, task, onDone);
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
            ? { detail: error.requestError.detail, prefix: `${error.path}: ` }
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
          dispatch({
            type: 'fail',
            error: {
              message,
              // 一覧が長すぎるのは、やり直しても同じ結果で rate limit を食うだけなので再試行させない。
              recover: detail.kind === 'listTooLong' ? 'dismiss' : 'retry',
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
      '選択範囲を確認しています（ファイルの本文はまだ取得していません）',
      async (api, signal) => {
        const entries = await enumerateSelectedEntries(
          api,
          snapshot,
          selection,
          knownEntries,
          signal,
        );
        if (entries.length === 0) {
          throw new GitHubBatchPreparationError('選択範囲に取り込めるファイルがありません。');
        }
        return entries;
      },
      (entries) =>
        dispatch({ type: 'batch/planned', commitSha: snapshot.commitSha, selection, entries }),
    );
  };

  const fetchBatch = (): void => {
    const snapshot = state.snapshot;
    const plan = state.batchPlan;
    if (!snapshot || !plan) return;

    run(
      '選択したファイルを取得しています',
      (api, signal) =>
        mapWithConcurrency(plan.entries, BLOB_CONCURRENCY, signal, async (entry, requestSignal) => {
          let buffer: ArrayBuffer;
          try {
            buffer = await api.getBlob(snapshot, entry.sha, requestSignal);
          } catch (error) {
            if (error instanceof GitHubRequestError) {
              throw new GitHubBatchRequestError(entry.path, error);
            }
            throw error;
          }
          const result = buildCandidate(snapshot, entry, buffer);
          if (result.kind === 'error') throw new GitHubBatchPreparationError(result.message);
          return result.candidate;
        }),
      (candidates) => dispatch({ type: 'batch/set', selection: plan.selection, candidates }),
    );
  };

  const loadRepositories = (): void => {
    run(
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
   */
  const pin = (
    repository: GitHubRepository,
    ref: string,
    options: { previous?: GitHubSnapshot; hadSelection?: boolean } = {},
  ): void => {
    const { previous, hadSelection = false } = options;
    run(
      `${ref} の最新コミットを確認しています`,
      (api, signal) => api.resolveSnapshot(repository, ref, signal),
      (snapshot) => {
        if (previous && previous.commitSha === snapshot.commitSha) {
          dispatch({ type: 'info', message: `最新です（${shortSha(snapshot.commitSha)} のまま）` });
          return;
        }
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
    );
  };

  const loadBranches = (repository: GitHubRepository): void => {
    dispatch({ type: 'branches/show' });
    run(
      'ブランチを読み込んでいます',
      (api, signal) => api.listBranches(repository, signal),
      (names) =>
        dispatch({
          type: 'branches/loaded',
          repositoryId: repository.id,
          branches: orderBranches(names, repository.defaultBranch),
        }),
    );
  };

  const exchangeCode = async (code: string, verifier: string): Promise<void> => {
    dispatch({ type: 'connect/start' });
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
      const token = response.ok ? parseTokenResponse(await response.json(), Date.now()) : null;
      if (!token) {
        dropConnection(
          `GitHub との接続に失敗しました（トークンの交換に失敗: ${response.status}）。もう一度接続してください。`,
        );
        return;
      }
      tokenRef.current = token;
      dispatch({ type: 'connect/done' });
      loadRepositories();
    } catch (error) {
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
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      removePendingAuth();
      dispatch({ type: 'connect/abandon' });
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // 画面を離れるときに取得中の通信を止める。
  useEffect(() => () => abortRef.current?.abort(), []);

  const connect = async (): Promise<void> => {
    if (!APP_CONFIG || state.connection !== 'disconnected') return;
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
    const pending = { state: randomToken(), verifier: randomToken(), createdAt: Date.now() };
    const codeChallenge = await codeChallengeS256(pending.verifier, crypto.subtle);
    try {
      sessionStorage.setItem(PENDING_AUTH_KEY, serializePendingAuth(pending));
    } catch {
      dispatch({
        type: 'disconnect',
        notice: 'このブラウザの設定では接続の一時情報を保存できないため、接続できません。',
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
    showBranches: () => {
      if (state.repository) loadBranches(state.repository);
    },
    hideBranches: () => {
      abortRef.current?.abort();
      dispatch({ type: 'branches/hide' });
    },
    selectBranch: (ref) => {
      if (state.repository) {
        pin(state.repository, ref, { hadSelection: hasAnySelection(state.selection) });
      }
    },
    refreshSnapshot: () => {
      const snapshot = state.snapshot;
      if (snapshot) {
        pin(snapshot.repository, snapshot.ref, {
          previous: snapshot,
          hadSelection: hasAnySelection(state.selection),
        });
      }
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
        `${entry.name} を取得しています`,
        (api, signal) => api.getBlob(snapshot, entry.sha, signal),
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
      // 一括で取り込んだ選択は役目を終えたので片付ける。
      dispatch({ type: 'batch/clear' });
      dispatch({ type: 'selection/clear' });
      dispatch({ type: 'close' });
    },
  };
}
