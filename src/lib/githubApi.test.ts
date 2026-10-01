import { describe, expect, it } from 'vitest';
import type { GitHubSnapshot } from '../types';
import {
  BLOB_STALL_TIMEOUT_MS,
  blobTooLargeMessage,
  buildCandidate,
  canFallBackFromRecursiveTree,
  classifyErrorResponse,
  classifyFetchFailure,
  classifyTreeEntry,
  describeEntryStatus,
  describeGitHubError,
  encodePath,
  errorClassificationNeedsBody,
  formatBytes,
  GITHUB_CORS_ALLOWED_REQUEST_HEADERS,
  GITHUB_CORS_EXPOSED_RESPONSE_HEADERS,
  type GitHubErrorKind,
  type GitHubFetchStage,
  githubRequestHeaders,
  isLfsPointer,
  joinPath,
  METADATA_TIMEOUT_MS,
  mergeRepositories,
  normalizeBranches,
  normalizeCommitTreeSha,
  normalizeInstallations,
  normalizeRecursiveTree,
  normalizeRefCommitSha,
  normalizeRepositories,
  normalizeTree,
  orderBranches,
  parseContentLength,
  parseNextLink,
  RECURSIVE_TREE_TIMEOUT_MS,
  readErrorMessage,
  recoveryFor,
  SLOW_NOTICE_MS,
  timeoutError,
} from './githubApi';
import { MAX_INPUT_BYTES } from './inputLimits';
import { BOM } from './text';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const REPOSITORY = { id: 42, owner: 'octo', name: 'novel', defaultBranch: 'main', private: true };
const SNAPSHOT: GitHubSnapshot = {
  repository: REPOSITORY,
  ref: 'main',
  commitSha: SHA_A,
  treeSha: SHA_B,
};

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('encodePath / joinPath', () => {
  it('区切りの / は残し、各部分だけ符号化する', () => {
    expect(encodePath('feature/日本語 #1')).toBe('feature/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%231');
  });

  it('ルート直下はそのまま、下位は / でつなぐ', () => {
    expect(joinPath('', 'a.md')).toBe('a.md');
    expect(joinPath('docs', 'a.md')).toBe('docs/a.md');
  });
});

describe('parseNextLink', () => {
  it('rel="next" の URL を返す', () => {
    expect(
      parseNextLink(
        '<https://api.github.com/user/installations?page=2>; rel="next", <https://api.github.com/user/installations?page=5>; rel="last"',
      ),
    ).toBe('https://api.github.com/user/installations?page=2');
  });

  it('次が無ければ null', () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
  });

  it('API 以外のオリジンへはトークンを持って行かない', () => {
    expect(parseNextLink('<https://evil.example/x?page=2>; rel="next"')).toBeNull();
    expect(parseNextLink('<not a url>; rel="next"')).toBeNull();
  });
});

describe('CORS', () => {
  const SAFELISTED = ['accept', 'accept-language', 'content-language'];

  it('api.github.com へは、GitHub が CORS で許可するヘッダしか付けない', () => {
    const headers = githubRequestHeaders('ghu_x', 'application/vnd.github+json');
    expect(headers).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ghu_x',
    });
    for (const name of Object.keys(headers).map((key) => key.toLowerCase())) {
      expect([...SAFELISTED, ...GITHUB_CORS_ALLOWED_REQUEST_HEADERS]).toContain(name);
    }
  });

  it('API の版指定ヘッダは許可リストに無いので付けない', () => {
    expect(GITHUB_CORS_ALLOWED_REQUEST_HEADERS).not.toContain('x-github-api-version');
    expect(Object.keys(githubRequestHeaders('t', 'application/vnd.github.raw+json'))).not.toContain(
      'X-GitHub-Api-Version',
    );
  });

  it('rate limit の判定に使う応答ヘッダは、ブラウザから読めるものだけ', () => {
    for (const name of ['link', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      expect(GITHUB_CORS_EXPOSED_RESPONSE_HEADERS).toContain(name);
    }
    expect(GITHUB_CORS_EXPOSED_RESPONSE_HEADERS).not.toContain('retry-after');
    expect(GITHUB_CORS_EXPOSED_RESPONSE_HEADERS).not.toContain('x-github-sso');
  });
});

