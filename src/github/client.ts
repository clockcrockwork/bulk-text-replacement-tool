import {
  classifyErrorResponse,
  encodePath,
  GITHUB_API_ORIGIN,
  GITHUB_FETCH_INIT,
  type GitHubError,
  githubRequestHeaders,
  mergeRepositories,
  type NormalizedTree,
  normalizeBranches,
  normalizeCommitTreeSha,
  normalizeInstallations,
  normalizeRefCommitSha,
  normalizeRepositories,
  normalizeTree,
  PER_PAGE,
  parseNextLink,
  readErrorMessage,
} from '../lib/githubApi';
import type { GitHubRepository, GitHubSnapshot } from '../types';

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

/** 一覧の取得で辿るページ数の上限。応答が壊れていても無限に回らないための歯止め。 */
const MAX_PAGES = 100;

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
  getBlob(snapshot: GitHubSnapshot, blobSha: string, signal: AbortSignal): Promise<ArrayBuffer>;
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
): GitHubClient {
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
      // 中断は失敗ではない。呼び出し側が無視できるよう、そのまま投げ直す。
      if (signal.aborted) throw error;
      throw new GitHubRequestError({ kind: 'network', status: null, resetAt: null });
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

  const getJson = async (
    url: string,
    signal: AbortSignal,
  ): Promise<{ value: unknown; next: string | null }> => {
    const response = await request(url, JSON_ACCEPT, signal);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw invalidResponse();
    }
    return { value, next: parseNextLink(response.headers.get('link')) };
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

    async getBlob(snapshot, blobSha, signal) {
      const url = `${GITHUB_API_ORIGIN}${repoPath(snapshot.repository)}/git/blobs/${blobSha}`;
      const response = await request(url, RAW_ACCEPT, signal);
      try {
        return await response.arrayBuffer();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new GitHubRequestError({ kind: 'network', status: null, resetAt: null });
      }
    },
  };
}
