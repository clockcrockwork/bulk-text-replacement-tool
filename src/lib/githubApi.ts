import type {
  GitHubEntryStatus,
  GitHubInputSource,
  GitHubRepository,
  GitHubSnapshot,
  GitHubTreeEntry,
} from '../types';
import { isAcceptedFile } from './inputFiles';
import { formatLimit, MAX_INPUT_BYTES } from './inputLimits';
import { baseName, isGitSha, isRepositoryPath } from './inputSource';
import { revealUnsafeChars } from './revealText';
import { type DecodedText, decodeText } from './text';

/**
 * GitHub REST API の応答を、アプリが使う形へ正規化する。通信そのものは
 * `src/github/client.ts` が持ち、ここは受け取った JSON とヘッダだけを見る。
 *
 * 応答は外から来る値なので `as` で通さない。想定外の形の項目は落とす。
 */

export const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * GitHub の CORS 方針（公式ドキュメントの preflight 応答の例）。
 * https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests
 *
 * ブラウザから api.github.com へ直接取りに行くので、ここに無い要求ヘッダを付けると
 * preflight で止まり、ここに無い応答ヘッダは読めない（null になる）。
 *
 * `X-GitHub-Api-Version` はこの許可リストに無いので**付けない**。版を指定しない
 * リクエストは GitHub の既定版（現在 `2022-11-28`）で処理される。使っている項目
 * （id / name / owner.login / default_branch / private、ref・commit・tree・blob）は
 * `2026-03-10` の破壊的変更の対象外で、どちらの版でも同じ形で返る。
 */
export const GITHUB_CORS_ALLOWED_REQUEST_HEADERS: readonly string[] = [
  'authorization',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'x-requested-with',
];

/** 同じ例の `Access-Control-Expose-Headers`。`retry-after` や `x-github-sso` は読めない。 */
export const GITHUB_CORS_EXPOSED_RESPONSE_HEADERS: readonly string[] = [
  'etag',
  'link',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-oauth-scopes',
  'x-accepted-oauth-scopes',
  'x-poll-interval',
];

/**
 * api.github.com へ送るヘッダ。
 *
 * `Accept` は CORS-safelisted、`Authorization` は GitHub が preflight で許可している。
 * これ以外を足すときは `GITHUB_CORS_ALLOWED_REQUEST_HEADERS` に載っているかを先に確かめる
 * （モックの E2E は GitHub 本番の CORS を再現しないので、ここで止める）。
 */
export function githubRequestHeaders(accessToken: string, accept: string): Record<string, string> {
  return { Accept: accept, Authorization: `Bearer ${accessToken}` };
}

/**
 * api.github.com への fetch の共通オプション。
 *
 * - `cache: 'no-store'`: ブランチの HEAD がキャッシュされると「最新に更新」が効かない
 *   （GitHub は max-age=60 を返す）。これでブラウザが足す Cache-Control / Pragma は、
 *   作者が付けたヘッダではないので preflight の対象にならない
 * - `credentials: 'omit'`: 認証は Authorization だけで行い、Cookie は送らない
 * - `referrerPolicy: 'no-referrer'`: どの画面から来たかを GitHub へ渡さない
 *
 * 中身が変わらない tree / blob はフック側がメモリに持つので、ここでは常に取りに行く。
 * `e2e/githubCors.spec.ts` がこのオプションとヘッダで、GitHub の CORS 方針を再現した
 * サーバーへ実ブラウザから通ることを確かめている。
 */
export const GITHUB_FETCH_INIT = {
  cache: 'no-store',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
} as const satisfies RequestInit;

// ---- 待ち時間の方針（issue #20） ------------------------------------------------
//
// どれも「利用者の操作1回」ではなく「1リクエスト」に掛ける。ページ送りは1ページずつ、
// 一括取り込みは blob 1件ずつなので、一覧が長い・件数が多いといった正常に長い操作は切らない。
// 値は保守的な初期値で、実機で正常な利用を切っていると分かったら調整する。

/** 利用者に見える進みがこの時間なければ「時間がかかっています」と添える。 */
export const SLOW_NOTICE_MS = 8_000;

/**
 * 一覧・ref・commit・非再帰の tree の1リクエスト（ヘッダと本文の合計）。
 * 応答が小さく、大きさで時間が伸びないもの。
 */
export const METADATA_TIMEOUT_MS = 30_000;

