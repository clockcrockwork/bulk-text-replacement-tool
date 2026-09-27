import type {
  GitHubEntryStatus,
  GitHubInputSource,
  GitHubRepository,
  GitHubSnapshot,
  GitHubTreeEntry,
} from '../types';
import { isAcceptedFile } from './inputFiles';
import { baseName, isGitSha } from './inputSource';
import { type DecodedText, decodeText } from './text';

/**
 * GitHub REST API の応答を、アプリが使う形へ正規化する。通信そのものは
 * `src/github/client.ts` が持ち、ここは受け取った JSON とヘッダだけを見る。
 *
 * 応答は外から来る値なので `as` で通さない。想定外の形の項目は落とす。
 */

export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** 仕様どおりに解釈させるため、API の版を固定する。 */
export const GITHUB_API_VERSION = '2026-03-10';

/** Git blob API が扱える上限。これを超えるファイルは取得を試みない。 */
export const MAX_BLOB_BYTES = 100 * 1024 * 1024;

/** 1回で取れる件数の上限。ページ数を減らして rate limit を節約する。 */
export const PER_PAGE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** パスの各区切りを URL 用に符号化する（`/` は区切りとして残す）。 */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * `Link` ヘッダから次のページの URL を取り出す。
 *
 * 次ページの URL にもトークンを付けて送るので、API 以外のオリジンを指していたら
 * 辿らない（ヘッダを信用してトークンを別の宛先へ渡さない）。
 */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (!match?.[1]) continue;
    try {
      const url = new URL(match[1]);
      return url.origin === GITHUB_API_ORIGIN ? url.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- エラー ------------------------------------------------------------------

export type GitHubErrorKind =
  /** トークンの失効・取り消し。接続し直す。 */
  | 'unauthorized'
  /** API の利用上限。時間を置く。 */
  | 'rateLimited'
  /** Organization の SAML SSO でアクセスが隠れている。 */
  | 'sso'
  | 'forbidden'
  /** 対象が無い、または権限が外れて見えなくなった。 */
  | 'notFound'
  /** コミットが1つも無いリポジトリ（Git データの API は 409 を返す）。 */
  | 'emptyRepository'
  | 'server'
  | 'network'
  /** 期待した形の応答ではない。 */
  | 'invalidResponse';

export interface GitHubError {
  kind: GitHubErrorKind;
  status: number | null;
  /** rate limit が解ける時刻（ミリ秒）。分からなければ null。 */
  resetAt: number | null;
}

interface HeaderReader {
  get(name: string): string | null;
}

/** rate limit の解除時刻。`retry-after`（秒）を優先し、無ければ `x-ratelimit-reset`（UNIX 秒）。 */
function rateLimitResetAt(headers: HeaderReader, now: number): number | null {
  const retryAfter = Number(headers.get('retry-after'));
  if (headers.get('retry-after') !== null && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return now + retryAfter * 1000;
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-reset') !== null && Number.isFinite(reset) && reset > 0) {
    return reset * 1000;
  }
  return null;
}

/**
 * 失敗した応答を分類する。
 *
 * rate limit は一般の 403 と見分ける。どちらも 403 で返り得るが、利用者が取るべき
 * 行動（待つ／権限を見直す）が違う。
 */
export function classifyErrorResponse(
  status: number,
  headers: HeaderReader,
  now: number,
): GitHubError {
  const base = { status, resetAt: null };
  if (status === 401) return { ...base, kind: 'unauthorized' };
  const limited =
    status === 429 ||
    (status === 403 &&
      (headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null));
  if (limited) return { kind: 'rateLimited', status, resetAt: rateLimitResetAt(headers, now) };
  if (status === 403 && headers.get('x-github-sso') !== null) return { ...base, kind: 'sso' };
  if (status === 403) return { ...base, kind: 'forbidden' };
  if (status === 404) return { ...base, kind: 'notFound' };
  if (status === 409) return { ...base, kind: 'emptyRepository' };
  if (status >= 500) return { ...base, kind: 'server' };
  return { ...base, kind: 'invalidResponse' };
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 失敗を利用者向けの文にする。 */
export function describeGitHubError(error: GitHubError): string {
  switch (error.kind) {
    case 'unauthorized':
      return 'GitHub との接続が切れました（有効期限切れか、承認が取り消されています）。もう一度接続してください。';
    case 'rateLimited':
      return error.resetAt === null
        ? 'GitHub API の利用上限に達しました。しばらく待ってから再試行してください。'
        : `GitHub API の利用上限に達しました。${formatClock(error.resetAt)} ごろから再試行できます。`;
    case 'sso':
      return 'Organization の SAML SSO による承認が必要です。GitHub で SSO を承認してから再試行してください。';
    case 'forbidden':
      return 'このリポジトリを読む権限がありません。GitHub App の権限設定を確認してください。';
    case 'notFound':
      return '見つかりませんでした。リポジトリ・ブランチが削除されたか、App のアクセス対象から外れた可能性があります。';
    case 'emptyRepository':
      return 'このリポジトリにはまだコミットがありません。';
    case 'server':
      return 'GitHub 側でエラーが起きました。しばらくしてから再試行してください。';
    case 'network':
      return 'GitHub に接続できませんでした。ネットワークを確認して再試行してください。';
    case 'invalidResponse':
      return 'GitHub から想定外の応答が返りました。再試行してください。';
  }
}

// ---- 応答の正規化 --------------------------------------------------------------

/** `GET /user/installations` → インストール ID の一覧。 */
export function normalizeInstallations(value: unknown): number[] | null {
  if (!isRecord(value) || !Array.isArray(value.installations)) return null;
  return value.installations.flatMap((item) =>
    isRecord(item) && isPositiveInteger(item.id) ? [item.id] : [],
  );
}

function normalizeRepository(value: unknown): GitHubRepository | null {
  if (!isRecord(value) || !isRecord(value.owner)) return null;
  const { id, name, default_branch: defaultBranch } = value;
  const owner = value.owner.login;
  if (!isPositiveInteger(id) || !nonEmptyString(name) || !nonEmptyString(owner)) return null;
  return {
    id,
    owner,
    name,
    // 空のリポジトリでも既定ブランチ名は返るが、欠けていれば main とみなさず空にする。
    defaultBranch: nonEmptyString(defaultBranch) ? defaultBranch : '',
    private: value.private === true,
  };
}

/** `GET /user/installations/{id}/repositories` → リポジトリの一覧。 */
export function normalizeRepositories(value: unknown): GitHubRepository[] | null {
  if (!isRecord(value) || !Array.isArray(value.repositories)) return null;
  return value.repositories.flatMap((item) => {
    const repository = normalizeRepository(item);
    return repository ? [repository] : [];
  });
}

/**
 * 複数のインストールから集めたリポジトリを1本にする。
 *
 * 同じリポジトリが複数のインストール経由で見えることがあるので ID で重複を除き、
 * 探しやすいよう `owner/name` 順に並べる。
 */
export function mergeRepositories(lists: readonly GitHubRepository[][]): GitHubRepository[] {
  const byId = new Map<number, GitHubRepository>();
  for (const list of lists) {
    for (const repository of list) {
      if (!byId.has(repository.id)) byId.set(repository.id, repository);
    }
  }
  return [...byId.values()].sort((a, b) =>
    compareCodePoints(`${a.owner}/${a.name}`, `${b.owner}/${b.name}`),
  );
}

/** `GET /repos/{owner}/{repo}/branches` → ブランチ名。 */
export function normalizeBranches(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => (isRecord(item) && nonEmptyString(item.name) ? [item.name] : []));
}

/** 既定ブランチを先頭にし、残りは名前順にする。 */
export function orderBranches(names: readonly string[], defaultBranch: string): string[] {
  const unique = [...new Set(names)];
  const rest = unique.filter((name) => name !== defaultBranch).sort(compareCodePoints);
  return unique.includes(defaultBranch) ? [defaultBranch, ...rest] : rest;
}

/** `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` → 先頭のコミット SHA。 */
export function normalizeRefCommitSha(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.object)) return null;
  const { sha, type } = value.object;
  return type === 'commit' && isGitSha(sha) ? sha : null;
}

