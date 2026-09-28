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
  normalizeRecursiveTree,
  normalizeRefCommitSha,
  normalizeRepositories,
  normalizeTree,
  PER_PAGE,
  parseContentLength,
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

/**
 * blob が上限を超えていた。超えた時点で読むのをやめて投げるので、本文は手元に残らない。
 *
 * `scope` は超えた上限の種類。`file` は1件の上限（`maxBytes`）、`total` は操作全体で共有する
 * 予算（`BlobReadLimit.take`）。どのファイル・どの操作かは呼び出し側が知っているので、
 * 文言も呼び出し側で作る。
 */
export class GitHubBlobTooLargeError extends Error {
  constructor(readonly scope: 'file' | 'total') {
    super(`GitHub blob: over the ${scope} limit`);
    this.name = 'GitHubBlobTooLargeError';
  }
}

/** blob を読むときの上限。 */
export interface BlobReadLimit {
  /** 1件の上限（バイト）。 */
  maxBytes: number;
  /**
   * 読んだ分を、操作全体で共有する予算から差し引く。足りなければ false を返し、読むのをやめる。
   *
   * 一括取り込みは複数の blob を並行して読むので、読み終えてから合計を足すと、上限を
   * 超えたと分かるまでに並行する取得がそれぞれ上限近くまで読めてしまう。届いた分ずつ
   * 差し引けば、操作全体で読む量は予算と、各取得がその時点で受け取っていた1回分までに収まる。
   */
  take?: (bytes: number) => boolean;
}

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
  /**
   * blob の本文。上限（`limit`）を超えたら `GitHubBlobTooLargeError`。
   *
   * tree が大きさを返さない項目（`size === null`）があるので、一覧で断れなかった分も
   * ここで止める。全部受け取ってから断ると、上限の何倍もの本文をメモリに載せてしまう。
   */
  getBlob(
    snapshot: GitHubSnapshot,
    blobSha: string,
    signal: AbortSignal,
    limit: BlobReadLimit,
  ): Promise<ArrayBuffer>;
}

/**
 * 本文を読みながら数え、上限を超えた時点で読むのをやめる。
 *
 * `Content-Length` が1件の上限を超えていれば読まずに断る。上限内でも信用はしない
 * （圧縮されていれば展開前の長さで、無いこともある）。中断されたら、続きを待たずに
 * 読むのをやめる（並行する取得が失敗したときに、残りを読み続けない）。
 */
async function readBodyWithLimit(
  response: Response,
  limit: BlobReadLimit,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const { maxBytes, take = () => true } = limit;
  const declared = parseContentLength(response.headers.get('content-length'));
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new GitHubBlobTooLargeError('file');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // 本文をストリームで読めない実装。読み切ってから確かめるしかない。
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new GitHubBlobTooLargeError('file');
    if (!take(buffer.byteLength)) throw new GitHubBlobTooLargeError('total');
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    let exceeded: GitHubBlobTooLargeError['scope'] | null = null;
    if (total > maxBytes) exceeded = 'file';
    else if (!take(value.byteLength)) exceeded = 'total';
    if (exceeded || signal.aborted) {
      // 残りは受け取らない（接続ごと打ち切る）。
      await reader.cancel().catch(() => {});
      if (exceeded) throw new GitHubBlobTooLargeError(exceeded);
      throw new DOMException('Aborted', 'AbortError');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
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
      const tree = normalizeRecursiveTree((await getJson(url.toString(), signal)).value, dir);
      if (!tree) throw invalidResponse();
      return tree;
    },

    async getBlob(snapshot, blobSha, signal, limit) {
      const url = `${GITHUB_API_ORIGIN}${repoPath(snapshot.repository)}/git/blobs/${blobSha}`;
      const response = await request(url, RAW_ACCEPT, signal);
      try {
        return await readBodyWithLimit(response, limit, signal);
      } catch (error) {
        if (signal.aborted || error instanceof GitHubBlobTooLargeError) throw error;
        throw new GitHubRequestError({ kind: 'network', status: null, resetAt: null });
      }
    },
  };
}
