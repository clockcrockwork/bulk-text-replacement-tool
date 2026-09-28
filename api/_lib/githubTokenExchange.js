/**
 * GitHub App の認可コードをアクセストークンに交換する。Vercel Function の本体。
 *
 * バックエンドが受け持つのは**この交換だけ**。client secret をブラウザに置けないために
 * ここを通す。原稿・ルール・変換結果・リポジトリの内容は受け取らないし、受け取る口も
 * 作らない（本文の取得はブラウザから api.github.com へ直接行う）。
 *
 * 守ること:
 * - POST だけを受け付け、Origin と redirect_uri を**完全一致の許可リスト**で確かめる。
 *   ブラウザから来た任意の redirect_uri を GitHub へ素通ししない
 * - refresh token は GitHub が返してもここで捨て、ブラウザへ返さない
 * - 応答は `Cache-Control: no-store`
 * - コード・verifier・トークン・GitHub の生の応答をログに出さない
 *
 * 回数の制限はここでは持たない。Origin はブラウザ以外からなら偽れるので、大量の送信は
 * Vercel Firewall のレート制限ルールで Function に届く前に止める
 * （`docs/github-app-setup.md` §3）。メモリ上のカウンタは、サーバーレスでは
 * インスタンス間で共有されず起動のたびに消えるので、制限として機能しない。
 *
 * TypeScript ではなく JSDoc 付きの JavaScript で書いている。このリポジトリの
 * TypeScript は 7（ネイティブ実装）で、従来の JS API（transpileModule など）を持たない。
 * Vercel の Node ランタイムが Function の .ts をプロジェクトの typescript で変換しようと
 * すると配信時に壊れ得るので、変換の要らない形にしておく。型は `tsc`（checkJs）で検査する。
 */

/** GitHub の token エンドポイント。 */
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** 受け付ける本文の上限。3つの短い文字列しか来ないので、大きなものは読まずに断る。 */
export const MAX_BODY_BYTES = 4096;

/**
 * 受け付けるトークンの有効期限（秒）の上限。GitHub App のユーザートークンは現在 8 時間
 * （28800）固定。GitHub 側の変更に少し余裕を持たせて 1 日までにし、それより長いものは
 * 想定外の応答として断る。巨大な値を通すと、ブラウザでミリ秒に直した時点で `Infinity` になり、
 * 「期限は必須」にしたのに実質無期限のトークンとして扱われてしまう。
 */
export const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

/** GitHub の応答を待つ上限。 */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} ExchangeConfig
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {ReadonlySet<string>} allowedOrigins 受け付ける Origin（`https://example.com` の形）。
 * @property {ReadonlySet<string>} redirectUris GitHub App に登録した callback URL と完全一致させる。
 */

/**
 * カンマ区切りの環境変数を集合にする。空要素は捨てる。
 * @param {string | undefined} value
 * @returns {Set<string>}
 */
function splitList(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * 環境変数から設定を読む。どれかが欠けていれば null（交換を断る）。
 *
 * Client ID はブラウザにも要る公開値なので、ビルド時の `VITE_GITHUB_APP_CLIENT_ID` を
 * そのまま読む（同じ値を2か所で管理しない）。secret と許可リストはこの Function 専用。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {ExchangeConfig | null}
 */
export function readExchangeConfig(env) {
  const clientId = env.VITE_GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const allowedOrigins = splitList(env.GITHUB_OAUTH_ALLOWED_ORIGINS);
  const redirectUris = splitList(env.GITHUB_OAUTH_REDIRECT_URIS);
  if (!clientId || !clientSecret || allowedOrigins.size === 0 || redirectUris.size === 0) {
    return null;
  }
  return { clientId, clientSecret, allowedOrigins, redirectUris };
}

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...extra },
  });
}

/**
 * 失敗は種類だけを返す。GitHub の生の応答やエラー文は返さない。
 * @param {number} status
 * @param {string} error
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function fail(status, error, extra = {}) {
  return json(status, { error }, extra);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 7636: 43〜128 文字の unreserved 文字。 */
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
/** GitHub の認可コード。形を決め打ちしすぎないが、制御文字や区切りは通さない。 */
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/;

/** 本文に置いてよいキー。交換に要る3つだけで、それ以外があれば断る。 */
const ALLOWED_BODY_KEYS = new Set(['code', 'code_verifier', 'redirect_uri']);

