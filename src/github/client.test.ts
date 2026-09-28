import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * 本物の fetch と同じく、signal の中断を応答ヘッダ待ちと本文の読み取りの両方へ伝える fetch。
 * `chunks` は `[経過ミリ秒, バイト列]` を順に流し、`end` なら閉じる（無ければ止まったまま）。
 */
function timedFetch(
  plan:
    | { kind: 'noHeaders' }
    | {
        kind: 'body';
        status?: number;
        headers?: Record<string, string>;
        chunks: Array<[number, Uint8Array]>;
        end: boolean;
        pulled?: { count: number };
      },
) {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error('signal が渡されていない');
      if (plan.kind === 'noHeaders') {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        return;
      }
      // 読み手が取り消したあと（上限超過など）は、残りを流さない。
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          let at = 0;
          for (const [delay, bytes] of plan.chunks) {
            at += delay;
            setTimeout(() => {
              if (signal.aborted || cancelled) return;
              if (plan.pulled) plan.pulled.count += 1;
              controller.enqueue(bytes);
            }, at);
          }
          if (plan.end) setTimeout(() => signal.aborted || cancelled || controller.close(), at);
        },
      });
      resolve(new Response(stream, { status: plan.status ?? 200, headers: plan.headers ?? {} }));
    })) as typeof fetch;
}

const SNAPSHOT = {
  repository: REPO,
  ref: 'main',
  commitSha: 'c'.repeat(40),
  treeSha: 't'.repeat(40),
};
const TIMEOUTS = { metadataMs: 1_000, recursiveTreeMs: 2_000, blobStallMs: 1_000 };
const bytes = (text: string) => new TextEncoder().encode(text);
/** 上限では止めない（ここでは待ち時間だけを見る）。 */
const NO_LIMIT = { maxBytes: 1_000_000 };