/** 再帰の tree の1リクエスト。GitHub 側の生成に時間がかかり、応答も数 MB になり得る。 */
export const RECURSIVE_TREE_TIMEOUT_MS = 60_000;

/**
 * blob を1バイトも受け取れていない時間（ヘッダ待ちを含む）。blob は大きさで正常な所要時間が
 * 変わるので、合計ではなく「受信が止まっている時間」で見る。何 MB まで受け入れるかは
 * 別の方針（`src/lib/inputLimits.ts`・issue #19）で、ここでは決めない。
 */
export const BLOB_STALL_TIMEOUT_MS = 30_000;

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
  /** 端末がオフライン（`navigator.onLine` が false）。 */
  | 'offline'
  /** 決めた時間のあいだ応答がない、または受信が止まった。 */
  | 'timeout'
  /** 期待した形の応答ではない。 */
  | 'invalidResponse'
  /** 一覧が長すぎて、辿れる上限までに終わらなかった（途中までの一覧は使わない）。 */
  | 'listTooLong';

export interface GitHubError {
  kind: GitHubErrorKind;
  status: number | null;
  /** rate limit が解ける時刻（ミリ秒）。分からなければ null。 */
  resetAt: number | null;
  /**
   * `timeout` のとき、待った時間と、何を待っていたか。`stall` は blob の受信が止まった
   * （合計時間ではなく、データが途切れている時間で切った）。
   */
  timeout?: { ms: number; stall: boolean };
}

/**
 * fetch 自体が失敗した（応答が無い）ときの分類。
 *
 * `navigator.onLine` は false のときだけ信用する（true でも通じていないことはよくある）。
 * 失敗した時点で1回読むだけにし、`online` イベントで自動の再試行はしない。
 */
export function classifyFetchFailure(online: boolean | undefined): GitHubError {
  return { kind: online === false ? 'offline' : 'network', status: null, resetAt: null };
}

/** 時間切れの失敗。`stall` は受信が止まったこと（blob）を表す。 */
export function timeoutError(ms: number, stall: boolean): GitHubError {
  return { kind: 'timeout', status: null, resetAt: null, timeout: { ms, stall } };
}

interface HeaderReader {
  get(name: string): string | null;
}

/** secondary rate limit を待つ目安。解除時刻が分からないときは最低1分待つよう案内されている。 */
const SECONDARY_RATE_LIMIT_WAIT_MS = 60 * 1000;

/** primary rate limit の窓。解除は長くてもこの長さの先に来る。 */
const PRIMARY_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * `x-ratelimit-reset`（サーバーの時計での時刻）を、この端末の時計での待ち時間に直す。
 *
 * 端末の時計がずれていると、そのまま使った解除時刻もずれる。遅れていれば待ちが不当に
 * 伸び（数十日ずれると、待ちを測るタイマーそのものが働かなくなる）、進んでいれば
 * 解除前に再試行させてしまう。GitHub の窓の長さを超えて待たせず、解除時刻が過去に
 * 見えても最低限（secondary と同じ1分）は待たせる。
 */
function rateLimitResetAt(resetSeconds: number, now: number): number {
  const wait = resetSeconds * 1000 - now;
  return now + Math.min(Math.max(wait, SECONDARY_RATE_LIMIT_WAIT_MS), PRIMARY_RATE_LIMIT_WINDOW_MS);
}

/** 失敗した応答の本文から `message` を取り出す。読めなければ空文字。 */
export function readErrorMessage(body: string): string {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && typeof value.message === 'string' ? value.message : '';
  } catch {
    return '';
  }
}

/**
 * 失敗した応答を分類する。
 *
 * rate limit は一般の 403 と見分ける。どちらも 403 で返り得るが、利用者が取るべき
 * 行動（待つ／権限を見直す）が違う。ブラウザから読める応答ヘッダは CORS で限られる
 * （`retry-after` や `x-github-sso` は読めない）ので、読めるヘッダ（`x-ratelimit-*`）と
 * 本文の `message` で判断する。
 * - primary: `x-ratelimit-remaining` が 0。解除は `x-ratelimit-reset`
 * - secondary: 403 / 429 と、secondary rate limit を示すメッセージ
 * - SAML SSO: 403 と、SAML による保護を示すメッセージ
 */
