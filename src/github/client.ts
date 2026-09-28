import {
  BLOB_STALL_TIMEOUT_MS,
  classifyErrorResponse,
  classifyFetchFailure,
  encodePath,
  GITHUB_API_ORIGIN,
  GITHUB_FETCH_INIT,
  type GitHubError,
  githubRequestHeaders,
  MAX_BLOB_BYTES,
  METADATA_TIMEOUT_MS,
  mergeRepositories,
  type NormalizedTree,
  normalizeBranches,
  normalizeCommitTreeSha,
  normalizeInstallations,
  normalizeRecursiveTree,
  normalizeRefCommitSha,
  normalizeRepositories,
  normalizeTree,
  PER_PAGE,
  parseNextLink,
  RECURSIVE_TREE_TIMEOUT_MS,
  readErrorMessage,
  timeoutError,
} from '../lib/githubApi';
import type { GitHubRepository, GitHubSnapshot } from '../types';
import { type Deadline, documentVisibility, type VisibilitySource, withDeadline } from './deadline';

/**
 * GitHub REST API への通信。ブラウザから api.github.com へ直接行く。
 *
 * 原稿やリポジトリの内容は自前のバックエンドを通さない（Vercel Function が
 * 受け持つのはトークン交換だけ）。応答の解釈は `src/lib/githubApi.ts` の純粋関数に
 * 任せ、ここは送ることと失敗の分類だけを持つ。副作用があるのでユニットテストの
 * 計測対象から外し、画面の流れは E2E（モックした GitHub）で確かめる。
 */

/** 分類済みの失敗。呼び出し側は `error.kind` で分岐する。 */
export class GitHubRequestError extends Error {
  readonly detail: GitHubError;

  constructor(detail: GitHubError) {
    super(`GitHub API: ${detail.kind}${detail.status === null ? '' : ` (${detail.status})`}`);
    this.name = 'GitHubRequestError';
    this.detail = detail;
  }
}

/**
 * 一覧の取得で辿るページ数の上限（1ページ 100 件なので 1 万件）。応答が壊れていても
 * 無限に回らないための歯止め。上限に達してもまだ続きがあるときは、途中までの一覧を
 * 返さずに失敗させる（「無い」と「上限で見えていない」を取り違えさせない）。
 */
export const MAX_PAGES = 100;

const JSON_ACCEPT = 'application/vnd.github+json';
/** blob を base64 の JSON ではなく生のバイト列で受け取る。 */
const RAW_ACCEPT = 'application/vnd.github.raw+json';

export interface GitHubClient {
  /** App のインストール経由でアクセスできるリポジトリ。 */
  listRepositories(signal: AbortSignal): Promise<GitHubRepository[]>;
  listBranches(repository: GitHubRepository, signal: AbortSignal): Promise<string[]>;
  /** ブランチの今の HEAD を解決して固定する。 */
  resolveSnapshot(
    repository: GitHubRepository,
    ref: string,
    signal: AbortSignal,
  ): Promise<GitHubSnapshot>;
  /** 固定したスナップショットの中の1階層。`dir` はその tree の置かれたパス。 */
  getTree(
    snapshot: GitHubSnapshot,
    treeSha: string,
    dir: string,
    signal: AbortSignal,
  ): Promise<NormalizedTree>;
  /** 固定した tree 以下を recursive API で一括取得する。truncated はそのまま返す。 */
  getTreeRecursive(
    snapshot: GitHubSnapshot,
    treeSha: string,
    dir: string,
    signal: AbortSignal,
  ): Promise<NormalizedTree>;
  getBlob(snapshot: GitHubSnapshot, blobSha: string, signal: AbortSignal): Promise<ArrayBuffer>;
}

/** 1リクエストに掛ける待ち時間（ミリ秒）。テストで短くできるよう差し替えられる。 */
export interface GitHubTimeouts {
  metadataMs: number;
  recursiveTreeMs: number;
  /** blob を1バイトも受け取れていない時間（ヘッダ待ちを含む）。 */
  blobStallMs: number;
}

