import { createHash } from 'node:crypto';
import type { Page, Request, Route } from '@playwright/test';

/**
 * E2E 用の GitHub。api.github.com・認可画面・トークン交換（/api/github/token）を
 * 決まった応答で置き換え、送られてきたリクエストを記録する。
 *
 * 本物の GitHub には一切つながない。blob の SHA は Git と同じ規則で計算し、
 * tree とコミットの SHA は中身から決まる値にしている（同じ内容なら同じ SHA）。
 */

export const E2E_CLIENT_ID = 'Iv23-e2e-client';
export const E2E_APP_SLUG = 'bulk-replace-e2e';
export const E2E_TOKEN = 'ghu_e2e_access_token_5b1f';
/** Function が捨てるべき refresh token。ブラウザに届いてはいけない。 */
export const E2E_REFRESH_TOKEN = 'ghr_e2e_refresh_token_9c3d';
export const E2E_CODE = 'e2e-auth-code';

export interface MockFile {
  path: string;
  content: string | Buffer;
  /** 既定は通常ファイル（100644）。120000 はシンボリックリンク。 */
  mode?: '100644' | '100755' | '120000';
}

interface MockSubmodule {
  path: string;
  submodule: true;
}

export type MockEntry = MockFile | MockSubmodule;

export interface MockRepository {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private?: boolean;
  /** ブランチ名 → その先頭のファイル一覧。 */
  branches: Record<string, MockEntry[]>;
}

interface TreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function gitBlobSha(content: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`blob ${content.byteLength}\0`), content]));
}