export function classifyErrorResponse(
  status: number,
  headers: HeaderReader,
  message: string,
  now: number,
): GitHubError {
  const base = { status, resetAt: null };
  if (status === 401) return { ...base, kind: 'unauthorized' };
  if (status === 403 || status === 429) {
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      const resetAt =
        headers.get('x-ratelimit-reset') !== null && Number.isFinite(reset) && reset > 0
          ? rateLimitResetAt(reset, now)
          : now + SECONDARY_RATE_LIMIT_WAIT_MS;
      return { kind: 'rateLimited', status, resetAt };
    }
    if (status === 429 || /rate limit/i.test(message)) {
      return { kind: 'rateLimited', status, resetAt: now + SECONDARY_RATE_LIMIT_WAIT_MS };
    }
    if (/SAML/i.test(message)) return { ...base, kind: 'sso' };
    return { ...base, kind: 'forbidden' };
  }
  if (status === 404) return { ...base, kind: 'notFound' };
  if (status === 409) return { ...base, kind: 'emptyRepository' };
  if (status >= 500) return { ...base, kind: 'server' };
  return { ...base, kind: 'invalidResponse' };
}

/**
 * 失敗した応答の分類に、本文（`message`）が要るか。
 *
 * 401・404・409・429・5xx と、`x-ratelimit-remaining: 0` の 403 は、状態コードとヘッダだけで
 * 決まる。それ以外の 403 は、secondary rate limit・SAML SSO・一般の 403 を本文でしか
 * 見分けられない。本文が途中で止まったとき、これが true なら分類せずに時間切れ（または
 * 通信の失敗）として扱う（`classifyErrorResponse` と条件を揃える）。
 */