export const DEFAULT_GITHUB_TIMEOUTS: GitHubTimeouts = {
  metadataMs: METADATA_TIMEOUT_MS,
  recursiveTreeMs: RECURSIVE_TREE_TIMEOUT_MS,
  blobStallMs: BLOB_STALL_TIMEOUT_MS,
};

export interface GitHubClientOptions {
  timeouts?: Partial<GitHubTimeouts>;
  visibility?: VisibilitySource | null;
  /** 失敗した時点のオンライン状態。false のときだけ「オフライン」と分類する。 */
  isOnline?: () => boolean | undefined;
}

function browserOnline(): boolean | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.onLine;
}

function invalidResponse(): GitHubRequestError {
  return new GitHubRequestError({ kind: 'invalidResponse', status: null, resetAt: null });
}

function repoPath(repository: GitHubRepository): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

export function createGitHubClient(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  options: GitHubClientOptions = {},
): GitHubClient {
  const timeouts = { ...DEFAULT_GITHUB_TIMEOUTS, ...options.timeouts };
  const visibility = options.visibility === undefined ? documentVisibility() : options.visibility;
  const isOnline = options.isOnline ?? browserOnline;

  /**
   * 1リクエストを期限付きで走らせる。期限は本文を読み終えるまで効かせる（`run` の中で読む）。
   * 呼び出し側の中断はそのまま投げ直し、時間切れだけを `timeout` の失敗にする。
   */
  const limited = <T>(
    signal: AbortSignal,
    ms: number,
    stall: boolean,
    run: (deadline: Deadline) => Promise<T>,
  ): Promise<T> =>
    withDeadline(
      signal,
      ms,
      run,
      () => new GitHubRequestError(timeoutError(ms, stall)),
      (error) => error instanceof GitHubRequestError,
      visibility,
    );

  const request = async (url: string, accept: string, signal: AbortSignal): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        // 送るヘッダは GitHub の CORS が許すものだけ（`githubRequestHeaders` を参照）。
        headers: githubRequestHeaders(accessToken, accept),
        signal,
        ...GITHUB_FETCH_INIT,
      });
    } catch (error) {
      // 中断は失敗ではない。呼び出し側が無視できるよう、そのまま投げ直す
      // （時間切れによる中断は `limited` が `timeout` に置き換える）。
      if (signal.aborted) throw error;
      throw new GitHubRequestError(classifyFetchFailure(isOnline()));
    }
    if (!response.ok) {
      // secondary rate limit と SAML SSO は本文の message でしか見分けられない。
      const body = await response.text().catch(() => '');
      throw new GitHubRequestError(
        classifyErrorResponse(
          response.status,
          response.headers,
          readErrorMessage(body),
          Date.now(),
        ),
      );
    }
    return response;
  };

  const getJson = (
    url: string,
    signal: AbortSignal,
    ms: number = timeouts.metadataMs,
  ): Promise<{ value: unknown; next: string | null }> =>
    limited(signal, ms, false, async ({ signal: requestSignal }) => {
      const response = await request(url, JSON_ACCEPT, requestSignal);
      let value: unknown;
      try {
        value = await response.json();
      } catch (error) {
        if (requestSignal.aborted) throw error;
        throw invalidResponse();
      }
      return { value, next: parseNextLink(response.headers.get('link')) };
    });

  /**
   * blob の本文を、受信が進むたびに猶予を延ばしながら読む。受け取ったバイト数も数え、
   * 上限（`MAX_BLOB_BYTES`）を超えた時点で残りを読まずに止める（大きさが事前に分からない
   * ものを、最後までメモリへ積んでから判定しない）。
   */
  const readBlobBody = async (response: Response, deadline: Deadline): Promise<ArrayBuffer> => {
    const { signal } = deadline;
    if (!response.body) {
      // チャンクごとに猶予を延ばせないので、延ばさないまま同じ時間を合計の上限として残す
      // （無期限に待たない）。上限を超えたものは `buildCandidate` が取り込まない。
      return response.arrayBuffer();
    }
    const reader = response.body.getReader();
    // 中断したら読み取りも止める（fetch が本文の stream を止めない実装でも待ち続けない）。
    const cancel = (): void => {
      reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        // 取り消した読み取りは done で終わるので、途中までの本文を完了と取り違えない。
        if (signal.aborted) throw signal.reason;
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BLOB_BYTES) {
          await reader.cancel().catch(() => {});
          throw new GitHubRequestError({ kind: 'tooLarge', status: null, resetAt: null });
        }
        chunks.push(value);
        deadline.extend();
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  };

  /** ページを最後まで辿って集める。rate limit を食わないよう、1本ずつ順に取る。 */
  const paginate = async <T>(
    path: string,
    normalize: (value: unknown) => T[] | null,
    signal: AbortSignal,
  ): Promise<T[]> => {
    const url = new URL(path, GITHUB_API_ORIGIN);
    url.searchParams.set('per_page', String(PER_PAGE));
    const items: T[] = [];
    let next: string | null = url.toString();
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const result = await getJson(next, signal);
      const normalized = normalize(result.value);
      if (!normalized) throw invalidResponse();
      items.push(...normalized);
      next = result.next;
    }
    if (next !== null) {
      throw new GitHubRequestError({ kind: 'listTooLong', status: null, resetAt: null });
    }
    return items;
  };

  return {
    async listRepositories(signal) {
      const installations = await paginate('/user/installations', normalizeInstallations, signal);
      const lists: GitHubRepository[][] = [];
      for (const id of installations) {
        lists.push(
          await paginate(`/user/installations/${id}/repositories`, normalizeRepositories, signal),
        );
      }
      return mergeRepositories(lists);
    },

    listBranches(repository, signal) {
      return paginate(`${repoPath(repository)}/branches`, normalizeBranches, signal);
    },

    async resolveSnapshot(repository, ref, signal) {
      const base = `${GITHUB_API_ORIGIN}${repoPath(repository)}`;
      const refResult = await getJson(`${base}/git/ref/heads/${encodePath(ref)}`, signal);
      const commitSha = normalizeRefCommitSha(refResult.value);
      if (!commitSha) throw invalidResponse();
      const commitResult = await getJson(`${base}/git/commits/${commitSha}`, signal);
      const treeSha = normalizeCommitTreeSha(commitResult.value);
      if (!treeSha) throw invalidResponse();
      return { repository, ref, commitSha, treeSha };
    },

    async getTree(snapshot, treeSha, dir, signal) {
      const url = `${GITHUB_API_ORIGIN}${repoPath(snapshot.repository)}/git/trees/${treeSha}`;
      const tree = normalizeTree((await getJson(url, signal)).value, dir);
      if (!tree) throw invalidResponse();
      return tree;
    },

    async getTreeRecursive(snapshot, treeSha, dir, signal) {
      const url = new URL(
        `${GITHUB_API_ORIGIN}${repoPath(snapshot.repository)}/git/trees/${treeSha}`,
      );
      url.searchParams.set('recursive', '1');
      const tree = normalizeRecursiveTree(
        (await getJson(url.toString(), signal, timeouts.recursiveTreeMs)).value,
        dir,
      );
      if (!tree) throw invalidResponse();
      return tree;
    },

    getBlob(snapshot, blobSha, signal) {
      const url = `${GITHUB_API_ORIGIN}${repoPath(snapshot.repository)}/git/blobs/${blobSha}`;
      // 合計ではなく、受信が止まっている時間で切る（大きさで正常な所要時間が変わるため）。
      return limited(signal, timeouts.blobStallMs, true, async (deadline) => {
        const response = await request(url, RAW_ACCEPT, deadline.signal);
        try {
          return await readBlobBody(response, deadline);
        } catch (error) {
          if (deadline.signal.aborted || error instanceof GitHubRequestError) throw error;
          throw new GitHubRequestError(classifyFetchFailure(isOnline()));
        }
      });
    },
  };
}