/**
 * 本文を上限まで読む。
 *
 * Content-Length があれば読む前に断る。無い（chunked など）ときも、`request.text()` で
 * 全部を受け取ってから測るのではなく、読みながら数えて上限を超えた時点で打ち切る。
 * 「大きなものは読まずに断る」をこの関数自身が保証する（配信基盤の上限に頼らない）。
 *
 * @param {Request} request
 * @returns {Promise<string | null>} 上限を超えていれば null。
 */
async function readBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      // 残りは受け取らない。取り消しの失敗は応答に関係しないので無視する。
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * redirect_uri のオリジン。URL として読めなければ null。
 * @param {string} value
 * @returns {string | null}
 */
function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * 交換リクエストを処理する。`fetchImpl` は GitHub への送信（テストで差し替える）。
 *
 * @param {Request} request
 * @param {ExchangeConfig | null} config
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Response>}
 */
export async function handleTokenExchange(request, config, fetchImpl) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', { Allow: 'POST' });
  if (!config) return fail(503, 'not_configured');

  // 許可したオリジンのページからだけ受け付ける。ブラウザは Origin を偽れない。
  const origin = request.headers.get('origin');
  if (!origin || !config.allowedOrigins.has(origin)) return fail(403, 'origin_not_allowed');

  // `application/json` そのもの（後ろにパラメータが付くのは可）だけを受け付ける。前方一致だと
  // `application/jsonx` のような別の型も通ってしまう。
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(?:;|$)/i.test(contentType)) {
    return fail(415, 'unsupported_media_type');
  }

  const raw = await readBody(request);
  if (raw === null) return fail(413, 'payload_too_large');

  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'invalid_json');
  }
  if (!isRecord(body)) return fail(400, 'invalid_request');
  // 受け取るのは交換に要る3項目だけ。余計な項目（原稿など）を黙って受け流さず、
  // 「バックエンドは3項目しか受け取らない」をこちら側でも強制する。
  if (Object.keys(body).some((key) => !ALLOWED_BODY_KEYS.has(key))) {
    return fail(400, 'invalid_request');
  }

  const { code, code_verifier: verifier, redirect_uri: redirectUri } = body;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return fail(400, 'invalid_request');
  if (typeof verifier !== 'string' || !VERIFIER_PATTERN.test(verifier)) {
    return fail(400, 'invalid_request');
  }
  // redirect_uri は許可リストとの完全一致に加えて、送ってきたページと同じオリジンであること。
  // 別の許可済みオリジン宛ての値をすり替えて使わせない。
  if (
    typeof redirectUri !== 'string' ||
    !config.redirectUris.has(redirectUri) ||
    originOf(redirectUri) !== origin
  ) {
    return fail(400, 'redirect_uri_not_allowed');
  }

  /** @type {Response} */
  let upstream;
  try {
    upstream = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // 例外の中身に送信内容が載り得るので、ログには種類だけを出す。
    console.error('github token exchange: upstream unreachable');
    return fail(502, 'upstream_unreachable');
  }

  /** @type {unknown} */
  let payload;
  try {
    payload = await upstream.json();
  } catch {
    console.error(`github token exchange: unreadable upstream response (${upstream.status})`);
    return fail(502, 'upstream_invalid');
  }

  if (!upstream.ok || !isRecord(payload)) {
    console.error(`github token exchange: upstream status ${upstream.status}`);
    return fail(502, 'upstream_error');
  }

  // GitHub は失敗でも 200 と `error` を返す（期限切れのコード・verifier の不一致など）。
  if (typeof payload.error === 'string') {
    return fail(400, 'exchange_rejected');
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    return fail(502, 'upstream_invalid');
  }

  // 期限付きのユーザートークンだけを通す。GitHub App の「Expire user authorization tokens」を
  // 切ると `expires_in` そのものが返らなくなる。設定の取り違えで、期限の無いトークンを
  // 黙って「期限情報なし」として配らない（ブラウザはそれを無期限として使い続けてしまう）。
  // 期限は正の整数（秒）で、上限（MAX_TOKEN_LIFETIME_SECONDS）以内であること。
  const expiresIn = payload.expires_in;
  if (
    typeof expiresIn !== 'number' ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    console.error('github token exchange: upstream token has no valid expiry');
    return fail(502, 'upstream_invalid');
  }
  // GitHub のユーザートークンは bearer。違う種類が返ったら、想定外の応答として扱う。
  if (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer') {
    return fail(502, 'upstream_invalid');
  }

  // 返すのはブラウザが使う分だけ。refresh_token と refresh_token_expires_in は捨てる。
  return json(200, { access_token: accessToken, token_type: 'bearer', expires_in: expiresIn });
}
