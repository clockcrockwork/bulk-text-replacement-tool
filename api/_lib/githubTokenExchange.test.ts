import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_API_VERSION,
  GITHUB_TOKEN_URL,
  handleTokenExchange,
  MAX_BODY_BYTES,
  readExchangeConfig,
} from './githubTokenExchange.js';

const ORIGIN = 'https://bulk.example';
const REDIRECT = `${ORIGIN}/`;
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const CONFIG = {
  clientId: 'Iv23client',
  clientSecret: 'secret-value',
  allowedOrigins: new Set([ORIGIN, 'https://other.example']),
  redirectUris: new Set([REDIRECT, 'https://other.example/']),
};

function request(
  body: unknown,
  init: { method?: string; origin?: string | null; contentType?: string } = {},
): Request {
  const headers = new Headers();
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  headers.set('content-type', init.contentType ?? 'application/json');
  const method = init.method ?? 'POST';
  return new Request('https://bulk.example/api/github/token', {
    method,
    headers,
    body: method === 'GET' ? null : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { code: 'abc123', code_verifier: VERIFIER, redirect_uri: REDIRECT };

/** GitHub の token エンドポイントの代わり。受け取った内容を記録する。 */
function upstream(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), {
      status,
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

async function body(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

afterEach(() => vi.restoreAllMocks());

describe('readExchangeConfig', () => {
  it('環境変数から設定を読む', () => {
    expect(
      readExchangeConfig({
        VITE_GITHUB_APP_CLIENT_ID: ' Iv23client ',
        GITHUB_APP_CLIENT_SECRET: 'secret',
        GITHUB_OAUTH_ALLOWED_ORIGINS: `${ORIGIN}, https://other.example ,`,
        GITHUB_OAUTH_REDIRECT_URIS: REDIRECT,
      }),
    ).toEqual({
      clientId: 'Iv23client',
      clientSecret: 'secret',
      allowedOrigins: new Set([ORIGIN, 'https://other.example']),
      redirectUris: new Set([REDIRECT]),
    });
  });

  it('どれかが欠けていれば null', () => {
    const full = {
      VITE_GITHUB_APP_CLIENT_ID: 'id',
      GITHUB_APP_CLIENT_SECRET: 'secret',
      GITHUB_OAUTH_ALLOWED_ORIGINS: ORIGIN,
      GITHUB_OAUTH_REDIRECT_URIS: REDIRECT,
    };
    for (const key of Object.keys(full)) {
      expect(readExchangeConfig({ ...full, [key]: ' ' })).toBeNull();
    }
    expect(readExchangeConfig({})).toBeNull();
  });
});

describe('handleTokenExchange', () => {
  it('コードを交換し、アクセストークンと期限だけを返す（refresh token は捨てる）', async () => {
    const { fetchImpl, calls } = upstream({
      access_token: 'ghu_access',
      expires_in: 28800,
      refresh_token: 'ghr_refresh',
      refresh_token_expires_in: 15897600,
      token_type: 'bearer',
      scope: '',
    });
    const response = await handleTokenExchange(request(VALID), CONFIG, fetchImpl);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      access_token: 'ghu_access',
      token_type: 'bearer',
      expires_in: 28800,
    });
    expect(text).not.toContain('ghr_refresh');

    // GitHub へは secret・PKCE verifier・完全一致の redirect_uri を送る。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GITHUB_TOKEN_URL);
    const sent = new URLSearchParams(String(calls[0]?.init?.body));
    expect(Object.fromEntries(sent)).toEqual({
      client_id: 'Iv23client',
      client_secret: 'secret-value',
      code: 'abc123',
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(new Headers(calls[0]?.init?.headers).get('x-github-api-version')).toBe(
      GITHUB_API_VERSION,
    );
  });

  it('有効期限が返らなければ付けない', async () => {
    const { fetchImpl } = upstream({ access_token: 'ghu_access' });
    const response = await handleTokenExchange(request(VALID), CONFIG, fetchImpl);
    expect(await body(response)).toEqual({ access_token: 'ghu_access', token_type: 'bearer' });
  });

  it('POST 以外は 405', async () => {
    const { fetchImpl, calls } = upstream({});
    const response = await handleTokenExchange(request(null, { method: 'GET' }), CONFIG, fetchImpl);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(calls).toHaveLength(0);
  });

  it('設定が無ければ交換しない', async () => {
    const { fetchImpl, calls } = upstream({});
    const response = await handleTokenExchange(request(VALID), null, fetchImpl);
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('許可していないオリジン・Origin 無しは 403', async () => {
    const { fetchImpl, calls } = upstream({});
    for (const origin of ['https://evil.example', null]) {
      const response = await handleTokenExchange(request(VALID, { origin }), CONFIG, fetchImpl);
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({ error: 'origin_not_allowed' });
    }
    expect(calls).toHaveLength(0);
  });

  it('JSON 以外は 415', async () => {
    const { fetchImpl } = upstream({});
    const response = await handleTokenExchange(
      request('code=abc', { contentType: 'application/x-www-form-urlencoded' }),
      CONFIG,
      fetchImpl,
    );
    expect(response.status).toBe(415);
  });

  it('大きすぎる本文は読まずに断る（原稿などを受け取る口にしない）', async () => {
    const { fetchImpl, calls } = upstream({});
    const response = await handleTokenExchange(
      request({ ...VALID, manuscript: 'x'.repeat(MAX_BODY_BYTES) }),
      CONFIG,
      fetchImpl,
    );
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['JSON として壊れている', '{', 'invalid_json'],
    ['配列', [], 'invalid_request'],
    ['code が無い', { ...VALID, code: undefined }, 'invalid_request'],
    ['code に区切り文字', { ...VALID, code: 'a&b' }, 'invalid_request'],
    ['verifier が短い', { ...VALID, code_verifier: 'short' }, 'invalid_request'],
  ])('%s なら 400', async (_, payload, error) => {
    const { fetchImpl, calls } = upstream({});
    const response = await handleTokenExchange(request(payload), CONFIG, fetchImpl);
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['許可リストに無い', 'https://evil.example/'],
    ['パスだけ違う', `${ORIGIN}/callback`],
    ['許可済みだが別のオリジン宛て', 'https://other.example/'],
    ['文字列でない', 42],
  ])('redirect_uri が %s なら GitHub へ渡さない', async (_, redirectUri) => {
    const { fetchImpl, calls } = upstream({});
    const response = await handleTokenExchange(
      request({ ...VALID, redirect_uri: redirectUri }),
      CONFIG,
      fetchImpl,
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: 'redirect_uri_not_allowed' });
    expect(calls).toHaveLength(0);
  });

  it('許可リストの値が URL として壊れていても落ちない', async () => {
    const { fetchImpl } = upstream({});
    const config = { ...CONFIG, redirectUris: new Set(['not a url']) };
    const response = await handleTokenExchange(
      request({ ...VALID, redirect_uri: 'not a url' }),
      config,
      fetchImpl,
    );
    expect(response.status).toBe(400);
  });

  it('GitHub が拒否したら種類だけを返し、生の応答は返さない', async () => {
    const { fetchImpl } = upstream({
      error: 'bad_verification_code',
      error_description: 'The code passed is incorrect or expired.',
    });
    const response = await handleTokenExchange(request(VALID), CONFIG, fetchImpl);
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: 'exchange_rejected' });
  });

  describe('GitHub 側の失敗', () => {
    it('届かなければ 502。ログに送信内容を出さない', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fetchImpl = vi.fn(async () => {
        throw new Error(`failed with code=abc123 verifier=${VERIFIER}`);
      }) as unknown as typeof fetch;
      const response = await handleTokenExchange(request(VALID), CONFIG, fetchImpl);
      expect(response.status).toBe(502);
      const logged = JSON.stringify(log.mock.calls);
      for (const secret of ['abc123', VERIFIER, 'secret-value']) {
        expect(logged).not.toContain(secret);
      }
    });

    it('読めない応答・エラー応答・トークンの無い応答は 502', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const cases = [
        upstream('<html>', 200),
        upstream({ message: 'boom' }, 500),
        upstream([], 200),
        upstream({ token_type: 'bearer' }, 200),
      ];
      for (const { fetchImpl } of cases) {
        const response = await handleTokenExchange(request(VALID), CONFIG, fetchImpl);
        expect(response.status).toBe(502);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    });
  });
});
