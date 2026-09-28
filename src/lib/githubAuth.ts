/**
 * GitHub App の認可（web application flow + PKCE）のうち、副作用を持たない部分。
 *
 * 乱数の生成・sessionStorage・画面遷移・トークン交換の通信は呼び出し側
 * （`useGitHubImport`）が持つ。ここは「何を送るか」「戻ってきた URL をどう判定するか」
 * だけを決める。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

/** トークン交換を受け持つ Vercel Function。同一オリジンにだけ置く。 */
export const TOKEN_EXCHANGE_PATH = '/api/github/token';

/**
 * リダイレクトを跨ぐあいだだけ置く一時情報の sessionStorage キー。
 * アクセストークンはここに置かない（メモリにだけ持つ）。
 */
export const PENDING_AUTH_KEY = 'bt-github-oauth-pending';

/**
 * 認可を始めてから戻ってくるまでの猶予。GitHub の認可コード自体が 10 分で切れるので、
 * それより古い一時情報は使わない。
 */
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

/** ビルド時に埋め込む公開設定。どちらかが無ければ GitHub 連携は使えない。 */
export interface GitHubAppConfig {
  clientId: string;
  /** インストール画面（github.com/apps/<slug>）の URL に使う。 */
  slug: string;
}

/** `import.meta.env` から公開設定を読む。値が無い・空なら null（連携を無効にする）。 */
export function readGitHubAppConfig(env: Record<string, unknown>): GitHubAppConfig | null {
  const clientId = env.VITE_GITHUB_APP_CLIENT_ID;
  const slug = env.VITE_GITHUB_APP_SLUG;
  if (typeof clientId !== 'string' || typeof slug !== 'string') return null;
  const trimmedId = clientId.trim();
  const trimmedSlug = slug.trim();
  if (!trimmedId || !/^[a-z0-9-]+$/i.test(trimmedSlug)) return null;
  return { clientId: trimmedId, slug: trimmedSlug };
}

