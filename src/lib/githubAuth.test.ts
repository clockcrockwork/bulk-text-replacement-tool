import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  callbackUrl,
  codeChallengeS256,
  describeCallbackFailure,
  installationUrl,
  isTokenUsable,
  PENDING_AUTH_TTL_MS,
  type PendingAuth,
  parsePendingAuth,
  parseTokenResponse,
  readCallbackParams,
  readGitHubAppConfig,
  serializePendingAuth,
  stripCallbackParams,
  TOKEN_EXPIRY_MARGIN_MS,
  validateCallback,
} from './githubAuth';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PENDING: PendingAuth = { state: 'state-abc', verifier: VERIFIER, createdAt: 1_000_000 };

describe('readGitHubAppConfig', () => {
  it('Client ID と slug が揃っていれば設定として読む', () => {
    expect(
      readGitHubAppConfig({
        VITE_GITHUB_APP_CLIENT_ID: ' Iv23abc ',
        VITE_GITHUB_APP_SLUG: 'bulk-replace',
      }),
    ).toEqual({ clientId: 'Iv23abc', slug: 'bulk-replace' });
  });

  it('どちらかが無い・空なら連携を無効にする', () => {
    expect(readGitHubAppConfig({})).toBeNull();
    expect(readGitHubAppConfig({ VITE_GITHUB_APP_CLIENT_ID: 'x' })).toBeNull();
    expect(
      readGitHubAppConfig({ VITE_GITHUB_APP_CLIENT_ID: '', VITE_GITHUB_APP_SLUG: 'a' }),
    ).toBeNull();
  });

  it('URL を壊す slug は受け付けない', () => {
    expect(
      readGitHubAppConfig({ VITE_GITHUB_APP_CLIENT_ID: 'x', VITE_GITHUB_APP_SLUG: '../evil' }),
    ).toBeNull();
  });
});

describe('URL', () => {
  it('インストール画面は App の slug から作る', () => {
    expect(installationUrl({ clientId: 'x', slug: 'bulk-replace' })).toBe(
      'https://github.com/apps/bulk-replace/installations/new',
    );
  });

  it('コールバックはオリジン直下', () => {
    expect(callbackUrl('https://example.com')).toBe('https://example.com/');
  });

  it('認可 URL に state・PKCE（S256）・完全な redirect_uri を載せる', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'Iv23abc',
        redirectUri: 'https://example.com/',
        state: 'st',
        codeChallenge: 'ch',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv23abc',
      redirect_uri: 'https://example.com/',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });
});