describe('readErrorMessage', () => {
  it('本文の message を取り出す。読めなければ空文字', () => {
    expect(readErrorMessage('{"message":"Not Found"}')).toBe('Not Found');
    expect(readErrorMessage('{"message":1}')).toBe('');
    expect(readErrorMessage('<html>')).toBe('');
    expect(readErrorMessage('')).toBe('');
  });
});

describe('classifyErrorResponse', () => {
  const now = 1_000_000;
  const SECONDARY =
    'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
  const SAML =
    'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.';

  it('401 は接続切れ', () => {
    expect(classifyErrorResponse(401, headers({}), '', now).kind).toBe('unauthorized');
  });

  it('残数0は primary rate limit として、x-ratelimit-reset を解除時刻にする', () => {
    expect(
      classifyErrorResponse(
        403,
        headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' }),
        'API rate limit exceeded',
        now,
      ),
    ).toEqual({ kind: 'rateLimited', status: 403, resetAt: 2_000_000 });
    expect(
      classifyErrorResponse(429, headers({ 'x-ratelimit-remaining': '0' }), '', now).resetAt,
    ).toBe(now + 60_000);
  });

  it('端末の時計がずれていても、待たせるのは1分から1時間の範囲に収める', () => {
    const at = (resetSeconds: number) =>
      classifyErrorResponse(
        403,
        headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) }),
        '',
        now,
      ).resetAt;
    // 端末が遅れていて、解除が30日先に見える。
    expect(at(now / 1000 + 30 * 24 * 60 * 60)).toBe(now + 60 * 60 * 1000);
    // 端末が進んでいて、解除がもう過ぎたように見える。
    expect(at(now / 1000 - 600)).toBe(now + 60_000);
  });

  it('secondary rate limit は本文で見分け、最低1分待つよう案内する（retry-after は読めない）', () => {
    expect(
      classifyErrorResponse(403, headers({ 'x-ratelimit-remaining': '4999' }), SECONDARY, now),
    ).toEqual({ kind: 'rateLimited', status: 403, resetAt: now + 60_000 });
    expect(classifyErrorResponse(429, headers({}), '', now)).toEqual({
      kind: 'rateLimited',
      status: 429,
      resetAt: now + 60_000,
    });
  });

  it('rate limit でない 403 は権限不足、SAML の保護なら SSO', () => {
    expect(
      classifyErrorResponse(403, headers({ 'x-ratelimit-remaining': '10' }), 'Forbidden', now).kind,
    ).toBe('forbidden');
    expect(classifyErrorResponse(403, headers({}), SAML, now).kind).toBe('sso');
  });

  it('404・409・5xx・その他', () => {
    expect(classifyErrorResponse(404, headers({}), '', now).kind).toBe('notFound');
    expect(classifyErrorResponse(409, headers({}), '', now).kind).toBe('emptyRepository');
    expect(classifyErrorResponse(502, headers({}), '', now).kind).toBe('server');
    expect(classifyErrorResponse(422, headers({}), '', now).kind).toBe('invalidResponse');
  });

  it('壊れた x-ratelimit-reset は解除時刻として使わない', () => {
    expect(
      classifyErrorResponse(
        403,
        headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'x' }),
        '',
        now,
      ).resetAt,
    ).toBe(now + 60_000);
  });
});