export function errorClassificationNeedsBody(status: number, headers: HeaderReader): boolean {
  return status === 403 && headers.get('x-ratelimit-remaining') !== '0';
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** どの取得で失敗したか。同じ失敗でも、利用者が取れる次の手は段階で変わる。 */
export type GitHubFetchStage = 'repositories' | 'branches' | 'snapshot' | 'tree' | 'blob';

/**
 * 失敗のあとに利用者へ出す次の手。
 *
 * - `retry`: 同じ取得をやり直す（一時的な失敗）
 * - `dismiss`: やり直しても同じ結果になる。知らせを閉じるだけ
 * - `reselect`: リポジトリの一覧を取り直して選び直す（リポジトリが消えた・見えなくなった・空）
 * - `chooseBranch`: ブランチの一覧へ戻す（選んでいたブランチが消えた・名前が変わった）
 */
export type GitHubRecovery = 'retry' | 'dismiss' | 'reselect' | 'chooseBranch';

/**
 * 失敗の種類と段階から、次の手を決める。
 *
 * 再試行は「やり直せば変わるかもしれない」失敗にだけ出す。リポジトリ一覧を取ったあとで
 * 既定ブランチが改名・削除されると、同じ ref の解決を何度やり直しても 404 のままで、
 * 利用者は再試行を押し続けるしかなくなる。404 は段階ごとに、変わり得る場所まで戻す。
 */
export function recoveryFor(error: GitHubError, stage: GitHubFetchStage): GitHubRecovery {
  switch (error.kind) {
    case 'listTooLong':
      // やり直しても同じ結果で、rate limit を食うだけ。
      return 'dismiss';
    case 'emptyRepository':
      // コミットが増えるまで何度やっても同じ。別のリポジトリを選んでもらう。
      return 'reselect';
    case 'notFound':
      if (stage === 'snapshot') return 'chooseBranch';
      // ブランチ一覧や、固定したコミットの tree / blob が無いのは、リポジトリごと消えたか
      // App のアクセス対象から外れたとき。リポジトリの一覧から選び直す。
      if (stage !== 'repositories') return 'reselect';
      return 'retry';
    default:
      return 'retry';
  }
}

/**
 * 再帰 tree の要求が失敗したとき、非再帰の列挙（1階層ずつ）へ移ってよいか。
 *
 * 移るのは「再帰の要求・応答の大きさに固有の問題」だけ（時間切れ・5xx）。大きな部分木の
 * 再帰 tree は GitHub 側で重く、ここで落ちても1階層ずつなら取れることがある。
 * 権限・利用上限・SSO・404・オフラインは非再帰でも同じ結果になり、要求を増やして
 * rate limit を食うだけなので、今までどおり `recoveryFor` で次の手を決める。
 * 一般の network 失敗も、応答の大きさではなく経路の問題とみなして移らない。
 */
export function canFallBackFromRecursiveTree(error: GitHubError): boolean {
  return error.kind === 'timeout' || error.kind === 'server';
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
    case 'offline':
      return '端末がオフラインのため、GitHub に接続できませんでした。接続が戻ったら再試行してください。';
    case 'timeout': {
      const seconds = Math.round((error.timeout?.ms ?? 0) / 1000);
      return error.timeout?.stall
        ? `GitHub からの受信が ${seconds} 秒止まったため中断しました。通信状況を確認して再試行してください。`
        : `GitHub から ${seconds} 秒応答がなかったため中断しました。通信状況を確認して再試行してください。`;
    }
    case 'invalidResponse':
      return 'GitHub から想定外の応答が返りました。再試行してください。';
    case 'listTooLong':
      return '一覧が長すぎて、最後まで読み込めませんでした。途中までの一覧は正しくないため表示しません。';
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
export function compareCodePoints(a: string, b: string): number {
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
  // 上限はローカルのファイルと共有する（経路で扱いを分けない）。GitHub の blob API の
  // 境界（100MB）はそれより大きいので、ここでは見なくてよい。
  if (size !== null && size > MAX_INPUT_BYTES) return 'tooLarge';
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

function normalizeTreeResponse(
  value: unknown,
  dir: string,
  recursive: boolean,
): NormalizedTree | null {
  if (!isRecord(value) || !Array.isArray(value.tree)) return null;
  const entries = value.tree.flatMap((item): GitHubTreeEntry[] => {
    if (!isRecord(item)) return [];
    const { path: relativePath, mode, type, sha } = item;
    if (!nonEmptyString(relativePath) || !isGitSha(sha)) return [];
    if (!recursive && relativePath.includes('/')) return [];
    if (recursive && !isRepositoryPath(relativePath)) return [];
    if (typeof mode !== 'string' || typeof type !== 'string') return [];
    const size =
      typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
        ? item.size
        : null;
    const name = baseName(relativePath);
    const status = classifyTreeEntry(mode, type, name, size);
    if (!status) return [];
    return [{ name, path: joinPath(dir, relativePath), sha, status, size }];
  });
  entries.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || compareCodePoints(a.path, b.path),
  );
  return { entries, truncated: value.truncated === true };
}

/**
 * `GET /repos/{owner}/{repo}/git/trees/{sha}`（非再帰）を1階層分の一覧にする。
 *
 * `dir` はこの tree が置かれているディレクトリのパス（ルートなら空文字）。
 */
export function normalizeTree(value: unknown, dir: string): NormalizedTree | null {
  return normalizeTreeResponse(value, dir, false);
}

/**
 * `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` を、同じ path 形式へ正規化する。
 *
 * GitHub の recursive 応答内の path は起点 tree からの相対パスなので、`dir` を前置きする。
 * `truncated` が true の応答は呼び出し側で部分結果を捨て、非再帰 traversal へ fallback する。
 */
export function normalizeRecursiveTree(value: unknown, dir: string): NormalizedTree | null {
  return normalizeTreeResponse(value, dir, true);
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
      return `${formatLimit(MAX_INPUT_BYTES)} を超えるため取り込めません`;
    case 'symlink':
      return 'シンボリックリンク';
    case 'submodule':
      return 'サブモジュール';
  }
}

/** 1ファイルの上限を超えたときの文言。一覧・取得・候補のどこで分かっても同じにする。 */
export function blobTooLargeMessage(path: string): string {
  return `${revealUnsafeChars(path)} は ${formatLimit(MAX_INPUT_BYTES)} を超えるため取り込めません。`;
}

/**
 * `Content-Length` を読む。整数として読めなければ null。
 *
 * 応答が圧縮されていると、これは展開前の長さになる。上限を超えていれば読む前に
 * 断ってよいが、上限内でも本文が上限内とは限らないので、通す根拠には使わない
 * （最終的な判定は読みながら数えた長さ）。
 */
export function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : null;
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
    return {
      kind: 'error',
      message: `${revealUnsafeChars(entry.path)} は取り込めない種類のファイルです。`,
    };
  }
  // 取得の側（`getBlob`）で読みながら打ち切っているが、候補にする入口でも確かめる。
  if (buffer.byteLength > MAX_INPUT_BYTES) {
    return { kind: 'error', message: blobTooLargeMessage(entry.path) };
  }
  if (isLfsPointer(new Uint8Array(buffer))) {
    return {
      kind: 'error',
      message: `${revealUnsafeChars(entry.path)} は Git LFS のポインタです。本文は LFS 側にあり、この画面からは取り込めません。`,
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