/** 指定の URL へ履歴を残さずに移る HTML。URL は JSON 文字列として埋め込み、`<` は逃がす。 */
function redirectPage(location: string): string {
  const target = JSON.stringify(location).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Redirecting</title><script>location.replace(${target});</script>`;
}

/**
 * GitHub の公式ドキュメントにある CORS 応答と同じ値。モックだけ緩いと、本番の CORS で
 * 止まる／読めないヘッダに頼った実装がここで通ってしまう（実ブラウザでの確認は
 * `githubCors.spec.ts`）。
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, X-Requested-With',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
  'access-control-expose-headers':
    'ETag, Link, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval',
};

export class GitHubMock {
  readonly requests: RecordedRequest[] = [];
  /** 認可画面に渡されたクエリ。 */
  readonly authorizeCalls: URLSearchParams[] = [];
  /** トークン交換に送られた本文。 */
  readonly tokenCalls: string[] = [];
  /** トークン交換に付いていた Origin（Function はこれを許可リストと照合する）。 */
  readonly tokenOrigins: (string | null)[] = [];

  installations: { id: number; repositoryIds: number[] }[];
  /** 次の認可で GitHub がどう応えるか。 */
  authorize: 'approve' | 'deny' | 'wrongState' | 'stay' = 'approve';
  /** true の間、API は 401 を返す（失効・取り消し）。 */
  tokenRevoked = false;
  /** 残りの回数だけ、API が primary rate limit（残数0）を返す。 */
  rateLimitedResponses = 0;
  /** 残りの回数だけ、API が secondary rate limit（本文で分かる）を返す。 */
  secondaryRateLimitedResponses = 0;
  /** パスに含まれると失敗させる（blob の取得失敗など）。 */
  failPaths: string[] = [];
  /** 200 以外なら、トークン交換がその状態コードで失敗する（429 は Vercel Firewall の制限）。 */
  tokenStatus = 200;

  private readonly repositories = new Map<number, MockRepository>();
  private readonly objects = new Map<string, { tree: TreeItem[] } | { blob: Buffer }>();
  /** `${repoId}:${branch}` → コミット SHA。 */
  private readonly heads = new Map<string, string>();
  private readonly commits = new Map<string, string>();
  private commitCounter = 0;

  constructor(
    repositories: MockRepository[],
    installations?: { id: number; repositoryIds: number[] }[],
  ) {
    for (const repository of repositories) {
      this.repositories.set(repository.id, repository);
      for (const [branch, entries] of Object.entries(repository.branches)) {
        this.setBranch(repository.id, branch, entries);
      }
    }
    this.installations = installations ?? [
      { id: 1, repositoryIds: repositories.map((repository) => repository.id) },
    ];
  }

  /** ブランチの先頭を新しいコミットへ進める。戻り値は新しいコミット SHA。 */
  setBranch(repositoryId: number, branch: string, entries: MockEntry[]): string {
    const treeSha = this.buildTree(entries, '');
    this.commitCounter += 1;
    const commitSha = sha1(`commit ${treeSha} ${this.commitCounter}`);
    this.commits.set(commitSha, treeSha);
    this.heads.set(`${repositoryId}:${branch}`, commitSha);
    return commitSha;
  }

  headOf(repositoryId: number, branch: string): string {
    const head = this.heads.get(`${repositoryId}:${branch}`);
    if (!head) throw new Error(`no branch ${branch}`);
    return head;
  }

  treeOf(commitSha: string): string {
    const tree = this.commits.get(commitSha);
    if (!tree) throw new Error(`no commit ${commitSha}`);
    return tree;
  }

  /** そのパスの blob SHA（最新のブランチ内容から探すのではなく、固定値の計算）。 */
  static blobSha(content: string | Buffer): string {
    return gitBlobSha(Buffer.isBuffer(content) ? content : Buffer.from(content));
  }

  /** API へのリクエストのうち、パスが一致するもの。 */
  apiCalls(pathPattern: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        request.url.startsWith('https://api.github.com/') &&
        pathPattern.test(new URL(request.url).pathname),
    );
  }

  private buildTree(entries: MockEntry[], prefix: string): string {
    const direct = new Map<string, TreeItem>();
    const children = new Map<string, MockEntry[]>();
    for (const entry of entries) {
      const rest = entry.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const dir = rest.slice(0, slash);
        children.set(dir, [...(children.get(dir) ?? []), entry]);
        continue;
      }
      if ('submodule' in entry) {
        direct.set(rest, { path: rest, mode: '160000', type: 'commit', sha: sha1(entry.path) });
        continue;
      }
      const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
      const sha = gitBlobSha(content);
      this.objects.set(sha, { blob: content });
      direct.set(rest, {
        path: rest,
        mode: entry.mode ?? '100644',
        type: 'blob',
        sha,
        size: content.byteLength,
      });
    }
    for (const [dir, list] of children) {
      direct.set(dir, {
        path: dir,
        mode: '040000',
        type: 'tree',
        sha: this.buildTree(list, `${prefix}${dir}/`),
      });
    }
    const tree = [...direct.values()];
    const sha = sha1(JSON.stringify(tree));
    this.objects.set(sha, { tree });
    return sha;
  }

  /** ページに GitHub の代わりを差し込む。`openApp` より前に呼ぶ。 */
  async install(page: Page): Promise<void> {
    page.on('request', (request) => this.record(request));

    await page.route('https://github.com/login/oauth/authorize**', (route) => {
      const url = new URL(route.request().url());
      this.authorizeCalls.push(url.searchParams);
      if (this.authorize === 'stay') {
        // 利用者が GitHub の画面で何もせずに留まっている。
        return route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<!doctype html><title>Authorize</title><p>GitHub</p>',
        });
      }
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      const state = url.searchParams.get('state') ?? '';
      if (this.authorize === 'deny') {
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('state', state);
      } else {
        redirect.searchParams.set('code', E2E_CODE);
        redirect.searchParams.set('state', this.authorize === 'wrongState' ? 'forged' : state);
      }
      // 本物の GitHub は 302 で戻すが、WebKit の route.fulfill はリダイレクトの状態コードを
      // 受け付けない（`Cannot fulfill with redirect status`）。どのブラウザでも同じに動くよう、
      // 200 の HTML から location.replace で戻す。replace なので、302 と同じく認可画面は
      // 履歴に残らない。
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        body: redirectPage(redirect.toString()),
      });
    });

    // 本物では Vercel Function が GitHub と交換する。ここではその応答（refresh token は
    // Function が捨てた後の形）を返す。送られてきた本文は記録して検証に使う。
    await page.route('**/api/github/token', async (route) => {
      const body = route.request().postData() ?? '';
      this.tokenCalls.push(body);
      this.tokenOrigins.push(await route.request().headerValue('origin'));
      if (this.tokenStatus !== 200) {
        return route.fulfill({
          status: this.tokenStatus,
          headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
          body: 'Too Many Requests',
        });
      }
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ access_token: E2E_TOKEN, token_type: 'bearer', expires_in: 28800 }),
      });
    });

    await page.route('https://api.github.com/**', (route) => this.handleApi(route));
  }

  private record(request: Request): void {
    this.requests.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      body: request.postData(),
    });
  }

  private json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
    return route.fulfill({
      status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  private handleApi(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.headers().authorization !== `Bearer ${E2E_TOKEN}` || this.tokenRevoked) {
      return this.json(route, 401, { message: 'Bad credentials' });
    }
    if (this.rateLimitedResponses > 0) {
      this.rateLimitedResponses -= 1;
      return this.json(
        route,
        403,
        { message: 'API rate limit exceeded' },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        },
      );
    }
    if (this.secondaryRateLimitedResponses > 0) {
      this.secondaryRateLimitedResponses -= 1;
      // retry-after は CORS で公開されていないので、ブラウザからは読めない。
      return this.json(
        route,
        403,
        {
          message:
            'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        },
        { 'x-ratelimit-remaining': '4990', 'retry-after': '60' },
      );
    }
    if (this.failPaths.some((fragment) => path.includes(fragment))) {
      return this.json(route, 502, { message: 'Server Error' });
    }

    if (path === '/user/installations') {
      return this.json(route, 200, {
        total_count: this.installations.length,
        installations: this.installations.map(({ id }) => ({ id, account: { login: 'octo' } })),
      });
    }

    const installationRepos = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (installationRepos) {
      const installation = this.installations.find(({ id }) => id === Number(installationRepos[1]));
      const repositories = (installation?.repositoryIds ?? []).flatMap((id) => {
        const repository = this.repositories.get(id);
        return repository
          ? [
              {
                id: repository.id,
                name: repository.name,
                full_name: `${repository.owner}/${repository.name}`,
                owner: { login: repository.owner },
                default_branch: repository.defaultBranch,
                private: repository.private ?? false,
              },
            ]
          : [];
      });
      return this.json(route, 200, { total_count: repositories.length, repositories });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    const repository = repoMatch
      ? [...this.repositories.values()].find(
          (candidate) =>
            candidate.owner === decodeURIComponent(repoMatch[1] ?? '') &&
            candidate.name === decodeURIComponent(repoMatch[2] ?? ''),
        )
      : undefined;
    const rest = repoMatch?.[3] ?? '';
    if (!repository) return this.json(route, 404, { message: 'Not Found' });

    if (rest === 'branches') {
      const names = Object.keys(repository.branches);
      return this.json(
        route,
        200,
        names.map((name) => ({ name, commit: { sha: this.headOf(repository.id, name) } })),
      );
    }

    const ref = /^git\/ref\/heads\/(.+)$/.exec(rest);
    if (ref) {
      const branch = ref[1]
        ?.split('/')
        .map((part) => decodeURIComponent(part))
        .join('/');
      const head = branch ? this.heads.get(`${repository.id}:${branch}`) : undefined;
      if (!head) return this.json(route, 404, { message: 'Not Found' });
      return this.json(route, 200, {
        ref: `refs/heads/${branch}`,
        object: { sha: head, type: 'commit' },
      });
    }

    const commit = /^git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (commit?.[1]) {
      const tree = this.commits.get(commit[1]);
      if (!tree) return this.json(route, 404, { message: 'Not Found' });
      return this.json(route, 200, { sha: commit[1], tree: { sha: tree } });
    }

    const tree = /^git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (tree?.[1]) {
      const object = this.objects.get(tree[1]);
      if (!object || !('tree' in object)) return this.json(route, 404, { message: 'Not Found' });
      return this.json(route, 200, { sha: tree[1], tree: object.tree, truncated: false });
    }

    const blob = /^git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (blob?.[1]) {
      const object = this.objects.get(blob[1]);
      if (!object || !('blob' in object)) return this.json(route, 404, { message: 'Not Found' });
      if (request.headers().accept !== 'application/vnd.github.raw+json') {
        return this.json(route, 415, { message: 'expected raw media type' });
      }
      return route.fulfill({
        status: 200,
        headers: { ...CORS_HEADERS, 'content-type': 'application/vnd.github.raw' },
        body: object.blob,
      });
    }

    return this.json(route, 404, { message: 'Not Found' });
  }
}

/** よく使うリポジトリ。main と draft の2ブランチを持つ。 */
export function novelRepository(overrides: Partial<MockRepository> = {}): MockRepository {
  return {
    id: 4242,
    owner: 'octo',
    name: 'novel',
    defaultBranch: 'main',
    private: true,
    branches: {
      main: [
        { path: 'README.md', content: '# novel\n' },
        { path: 'chapters/ch1.md', content: 'アリスは川辺に座っていた。\n' },
        { path: 'chapters/ch2.txt', content: 'ビルがやってきた。\n' },
        { path: 'chapters/cover.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { path: 'chapters/link.md', content: 'ch1.md', mode: '120000' },
        { path: 'drafts/ch1.md', content: '別の場所の ch1。\n' },
        { path: 'vendor', submodule: true },
      ],
      draft: [{ path: 'draft-only.md', content: '下書きブランチだけにある原稿。\n' }],
    },
    ...overrides,
  };
}