describe('recoveryFor', () => {
  const error = (kind: GitHubErrorKind) => ({ kind, status: null, resetAt: null });
  const stages: GitHubFetchStage[] = ['repositories', 'branches', 'snapshot', 'tree', 'blob'];

  it('選んでいたブランチが無いときは、再試行ではなくブランチの一覧へ戻す', () => {
    expect(recoveryFor(error('notFound'), 'snapshot')).toBe('chooseBranch');
  });

  it('リポジトリ以下が無い（消えた・見えなくなった）ときは、リポジトリを選び直す', () => {
    expect(recoveryFor(error('notFound'), 'branches')).toBe('reselect');
    expect(recoveryFor(error('notFound'), 'tree')).toBe('reselect');
    expect(recoveryFor(error('notFound'), 'blob')).toBe('reselect');
  });

  it('リポジトリの一覧そのものが 404 なら、再試行する', () => {
    expect(recoveryFor(error('notFound'), 'repositories')).toBe('retry');
  });

  it('コミットの無いリポジトリは、やり直しても同じなので選び直す', () => {
    for (const stage of stages)
      expect(recoveryFor(error('emptyRepository'), stage)).toBe('reselect');
  });

  it('一覧が長すぎるのは、やり直しても同じなので閉じるだけ', () => {
    for (const stage of stages) expect(recoveryFor(error('listTooLong'), stage)).toBe('dismiss');
  });

  it('時間切れは、どの段階でも同じ GET をやり直せる（コミットは固定済み）', () => {
    for (const stage of stages) {
      expect(recoveryFor(timeoutError(METADATA_TIMEOUT_MS, false), stage)).toBe('retry');
      expect(recoveryFor(timeoutError(BLOB_STALL_TIMEOUT_MS, true), stage)).toBe('retry');
    }
  });

  it('一時的な失敗は、どの段階でも再試行する', () => {
    const kinds: GitHubErrorKind[] = [
      'rateLimited',
      'server',
      'network',
      'offline',
      'invalidResponse',
      'forbidden',
      'sso',
    ];
    for (const kind of kinds) {
      for (const stage of stages) expect(recoveryFor(error(kind), stage)).toBe('retry');
    }
  });
});

describe('canFallBackFromRecursiveTree', () => {
  const error = (kind: GitHubErrorKind) => ({ kind, status: null, resetAt: null });

  it('時間切れと 5xx だけ、非再帰の列挙へ移る', () => {
    expect(canFallBackFromRecursiveTree(timeoutError(RECURSIVE_TREE_TIMEOUT_MS, false))).toBe(true);
    expect(canFallBackFromRecursiveTree(error('server'))).toBe(true);
  });

  it('非再帰でも結果が変わらない失敗では移らない', () => {
    const kinds: GitHubErrorKind[] = [
      'unauthorized',
      'rateLimited',
      'sso',
      'forbidden',
      'notFound',
      'emptyRepository',
      'offline',
      'network',
      'invalidResponse',
      'listTooLong',
    ];
    for (const kind of kinds) expect(canFallBackFromRecursiveTree(error(kind))).toBe(false);
  });
});

describe('describeGitHubError', () => {
  it('rate limit は一般のエラーと見分けられる文にする', () => {
    const reset = new Date(2026, 0, 1, 9, 5).getTime();
    expect(describeGitHubError({ kind: 'rateLimited', status: 403, resetAt: reset })).toContain(
      '09:05',
    );
    expect(describeGitHubError({ kind: 'rateLimited', status: 429, resetAt: null })).toContain(
      '利用上限',
    );
    expect(describeGitHubError({ kind: 'network', status: null, resetAt: null })).not.toContain(
      '利用上限',
    );
  });

  it('すべての種類に説明がある', () => {
    const kinds: GitHubErrorKind[] = [
      'unauthorized',
      'rateLimited',
      'sso',
      'forbidden',
      'notFound',
      'emptyRepository',
      'server',
      'network',
      'offline',
      'timeout',
      'invalidResponse',
      'listTooLong',
    ];
    for (const kind of kinds) {
      expect(describeGitHubError({ kind, status: null, resetAt: null })).not.toBe('');
    }
  });

  it('時間切れは、待った秒数と、応答が無かったのか受信が止まったのかを伝える', () => {
    expect(describeGitHubError(timeoutError(30_000, false))).toContain('30 秒応答がなかった');
    expect(describeGitHubError(timeoutError(30_000, true))).toContain('受信が 30 秒止まった');
  });

  it('オフラインは、ネットワーク障害一般と区別して伝える', () => {
    expect(describeGitHubError(classifyFetchFailure(false))).toContain('オフライン');
    expect(describeGitHubError(classifyFetchFailure(true))).not.toContain('オフライン');
  });
});

