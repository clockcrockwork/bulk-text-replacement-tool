import { describe, expect, it } from 'vitest';
import {
  createGitHubClient,
  GitHubBlobTooLargeError,
  GitHubRequestError,
  MAX_PAGES,
} from './client';

/**
 * 通信層のうち、ページ送りと送るヘッダだけをここで見る。画面の流れはモックした GitHub
 * （e2e/）、CORS は実ブラウザ（e2e/githubCors.spec.ts）で確かめている。
 */

const REPO = { id: 1, owner: 'octo', name: 'novel', defaultBranch: 'main', private: false };

/** ブランチ一覧を `pages` ページ返す fetch。`endsWithNext` なら最後のページにも次がある。 */
function paginatedFetch(pages: number, endsWithNext: boolean) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: { ...(init?.headers as Record<string, string>) } });
    const page = Number(url.searchParams.get('page') ?? '1');
    const hasNext = page < pages || endsWithNext;
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    return new Response(JSON.stringify([{ name: `b${page}` }]), {
      status: 200,
      headers: hasNext ? { link: `<${next.toString()}>; rel="next"` } : {},
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('ページ送り', () => {
  it('次のページが無くなるまで辿る', async () => {
    const { fetchImpl, calls } = paginatedFetch(3, false);
    const branches = await createGitHubClient('t', fetchImpl).listBranches(
      REPO,
      new AbortController().signal,
    );
    expect(branches).toEqual(['b1', 'b2', 'b3']);
    expect(calls).toHaveLength(3);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('per_page')).toBe('100');
  });

  it('上限ちょうどで終わる一覧は成功', async () => {
    const { fetchImpl } = paginatedFetch(MAX_PAGES, false);
    const branches = await createGitHubClient('t', fetchImpl).listBranches(
      REPO,
      new AbortController().signal,
    );
    expect(branches).toHaveLength(MAX_PAGES);
  });

  it('上限に達してもまだ続きがあれば、途中までの一覧を返さずに失敗する', async () => {
    const { fetchImpl, calls } = paginatedFetch(MAX_PAGES + 5, false);
    const result = createGitHubClient('t', fetchImpl).listBranches(
      REPO,
      new AbortController().signal,
    );
    await expect(result).rejects.toBeInstanceOf(GitHubRequestError);
    await expect(result).rejects.toMatchObject({ detail: { kind: 'listTooLong' } });
    // 上限より先は取りに行かない（rate limit を食い潰さない）。
    expect(calls).toHaveLength(MAX_PAGES);
  });

  it('リポジトリ一覧でも同じく、途中までの一覧を返さない', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page') ?? '1');
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      return new Response(JSON.stringify({ installations: [{ id: page }] }), {
        status: 200,
        headers: { link: `<${next.toString()}>; rel="next"` },
      });
    }) as typeof fetch;
    await expect(
      createGitHubClient('t', fetchImpl).listRepositories(new AbortController().signal),
    ).rejects.toMatchObject({ detail: { kind: 'listTooLong' } });
  });
});

describe('送るヘッダ', () => {
  it('Accept と Authorization だけ（X-GitHub-Api-Version は CORS で止まるので付けない）', async () => {
    const { fetchImpl, calls } = paginatedFetch(1, false);
    await createGitHubClient('ghu_x', fetchImpl).listBranches(REPO, new AbortController().signal);
    expect(calls[0]?.headers).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ghu_x',
    });
  });
});

describe('blob の上限', () => {
  const SNAPSHOT = {
    repository: REPO,
    ref: 'main',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
  };
  const SHA = 'c'.repeat(40);

  /** `chunks` 個の `chunkSize` バイトを流す本文。読まれた回数と取り消しを記録する。 */
  function streamed(chunkSize: number, chunks: number) {
    const log = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (log.pulled >= chunks) {
          controller.close();
          return;
        }
        log.pulled += 1;
        controller.enqueue(new Uint8Array(chunkSize).fill(log.pulled));
      },
      cancel() {
        log.cancelled = true;
      },
    });
    return { stream, log };
  }

  function blobFetch(body: BodyInit, headers: Record<string, string> = {}) {
    return (async () => new Response(body, { status: 200, headers })) as typeof fetch;
  }

  const getBlob = (
    fetchImpl: typeof fetch,
    maxBytes: number,
    take?: (bytes: number) => boolean,
    signal = new AbortController().signal,
  ) =>
    createGitHubClient('t', fetchImpl).getBlob(SNAPSHOT, SHA, signal, {
      maxBytes,
      ...(take ? { take } : {}),
    });

  it('上限ちょうどまでは、分けて届いた本文をつないで返す', async () => {
    const { stream } = streamed(4, 3);
    const buffer = await getBlob(blobFetch(stream), 12);
    expect([...new Uint8Array(buffer)]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it('大きさが分からなくても、読みながら数えて上限を超えた時点でやめる', async () => {
    const { stream, log } = streamed(4, 1000);
    await expect(getBlob(blobFetch(stream), 10)).rejects.toBeInstanceOf(GitHubBlobTooLargeError);
    // 上限を超えた3つ目で取り消し、残りは受け取らない。
    expect(log.cancelled).toBe(true);
    expect(log.pulled).toBeLessThan(10);
  });

  it('Content-Length が上限を超えていれば、本文を読まずに断る', async () => {
    const { stream, log } = streamed(4, 1000);
    await expect(getBlob(blobFetch(stream, { 'content-length': '11' }), 10)).rejects.toBeInstanceOf(
      GitHubBlobTooLargeError,
    );
    expect(log.cancelled).toBe(true);
    expect(log.pulled).toBeLessThanOrEqual(1);
  });

  it('Content-Length が上限内でも信用せず、実際の長さで断る（圧縮されていれば展開前の長さ）', async () => {
    const { stream } = streamed(4, 5);
    await expect(getBlob(blobFetch(stream, { 'content-length': '8' }), 10)).rejects.toBeInstanceOf(
      GitHubBlobTooLargeError,
    );
  });

  it('1件の上限を超えたときは scope が file', async () => {
    const { stream } = streamed(4, 1000);
    await expect(getBlob(blobFetch(stream), 10)).rejects.toMatchObject({ scope: 'file' });
  });

  it('届いた分ずつ共有の予算から差し引き、足りなくなった時点で読むのをやめる', async () => {
    const { stream, log } = streamed(4, 1000);
    const taken: number[] = [];
    let budget = 10;
    const take = (bytes: number): boolean => {
      taken.push(bytes);
      budget -= bytes;
      return budget >= 0;
    };
    await expect(getBlob(blobFetch(stream), 1_000_000, take)).rejects.toMatchObject({
      scope: 'total',
    });
    // 3つ目（合計 12 バイト）で予算を超え、それ以上は差し引かずに取り消す。
    expect(taken).toEqual([4, 4, 4]);
    expect(log.cancelled).toBe(true);
    expect(log.pulled).toBeLessThan(10);
  });

  it('中断されたら、続きを読まずに取り消す', async () => {
    const { stream, log } = streamed(4, 1000);
    const controller = new AbortController();
    const take = (): boolean => {
      controller.abort();
      return true;
    };
    await expect(
      getBlob(blobFetch(stream), 1_000_000, take, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(log.cancelled).toBe(true);
    expect(log.pulled).toBeLessThan(10);
  });

  it('本文の途中で切れたら、通信の失敗として分類する', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('network'));
      },
    });
    await expect(getBlob(blobFetch(stream), 10)).rejects.toMatchObject({
      detail: { kind: 'network' },
    });
  });
});
