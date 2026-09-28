import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BLOB_BYTES } from '../lib/githubApi';
import { createGitHubClient, GitHubRequestError, MAX_PAGES } from './client';

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
      resolve(new Response(stream, { status: plan.status ?? 200 }));
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

  it('エラー応答の本文が止まっても待ち続けず、状態コードの分類はそのまま（401 を timeout にしない）', async () => {
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
    );
    const settled = expect(result).rejects.toMatchObject({
      detail: { kind: 'timeout', timeout: { stall: true } },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it('blob の受信量が上限を超えたら、残りを読まずに tooLarge で止める', async () => {
    // 同じバイト列を何度も流す（メモリを上限の分だけ確保しない）。
    const half = new Uint8Array(Math.ceil(MAX_BLOB_BYTES / 2) + 1);
    const pulled = { count: 0 };
    const fetchImpl = timedFetch({
      kind: 'body',
      chunks: [
        [0, half],
        [10, half],
        [10_000, half],
      ],
      end: true,
      pulled,
    });
    const result = client(fetchImpl).getBlob(
      SNAPSHOT,
      'b'.repeat(40),
      new AbortController().signal,
    );
    const settled = expect(result).rejects.toMatchObject({ detail: { kind: 'tooLarge' } });
    await vi.advanceTimersByTimeAsync(20);
    await settled;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pulled.count).toBe(2);
  });

  it('blob の読み取りの途中で呼び出し側が中断したら、中断として投げ直す', async () => {
    const caller = new AbortController();
    const fetchImpl = timedFetch({ kind: 'body', chunks: [[0, bytes('あ')]], end: false });
    const result = client(fetchImpl).getBlob(SNAPSHOT, 'b'.repeat(40), caller.signal);
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
