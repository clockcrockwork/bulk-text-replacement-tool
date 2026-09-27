import { describe, expect, it } from 'vitest';
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