/** `GET /repos/{owner}/{repo}/git/commits/{sha}` → ルートの tree SHA。 */
export function normalizeCommitTreeSha(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.tree)) return null;
  return isGitSha(value.tree.sha) ? value.tree.sha : null;
}

/** 名前順。ロケールに依らず毎回同じ並びにするため、コードポイントで比べる。 */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** ディレクトリ内の名前をリポジトリのルートからのパスにする。 */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * tree の1項目をどう扱うか決める。
 *
 * シンボリックリンクとサブモジュールの判定は mode / type を正とする（名前では決めない）。
 * リンク先やサブモジュールの中身は、固定したスナップショットの外にあり得る。
 */
export function classifyTreeEntry(
  mode: string,
  type: string,
  name: string,
  size: number | null,
): GitHubEntryStatus | null {
  if (mode === '120000') return 'symlink';
  if (mode === '160000' || type === 'commit') return 'submodule';
  if (type === 'tree') return 'dir';
  if (type !== 'blob') return null;
  if (!isAcceptedFile(name)) return 'unsupported';
  if (size !== null && size > MAX_BLOB_BYTES) return 'tooLarge';
  return 'importable';
}

const STATUS_ORDER: Record<GitHubEntryStatus, number> = {
  dir: 0,
  importable: 1,
  unsupported: 1,
  tooLarge: 1,
  symlink: 1,
  submodule: 1,
};