describe('errorClassificationNeedsBody', () => {
  const headers = (remaining: string | null) => ({
    get: (name: string) => (name === 'x-ratelimit-remaining' ? remaining : null),
  });

  it('本文が要るのは、rate limit のヘッダが無い 403 だけ', () => {
    expect(errorClassificationNeedsBody(403, headers(null))).toBe(true);
    expect(errorClassificationNeedsBody(403, headers('12'))).toBe(true);
    expect(errorClassificationNeedsBody(403, headers('0'))).toBe(false);
    for (const status of [401, 404, 409, 429, 500, 503]) {
      expect(errorClassificationNeedsBody(status, headers(null))).toBe(false);
    }
  });

  it('本文が要らないと言った応答は、本文が何であっても分類が変わらない（classifyErrorResponse と揃う）', () => {
    const messages = ['', 'API rate limit exceeded', 'Resource protected by organization SAML'];
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502]) {
      for (const remaining of [null, '0', '5']) {
        const h = headers(remaining);
        const kinds = new Set(
          messages.map((message) => classifyErrorResponse(status, h, message, 0).kind),
        );
        if (!errorClassificationNeedsBody(status, h)) expect(kinds.size).toBe(1);
      }
    }
  });
});

describe('classifyFetchFailure', () => {
  it('navigator.onLine が false のときだけオフラインとする（true や不明は信用しない）', () => {
    expect(classifyFetchFailure(false).kind).toBe('offline');
    expect(classifyFetchFailure(true).kind).toBe('network');
    expect(classifyFetchFailure(undefined).kind).toBe('network');
  });
});

describe('待ち時間の方針', () => {
  it('案内は中断より先に出し、再帰の tree は一覧より長く待つ', () => {
    expect(SLOW_NOTICE_MS).toBeLessThan(METADATA_TIMEOUT_MS);
    expect(SLOW_NOTICE_MS).toBeLessThan(BLOB_STALL_TIMEOUT_MS);
    expect(RECURSIVE_TREE_TIMEOUT_MS).toBeGreaterThan(METADATA_TIMEOUT_MS);
  });
});

describe('一覧の正規化', () => {
  it('インストール ID だけを拾い、形の違う項目は落とす', () => {
    expect(
      normalizeInstallations({ installations: [{ id: 1 }, { id: '2' }, null, { id: 3 }] }),
    ).toEqual([1, 3]);
    expect(normalizeInstallations({})).toBeNull();
  });

  it('リポジトリを正規化する', () => {
    expect(
      normalizeRepositories({
        repositories: [
          {
            id: 42,
            name: 'novel',
            owner: { login: 'octo' },
            default_branch: 'main',
            private: true,
          },
          { id: 43, name: 'x', owner: { login: 'octo' } },
          { id: 44, name: 'broken' },
          'junk',
        ],
      }),
    ).toEqual([
      REPOSITORY,
      { id: 43, owner: 'octo', name: 'x', defaultBranch: '', private: false },
    ]);
    expect(normalizeRepositories([])).toBeNull();
  });

  it('複数のインストールで重複したリポジトリは1つにし、名前順に並べる', () => {
    const b = { ...REPOSITORY, id: 1, owner: 'b', name: 'z' };
    const a = { ...REPOSITORY, id: 2, owner: 'a', name: 'y' };
    expect(mergeRepositories([[b, a], [a]])).toEqual([a, b]);
  });

  it('ブランチ名を拾う', () => {
    expect(normalizeBranches([{ name: 'main' }, { name: '' }, {}, { name: 'dev' }])).toEqual([
      'main',
      'dev',
    ]);
    expect(normalizeBranches({})).toBeNull();
  });

  it('既定ブランチを先頭にして、残りは名前順', () => {
    expect(orderBranches(['zeta', 'main', 'alpha', 'main'], 'main')).toEqual([
      'main',
      'alpha',
      'zeta',
    ]);
    expect(orderBranches(['b', 'a'], 'gone')).toEqual(['a', 'b']);
  });

  it('ref からコミット SHA を、コミットから tree SHA を取る', () => {
    expect(normalizeRefCommitSha({ object: { sha: SHA_A, type: 'commit' } })).toBe(SHA_A);
    // 注釈付きタグなどコミット以外を指す ref は固定に使わない。
    expect(normalizeRefCommitSha({ object: { sha: SHA_A, type: 'tag' } })).toBeNull();
    expect(normalizeRefCommitSha({})).toBeNull();
    expect(normalizeCommitTreeSha({ tree: { sha: SHA_B } })).toBe(SHA_B);
    expect(normalizeCommitTreeSha({ tree: { sha: 'short' } })).toBeNull();
    expect(normalizeCommitTreeSha(null)).toBeNull();
  });
});