/** App のインストール・リポジトリ権限の設定画面。 */
export function installationUrl(config: GitHubAppConfig): string {
  return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`;
}

/**
 * コールバック先。GitHub App に完全一致で登録する URL と同じ形にする。
 *
 * オリジン直下に固定している。ビルドは相対パス（vite の `base: './'`）なので、
 * 下位のパスで開くと JS / CSS の参照が壊れる。
 */
export function callbackUrl(origin: string): string {
  return `${origin}/`;
}

/** バイト列を base64url（パディング無し）にする。state・verifier・challenge で共有する。 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE の code_challenge（S256）。RFC 7636 の付録 B と同じ計算。 */
export async function codeChallengeS256(verifier: string, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * 認可画面の URL。
 *
 * 「インストール時に OAuth を要求する」設定には頼らず、毎回こちらから state と
 * code_challenge を付けて始める。GitHub 側から始まる認可では state を持たせられない。
 */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** リダイレクトを跨いで持ち越す一時情報。 */
export interface PendingAuth {
  state: string;
  verifier: string;
  /** 作った時刻（ミリ秒）。古いものを使わないために持つ。 */
  createdAt: number;
}

export function serializePendingAuth(pending: PendingAuth): string {
  return JSON.stringify(pending);
}

/** sessionStorage から読んだ文字列を検証する。形が違えば null。 */
export function parsePendingAuth(raw: string | null): PendingAuth | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { state, verifier, createdAt } = value;
  if (typeof state !== 'string' || state === '') return null;
  // RFC 7636: verifier は 43〜128 文字の unreserved 文字。
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return { state, verifier, createdAt };
}

/** GitHub から戻ってきたときに URL に付くもの。 */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri'] as const;

export type CallbackParams =
  | { kind: 'none' }
  | { kind: 'callback'; code: string | null; state: string | null; error: string | null };

/**
 * 今の URL が認可からの戻りかを判定する。
 *
 * `code` か `error` があれば戻りとみなす。state の検証はここではせず
 * `validateCallback` に任せる（「戻りではない」と「戻りだが不正」を区別して見せたい）。
 */
export function readCallbackParams(search: string): CallbackParams {
  const params = new URLSearchParams(search);
  const code = params.get('code');
  const error = params.get('error');
  if (code === null && error === null) return { kind: 'none' };
  return { kind: 'callback', code, state: params.get('state'), error };
}

/** 認可からの戻りを URL から取り除く。ほかのクエリとハッシュは残す。 */
export function stripCallbackParams(href: string): string {
  const url = new URL(href);
  for (const key of CALLBACK_PARAMS) url.searchParams.delete(key);
  return url.toString();
}

export type CallbackFailure =
  /** 利用者が GitHub の画面で拒否した。 */
  | 'denied'
  /** このタブで始めた認可の情報が無い（別タブ・期限切れ・直接開かれた URL）。 */
  | 'noPending'
  | 'expired'
  | 'stateMismatch'
  | 'invalid';

export type CallbackResult =
  | { kind: 'ok'; code: string; verifier: string }
  | { kind: 'error'; reason: CallbackFailure };

/**
 * 戻ってきた URL を、このタブで始めた認可と突き合わせる。
 *
 * state が一致しない戻りは、他人が用意したコードを掴ませる攻撃（login CSRF）の
 * 可能性があるので、コードを交換に回さない。
 */
export function validateCallback(
  callback: Extract<CallbackParams, { kind: 'callback' }>,
  pending: PendingAuth | null,
  now: number,
): CallbackResult {
  if (!pending) return { kind: 'error', reason: 'noPending' };
  if (callback.state !== pending.state) return { kind: 'error', reason: 'stateMismatch' };
  if (now - pending.createdAt > PENDING_AUTH_TTL_MS || now < pending.createdAt) {
    return { kind: 'error', reason: 'expired' };
  }
  if (callback.error !== null) return { kind: 'error', reason: 'denied' };
  if (!callback.code || !/^[A-Za-z0-9_.-]{1,256}$/.test(callback.code)) {
    return { kind: 'error', reason: 'invalid' };
  }
  return { kind: 'ok', code: callback.code, verifier: pending.verifier };
}

export function describeCallbackFailure(reason: CallbackFailure): string {
  switch (reason) {
    case 'denied':
      return 'GitHub での承認が取り消されました。接続し直す場合はもう一度お試しください。';
    case 'noPending':
      return 'この画面で始めた接続ではないため、中断しました。もう一度「GitHubに接続」から始めてください。';
    case 'expired':
      return '接続の手続きに時間がかかり、期限が切れました。もう一度接続してください。';
    case 'stateMismatch':
      return '接続の確認に失敗しました（state が一致しません）。安全のため中断しました。';
    case 'invalid':
      return 'GitHub からの戻り値が読めませんでした。もう一度接続してください。';
  }
}

/**
 * 交換エンドポイントの失敗の本文から、理由コード（`origin_not_allowed` など）を読む。
 * 公開の識別子だけを通し、形の違うものは読まない（画面にそのまま出すため）。
 */
export function parseExchangeErrorCode(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const { error } = value;
  return typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : null;
}

/**
 * トークン交換の失敗を、利用者に出す文言にする。
 *
 * 理由コードを添えるのは、利用者から運用者へそのまま伝えてもらうため。状態コードだけだと、
 * 403 が「許可リストの取り違え」なのか「別のサイトからの送信」なのか切り分けられない。
 * 429 は Vercel Firewall のレート制限。作業データは消えていないことも伝える。
 */
export function describeTokenExchangeFailure(status: number, reason: string | null = null): string {
  if (status === 429) {
    return 'GitHub への接続が短時間に続いたため、一時的に制限されています。少し時間をおいてから、もう一度接続してください（作業データはそのまま残っています）。';
  }
  const detail = reason ? `${status} ${reason}` : String(status);
  return `GitHub との接続に失敗しました（トークンの交換に失敗: ${detail}）。もう一度接続してください。`;
}

/** ブラウザがメモリにだけ持つアクセストークン。 */
export interface GitHubToken {
  accessToken: string;
  /**
   * 失効時刻（ミリ秒）。期限付きのトークンしか受け付けないので、必ずある
   * （`parseTokenResponse` を参照）。
   */
  expiresAt: number;
}

/**
 * 受け付けるトークンの有効期限（秒）の上限。Function（`MAX_TOKEN_LIFETIME_SECONDS`）と同じ値。
 * GitHub App のユーザートークンは現在 8 時間固定で、変更に少し余裕を持たせて 1 日までにする。
 * 巨大な値を通すとミリ秒に直した時点で `Infinity` になり、実質無期限になってしまう。
 */
export const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * 交換エンドポイントの応答を検証する。
 *
 * refresh token は Function 側で捨てているので、ここでも読まない
 * （紛れ込んでもメモリにすら載せない）。
 *
 * 有効期限（`expires_in`）の無い応答は受け付けない。期限付きのユーザートークンを使うのが
 * 前提で、GitHub App の設定でトークンの期限切れがオフにされると `expires_in` が返らなくなる。
 * そのとき「期限なし」として使い続けると、設定の取り違えで安全側の前提が黙って外れる。
 * Function でも同じ確認（bearer・期限の範囲）をしているが、ここでも重ねて確かめる。
 */
export function parseTokenResponse(value: unknown, now: number): GitHubToken | null {
  if (!isRecord(value)) return null;
  const { access_token: accessToken, expires_in: expiresIn, token_type: tokenType } = value;
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  // Function と同じ契約を重ねて確かめる（bearer・正の整数・上限以内の期限）。
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') return null;
  if (
    typeof expiresIn !== 'number' ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    return null;
  }
  const expiresAt = now + expiresIn * 1000;
  return Number.isFinite(expiresAt) ? { accessToken, expiresAt } : null;
}

/**
 * 失効が近いトークンは使わない。
 *
 * 期限ぎりぎりで送ると、途中で 401 になって一連の取得が半端に終わる。
 * 余裕を見て、先に接続し直してもらう。
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

export function isTokenUsable(token: GitHubToken, now: number): boolean {
  return now < token.expiresAt - TOKEN_EXPIRY_MARGIN_MS;
}