describe('待ち時間（issue #20）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function client(fetchImpl: typeof fetch, isOnline?: () => boolean | undefined) {
    return createGitHubClient('t', fetchImpl, {
      timeouts: TIMEOUTS,
      visibility: null,
      ...(isOnline ? { isOnline } : {}),
    });
  }

  it('応答ヘッダが返らなければ、上限で timeout にする（呼び出し側は中断しない）', async () => {
    const caller = new AbortController();
    const result = client(timedFetch({ kind: 'noHeaders' })).listBranches(REPO, caller.signal);
    const settled = expect(result).rejects.toMatchObject({
      detail: { kind: 'timeout', timeout: { ms: 1_000, stall: false } },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(caller.signal.aborted).toBe(false);
  });

  it('呼び出し側の中断は timeout ではなく、中断としてそのまま投げ直す', async () => {
    const caller = new AbortController();
    const result = client(timedFetch({ kind: 'noHeaders' })).listBranches(REPO, caller.signal);
    caller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await expect(result).rejects.not.toBeInstanceOf(GitHubRequestError);
  });

  it('ヘッダのあと JSON の本文が止まっても、同じ上限で切れる', async () => {
    const fetchImpl = timedFetch({ kind: 'body', chunks: [[0, bytes('[{"name":')]], end: false });
    const result = client(fetchImpl).listBranches(REPO, new AbortController().signal);
    const settled = expect(result).rejects.toMatchObject({ detail: { kind: 'timeout' } });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it('再帰の tree は、一覧より長く待つ', async () => {
    const result = client(timedFetch({ kind: 'noHeaders' })).getTreeRecursive(
      SNAPSHOT,
      't'.repeat(40),
      '',
      new AbortController().signal,
    );
    let settledAt = 0;
    result.catch(() => {
      settledAt = Date.now();
    });
    const started = Date.now();
    const settled = expect(result).rejects.toMatchObject({
      detail: { kind: 'timeout', timeout: { ms: 2_000 } },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settledAt).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    await settled;
    expect(settledAt - started).toBe(2_000);
  });

  it('状態コードだけで決まる 401 は、本文が止まっても待ち続けず unauthorized にする（接続を切る）', async () => {
    const fetchImpl = timedFetch({
      kind: 'body',
      status: 401,
      chunks: [[0, bytes('{"message":')]],
      end: false,
    });
    const result = client(fetchImpl).listBranches(REPO, new AbortController().signal);
    const settled = expect(result).rejects.toMatchObject({ detail: { kind: 'unauthorized' } });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it('403 の本文が止まったら、rate limit や SAML を見分けられないので timeout にする', async () => {
    const fetchImpl = timedFetch({
      kind: 'body',
      status: 403,
      chunks: [[0, bytes('{"message":')]],
      end: false,
    });
    const result = client(fetchImpl).listBranches(REPO, new AbortController().signal);
    const settled = expect(result).rejects.toMatchObject({ detail: { kind: 'timeout' } });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it('x-ratelimit-remaining: 0 の 403 は、本文が止まってもヘッダで rate limit と分かる', async () => {
    const fetchImpl = timedFetch({
      kind: 'body',
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' },
      chunks: [[0, bytes('{"message":')]],
      end: false,
    });
    const result = client(fetchImpl).listBranches(REPO, new AbortController().signal);
    const settled = expect(result).rejects.toMatchObject({ detail: { kind: 'rateLimited' } });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it('403 の本文が通信の失敗で読めなければ、一般の 403 と取り違えず network にする', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('network'));
      },
    });
    const fetchImpl = (async () => new Response(stream, { status: 403 })) as typeof fetch;
    await expect(
      client(fetchImpl, () => true).listBranches(REPO, new AbortController().signal),
    ).rejects.toMatchObject({ detail: { kind: 'network' } });
  });

  it('blob は少しずつでも受信が進んでいれば、合計が上限を超えても切らない', async () => {
    const fetchImpl = timedFetch({
      kind: 'body',
      chunks: [
        [900, bytes('あ')],
        [900, bytes('い')],
        [900, bytes('う')],
        [900, bytes('え')],
      ],
      end: true,
    });
    const result = client(fetchImpl).getBlob(
      SNAPSHOT,
      'b'.repeat(40),
      new AbortController().signal,
      NO_LIMIT,
    );
    await vi.advanceTimersByTimeAsync(3_600);
    const buffer = await result;
    expect(new TextDecoder().decode(buffer)).toBe('あいうえ');
  });

  it('blob の受信が止まったら、最後に受け取ってから上限で timeout（stall）にする', async () => {
    const fetchImpl = timedFetch({ kind: 'body', chunks: [[500, bytes('あ')]], end: false });
    const result = client(fetchImpl).getBlob(
      SNAPSHOT,
      'b'.repeat(40),
      new AbortController().signal,
      NO_LIMIT,
    );
    const settled = expect(result).rejects.toMatchObject({
      detail: { kind: 'timeout', timeout: { ms: 1_000, stall: true } },
    });
    // 受け取った時点（500ms）から数え直すので、1000ms では切れない。
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(500);
    await settled;
  });

  it('blob の応答ヘッダが返らないのも、受信の停止として切る', async () => {
    const result = client(timedFetch({ kind: 'noHeaders' })).getBlob(
      SNAPSHOT,
      'b'.repeat(40),
      new AbortController().signal,
      NO_LIMIT,
    );
    const settled = expect(result).rejects.toMatchObject({
      detail: { kind: 'timeout', timeout: { stall: true } },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it('blob の読み取りの途中で呼び出し側が中断したら、中断として投げ直す', async () => {
    const caller = new AbortController();
    const fetchImpl = timedFetch({ kind: 'body', chunks: [[0, bytes('あ')]], end: false });
    const result = client(fetchImpl).getBlob(SNAPSHOT, 'b'.repeat(40), caller.signal, NO_LIMIT);
    await vi.advanceTimersByTimeAsync(100);
    caller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('本文の無い応答（body が null）は、そのまま読んで返す', async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const buffer = await client(fetchImpl).getBlob(
      SNAPSHOT,
      'b'.repeat(40),
      new AbortController().signal,
      NO_LIMIT,
    );
    expect(buffer.byteLength).toBe(0);
  });

  it('fetch が失敗したとき、navigator.onLine が false ならオフラインと分類する', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(
      client(failing, () => false).listBranches(REPO, new AbortController().signal),
    ).rejects.toMatchObject({ detail: { kind: 'offline' } });
    await expect(
      client(failing, () => true).listBranches(REPO, new AbortController().signal),
    ).rejects.toMatchObject({ detail: { kind: 'network' } });
  });
});