export interface NormalizedTree {
  entries: GitHubTreeEntry[];
  /**
   * GitHub が途中で打ち切ったか。打ち切られた一覧を「全部」として扱わない
   * （見えていないファイルがある、と画面で知らせる）。
   */
  truncated: boolean;
}

/**
 * `GET /repos/{owner}/{repo}/git/trees/{sha}`（非再帰）を1階層分の一覧にする。
 *
 * `dir` はこの tree が置かれているディレクトリのパス（ルートなら空文字）。
 */
export function normalizeTree(value: unknown, dir: string): NormalizedTree | null {
  if (!isRecord(value) || !Array.isArray(value.tree)) return null;
  const entries = value.tree.flatMap((item): GitHubTreeEntry[] => {
    if (!isRecord(item)) return [];
    const { path: name, mode, type, sha } = item;
    if (!nonEmptyString(name) || name.includes('/') || !isGitSha(sha)) return [];
    if (typeof mode !== 'string' || typeof type !== 'string') return [];
    const size =
      typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
        ? item.size
        : null;
    const status = classifyTreeEntry(mode, type, name, size);
    if (!status) return [];
    return [{ name, path: joinPath(dir, name), sha, status, size }];
  });
  entries.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || compareCodePoints(a.name, b.name),
  );
  return { entries, truncated: value.truncated === true };
}

/** 選べない項目の理由。一覧に並べるときに添える。 */
export function describeEntryStatus(status: GitHubEntryStatus): string | null {
  switch (status) {
    case 'dir':
    case 'importable':
      return null;
    case 'unsupported':
      return '非対応の形式';
    case 'tooLarge':
      return '100MB を超えるため取得できません';
    case 'symlink':
      return 'シンボリックリンク';
    case 'submodule':
      return 'サブモジュール';
  }
}

/** バイト数を読みやすくする。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---- 取り込み候補 --------------------------------------------------------------

/** Git LFS のポインタファイルの先頭。本文ではなく、実体の在りかを指す数行のテキスト。 */
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

/** ポインタファイルは数百バイト。大きなファイルまで文字列にして調べない。 */
const LFS_POINTER_MAX_BYTES = 1024;

export function isLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength > LFS_POINTER_MAX_BYTES) return false;
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, LFS_POINTER_PREFIX.length));
  return head === LFS_POINTER_PREFIX;
}

/** 取り込みを確定する前の1ファイル。まだワークスペースには入っていない。 */
export interface GitHubCandidate {
  source: GitHubInputSource;
  /** 入力のタイトルの初期値（ファイル名）。 */
  title: string;
  text: string;
  encoding: DecodedText['encoding'];
  size: number;
}

export type CandidateResult =
  | { kind: 'ok'; candidate: GitHubCandidate }
  | { kind: 'error'; message: string };

/**
 * 取得したバイト列を、取り込み候補にする。
 *
 * 文字コードの判定はローカルのファイルと同じ `decodeText` を通す
 * （取り込み経路ごとに読み方が違うと、同じファイルが経路で別の本文になる）。
 */
export function buildCandidate(
  snapshot: GitHubSnapshot,
  entry: Pick<GitHubTreeEntry, 'path' | 'sha' | 'status'>,
  buffer: ArrayBuffer,
): CandidateResult {
  if (entry.status !== 'importable') {
    return { kind: 'error', message: `${entry.path} は取り込めない種類のファイルです。` };
  }
  if (buffer.byteLength > MAX_BLOB_BYTES) {
    return { kind: 'error', message: `${entry.path} は 100MB を超えるため取り込めません。` };
  }
  if (isLfsPointer(new Uint8Array(buffer))) {
    return {
      kind: 'error',
      message: `${entry.path} は Git LFS のポインタです。本文は LFS 側にあり、この画面からは取り込めません。`,
    };
  }
  const { text, encoding } = decodeText(buffer);
  const { repository } = snapshot;
  return {
    kind: 'ok',
    candidate: {
      source: {
        kind: 'github',
        repositoryId: repository.id,
        owner: repository.owner,
        repo: repository.name,
        ref: snapshot.ref,
        commitSha: snapshot.commitSha,
        path: entry.path,
        blobSha: entry.sha,
      },
      title: baseName(entry.path),
      text,
      encoding,
      size: buffer.byteLength,
    },
  };
}