describe('tree の分類', () => {
  it('mode / type を正として分類する', () => {
    expect(classifyTreeEntry('040000', 'tree', 'docs', null)).toBe('dir');
    expect(classifyTreeEntry('100644', 'blob', 'a.md', 10)).toBe('importable');
    expect(classifyTreeEntry('100755', 'blob', 'a.TXT', 10)).toBe('importable');
    expect(classifyTreeEntry('100644', 'blob', 'a.png', 10)).toBe('unsupported');
    // 名前が対応拡張子でも、リンクとサブモジュールは中身がスナップショットの外にあり得る。
    expect(classifyTreeEntry('120000', 'blob', 'link.md', 10)).toBe('symlink');
    expect(classifyTreeEntry('160000', 'commit', 'sub.md', null)).toBe('submodule');
    // 上限はローカルのファイルと同じ（GitHub の blob API の 100MB ではない）。
    expect(classifyTreeEntry('100644', 'blob', 'huge.md', MAX_INPUT_BYTES + 1)).toBe('tooLarge');
    expect(classifyTreeEntry('100644', 'blob', 'edge.md', MAX_INPUT_BYTES)).toBe('importable');
    expect(classifyTreeEntry('100644', 'weird', 'a.md', 1)).toBeNull();
  });

  it('1階層分を、フォルダ → ファイルの名前順に並べる', () => {
    const tree = normalizeTree(
      {
        sha: SHA_A,
        truncated: false,
        tree: [
          { path: 'b.md', mode: '100644', type: 'blob', sha: SHA_B, size: 12 },
          { path: 'z-dir', mode: '040000', type: 'tree', sha: SHA_C },
          { path: 'a.png', mode: '100644', type: 'blob', sha: SHA_A, size: 3 },
          { path: 'a-dir', mode: '040000', type: 'tree', sha: SHA_A },
        ],
      },
      'docs',
    );
    expect(tree?.truncated).toBe(false);
    expect(tree?.entries.map((entry) => [entry.path, entry.status, entry.size])).toEqual([
      ['docs/a-dir', 'dir', null],
      ['docs/z-dir', 'dir', null],
      ['docs/a.png', 'unsupported', 3],
      ['docs/b.md', 'importable', 12],
    ]);
  });

  it('打ち切られた一覧はそうと分かるように返す', () => {
    expect(normalizeTree({ tree: [], truncated: true }, '')?.truncated).toBe(true);
  });

  it('recursive tree はネストした path を起点ディレクトリからの完全パスにする', () => {
    const tree = normalizeRecursiveTree(
      {
        tree: [
          { path: 'a', mode: '040000', type: 'tree', sha: SHA_A },
          { path: 'a/ch1.md', mode: '100644', type: 'blob', sha: SHA_B, size: 12 },
          { path: 'a/deep/ch2.txt', mode: '100644', type: 'blob', sha: SHA_C, size: 4 },
          { path: '../escape.md', mode: '100644', type: 'blob', sha: SHA_A, size: 1 },
        ],
        truncated: false,
      },
      'chapters',
    );

    expect(tree?.entries.map((entry) => [entry.path, entry.status])).toEqual([
      ['chapters/a', 'dir'],
      ['chapters/a/ch1.md', 'importable'],
      ['chapters/a/deep/ch2.txt', 'importable'],
    ]);
    expect(tree?.truncated).toBe(false);
  });

  it('recursive tree の truncated を保持する', () => {
    expect(normalizeRecursiveTree({ tree: [], truncated: true }, '')?.truncated).toBe(true);
  });

  it('形の違う項目は落とす', () => {
    const tree = normalizeTree(
      {
        tree: [
          null,
          { path: 'x/y.md', mode: '100644', type: 'blob', sha: SHA_A },
          { path: 'bad-sha.md', mode: '100644', type: 'blob', sha: 'nope' },
          { path: 'no-mode.md', type: 'blob', sha: SHA_A },
          { path: 'unknown', mode: '100644', type: 'weird', sha: SHA_A },
          { path: 'neg.md', mode: '100644', type: 'blob', sha: SHA_A, size: -1 },
        ],
      },
      '',
    );
    expect(tree?.entries).toEqual([
      { name: 'neg.md', path: 'neg.md', sha: SHA_A, status: 'importable', size: null },
    ]);
    expect(normalizeTree({}, '')).toBeNull();
  });

  it('選べない理由を添える', () => {
    expect(describeEntryStatus('dir')).toBeNull();
    expect(describeEntryStatus('importable')).toBeNull();
    expect(describeEntryStatus('unsupported')).toBe('非対応の形式');
    expect(describeEntryStatus('tooLarge')).toBe('5MiB を超えるため取り込めません');
    expect(describeEntryStatus('symlink')).toBe('シンボリックリンク');
    expect(describeEntryStatus('submodule')).toBe('サブモジュール');
  });

  it('バイト数を読みやすくする', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0MB');
  });
});