describe('PKCE', () => {
  it('base64url はパディングを付けず、+ / を - _ にする', () => {
    expect(base64UrlEncode(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(base64UrlEncode(new Uint8Array([1]))).toBe('AQ');
  });

  it('RFC 7636 付録 B の値と一致する', async () => {
    expect(await codeChallengeS256(VERIFIER, crypto.subtle)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('一時情報（state / verifier）', () => {
  it('書いたものを読み戻せる', () => {
    expect(parsePendingAuth(serializePendingAuth(PENDING))).toEqual(PENDING);
  });

  it('無い・壊れている・形が違うものは使わない', () => {
    expect(parsePendingAuth(null)).toBeNull();
    expect(parsePendingAuth('{')).toBeNull();
    expect(parsePendingAuth('[]')).toBeNull();
    expect(parsePendingAuth(JSON.stringify({ ...PENDING, state: '' }))).toBeNull();
    expect(parsePendingAuth(JSON.stringify({ ...PENDING, verifier: 'short' }))).toBeNull();
    expect(parsePendingAuth(JSON.stringify({ ...PENDING, createdAt: 'now' }))).toBeNull();
  });
});

describe('コールバック', () => {
  it('code も error も無ければ戻りではない', () => {
    expect(readCallbackParams('')).toEqual({ kind: 'none' });
    expect(readCallbackParams('?state=x')).toEqual({ kind: 'none' });
  });

  it('code か error があれば戻りとして読む', () => {
    expect(readCallbackParams('?code=abc&state=s')).toEqual({
      kind: 'callback',
      code: 'abc',
      state: 's',
      error: null,
    });
    expect(readCallbackParams('?error=access_denied&state=s')).toMatchObject({
      kind: 'callback',
      error: 'access_denied',
    });
  });

  it('URL から認可の戻りだけを取り除き、ほかのクエリとハッシュは残す', () => {
    expect(
      stripCallbackParams(
        'https://example.com/?code=abc&state=s&keep=1&error=x&error_description=y&error_uri=z#h',
      ),
    ).toBe('https://example.com/?keep=1#h');
    expect(stripCallbackParams('https://example.com/?code=abc&state=s')).toBe(
      'https://example.com/',
    );
  });

  const callback = (overrides: Partial<{ code: string | null; state: string | null }> = {}) => ({
    kind: 'callback' as const,
    code: 'abc123',
    state: PENDING.state,
    error: null,
    ...overrides,
  });

  it('state が一致すれば code と verifier を返す', () => {
    expect(validateCallback(callback(), PENDING, PENDING.createdAt + 1000)).toEqual({
      kind: 'ok',
      code: 'abc123',
      verifier: VERIFIER,
    });
  });

  it('state が一致しなければ交換に回さない（login CSRF）', () => {
    expect(validateCallback(callback({ state: 'other' }), PENDING, PENDING.createdAt)).toEqual({
      kind: 'error',
      reason: 'stateMismatch',
    });
    expect(validateCallback(callback({ state: null }), PENDING, PENDING.createdAt)).toEqual({
      kind: 'error',
      reason: 'stateMismatch',
    });
  });

  it('このタブで始めた認可が無ければ中断する', () => {
    expect(validateCallback(callback(), null, 0)).toEqual({ kind: 'error', reason: 'noPending' });
  });

  it('古い一時情報は使わない', () => {
    expect(
      validateCallback(callback(), PENDING, PENDING.createdAt + PENDING_AUTH_TTL_MS + 1),
    ).toEqual({ kind: 'error', reason: 'expired' });
    // 時計が戻った場合も信用しない。
    expect(validateCallback(callback(), PENDING, PENDING.createdAt - 1)).toEqual({
      kind: 'error',
      reason: 'expired',
    });
  });

  it('利用者が拒否した戻りは denied', () => {
    expect(
      validateCallback(
        { kind: 'callback', code: null, state: PENDING.state, error: 'access_denied' },
        PENDING,
        PENDING.createdAt,
      ),
    ).toEqual({ kind: 'error', reason: 'denied' });
  });

  it('code の形が変なら交換しない', () => {
    expect(validateCallback(callback({ code: '' }), PENDING, PENDING.createdAt)).toEqual({
      kind: 'error',
      reason: 'invalid',
    });
    expect(validateCallback(callback({ code: 'a b' }), PENDING, PENDING.createdAt)).toEqual({
      kind: 'error',
      reason: 'invalid',
    });
  });

  it('失敗の理由ごとに説明がある', () => {
    for (const reason of ['denied', 'noPending', 'expired', 'stateMismatch', 'invalid'] as const) {
      expect(describeCallbackFailure(reason)).not.toBe('');
    }
    expect(describeCallbackFailure('stateMismatch')).toContain('state');
  });
});

describe('トークン', () => {
  it('access_token と有効期限を読む', () => {
    expect(parseTokenResponse({ access_token: 'ghu_x', expires_in: 28800 }, 1000)).toEqual({
      accessToken: 'ghu_x',
      expiresAt: 1000 + 28_800_000,
    });
  });

  it('有効期限の無い・壊れたトークンは受け付けない（期限なしとして使い続けない）', () => {
    expect(parseTokenResponse({ access_token: 'ghu_x' }, 0)).toBeNull();
    expect(parseTokenResponse({ access_token: 'ghu_x', expires_in: 0 }, 0)).toBeNull();
    expect(parseTokenResponse({ access_token: 'ghu_x', expires_in: -60 }, 0)).toBeNull();
    expect(parseTokenResponse({ access_token: 'ghu_x', expires_in: '28800' }, 0)).toBeNull();
    expect(parseTokenResponse({ access_token: 'ghu_x', expires_in: Number.NaN }, 0)).toBeNull();
    expect(
      parseTokenResponse({ access_token: 'ghu_x', expires_in: Number.POSITIVE_INFINITY }, 0),
    ).toBeNull();
  });

  it('refresh token が紛れ込んでも読まない', () => {
    const token = parseTokenResponse(
      { access_token: 'ghu_x', expires_in: 28800, refresh_token: 'ghr_y' },
      0,
    );
    expect(token).not.toBeNull();
    expect(JSON.stringify(token)).not.toContain('ghr_y');
  });

  it('形が違えば null', () => {
    expect(parseTokenResponse(null, 0)).toBeNull();
    expect(parseTokenResponse({ access_token: '' }, 0)).toBeNull();
    expect(parseTokenResponse({ error: 'bad' }, 0)).toBeNull();
  });

  it('失効の少し前から使わない', () => {
    const token = { accessToken: 'x', expiresAt: 100_000 };
    expect(isTokenUsable(token, 100_000 - TOKEN_EXPIRY_MARGIN_MS - 1)).toBe(true);
    expect(isTokenUsable(token, 100_000 - TOKEN_EXPIRY_MARGIN_MS)).toBe(false);
  });
});
