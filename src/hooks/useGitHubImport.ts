import { useEffect, useReducer, useRef } from 'react';
import { createGitHubClient, type GitHubClient, GitHubRequestError } from '../github/client';
import {
  buildCandidate,
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
  describeTokenExchangeFailure,
  type GitHubAppConfig,
  type GitHubToken,
  installationUrl,
  isTokenUsable,
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
import { shortSha } from '../lib/inputSource';
import {
  currentStep,
  type GitHubImportState,
  githubImportReducer,
  initialGitHubImportState,
  type TrailStep,
} from '../state/githubImport';
import type { GitHubRepository, GitHubSnapshot, GitHubTreeEntry } from '../types';

/** ビルド時に決まる公開設定。未設定の配信では null（ボタンを無効にする）。 */
const APP_CONFIG: GitHubAppConfig | null = readGitHubAppConfig(import.meta.env);

const EXPIRED_NOTICE = 'GitHub との接続の有効期限が切れました。もう一度接続してください。';

const CANCELLED_NOTICE = 'GitHub への接続を取り消しました。';

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
  clearCandidate: () => void;
  /** 取り込みを確定したあとに呼ぶ。ダイアログを閉じる。 */
  finish: () => void;
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
  /**
   * 接続の手続き（認可の画面へ移る準備と、戻ったあとのトークン交換）の世代。
   * 途中で「閉じる」と進め、それより前に始めた手続きの結果を捨てる。
   * 交換はコードが1回しか使えないので fetch 自体は止めないが、閉じたあとに返った
   * トークンは持たない（閉じたのに裏で接続が完了し、一覧を取りに行く、を起こさない）。
   */
  const attempt = useRef(0);

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
    const controller = begin();
    dispatch({ type: 'busy', label });
    task(api, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) onDone(value);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GitHubRequestError) {
          if (error.detail.kind === 'unauthorized') {
            dropConnection(describeGitHubError(error.detail));
            return;
          }
          dispatch({
            type: 'fail',
            error: {
              message: describeGitHubError(error.detail),
              // 一覧が長すぎるのは、やり直しても同じ結果で rate limit を食うだけなので再試行させない。
              recover: error.detail.kind === 'listTooLong' ? 'dismiss' : 'retry',
            },
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

  /** ブランチの HEAD を解決して固定し、ルートを開く。 */
  const pin = (repository: GitHubRepository, ref: string, previous?: GitHubSnapshot): void => {
    run(
      `${ref} の最新コミットを確認しています`,
      (api, signal) => api.resolveSnapshot(repository, ref, signal),
      (snapshot) => {
        if (previous && previous.commitSha === snapshot.commitSha) {
          dispatch({ type: 'info', message: `最新です（${shortSha(snapshot.commitSha)} のまま）` });
          return;
        }
        dispatch({ type: 'snapshot/pinned', snapshot });
        loadListing(
          snapshot,
          { path: '', treeSha: snapshot.treeSha },
          previous ? `${shortSha(snapshot.commitSha)} に更新しました` : undefined,
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
    const started = attempt.current;
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
      // 交換の途中で閉じられていたら、返ってきたトークンは捨てる（取り消し済み）。
      if (attempt.current !== started) return;
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
      if (attempt.current !== started) return;
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
    retry: () => lastTask.current?.(),
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
      if (state.repository) pin(state.repository, ref);
    },
    refreshSnapshot: () => {
      const snapshot = state.snapshot;
      if (snapshot) pin(snapshot.repository, snapshot.ref, snapshot);
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
    finish: () => {
      dispatch({ type: 'candidate/clear' });
      dispatch({ type: 'close' });
    },
  };
}