describe('buildCandidate', () => {
  const entry = { path: 'chapters/ch1.md', sha: SHA_C, status: 'importable' as const };

  it('固定したスナップショットの出自を付けて、本文を decodeText で読む', () => {
    const result = buildCandidate(SNAPSHOT, entry, bytes(`${BOM}本文`));
    expect(result).toEqual({
      kind: 'ok',
      candidate: {
        source: {
          kind: 'github',
          repositoryId: 42,
          owner: 'octo',
          repo: 'novel',
          ref: 'main',
          commitSha: SHA_A,
          path: 'chapters/ch1.md',
          blobSha: SHA_C,
        },
        title: 'ch1.md',
        text: '本文',
        encoding: 'utf-8',
        size: 9,
      },
    });
  });

  it('UTF-8 として読めなければ Shift_JIS として読み、そうと分かるようにする', () => {
    // 「あ」の Shift_JIS
    const result = buildCandidate(SNAPSHOT, entry, new Uint8Array([0x82, 0xa0]).buffer);
    expect(result.kind === 'ok' && result.candidate).toMatchObject({
      text: 'あ',
      encoding: 'shift_jis',
    });
  });

  it('Git LFS のポインタは本文として取り込まない', () => {
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123456\n';
    expect(isLfsPointer(new TextEncoder().encode(pointer))).toBe(true);
    const result = buildCandidate(SNAPSHOT, entry, bytes(pointer));
    expect(result.kind === 'error' && result.message).toContain('Git LFS');
  });

  it('大きなファイルはポインタとみなさない', () => {
    const big = new Uint8Array(2048);
    big.set(new TextEncoder().encode('version https://git-lfs.github.com/spec/v1'));
    expect(isLfsPointer(big)).toBe(false);
  });

  it('取り込めない種類・上限超えは拒否する', () => {
    expect(buildCandidate(SNAPSHOT, { ...entry, status: 'symlink' }, bytes('x')).kind).toBe(
      'error',
    );
    const huge = new ArrayBuffer(MAX_INPUT_BYTES + 1);
    expect(buildCandidate(SNAPSHOT, entry, huge)).toEqual({
      kind: 'error',
      message: 'chapters/ch1.md は 5MiB を超えるため取り込めません。',
    });
    expect(buildCandidate(SNAPSHOT, entry, new ArrayBuffer(MAX_INPUT_BYTES)).kind).toBe('ok');
  });
});

describe('上限を超える blob', () => {
  it('文言は一覧・取得・候補で共通で、見えない文字は見える形にする', () => {
    expect(blobTooLargeMessage('docs/a.md')).toBe('docs/a.md は 5MiB を超えるため取り込めません。');
    expect(blobTooLargeMessage('a\u202egpj.md')).toContain('⟨U+202E⟩');
  });

  it('Content-Length は整数として読めるときだけ使う', () => {
    expect(parseContentLength('5242881')).toBe(5242881);
    expect(parseContentLength(' 12 ')).toBe(12);
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('-1')).toBeNull();
    expect(parseContentLength('1.5')).toBeNull();
    expect(parseContentLength('12, 12')).toBeNull();
    expect(parseContentLength('9'.repeat(20))).toBeNull();
  });
});
