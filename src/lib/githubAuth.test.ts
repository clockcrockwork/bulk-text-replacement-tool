import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  callbackUrl,
  codeChallengeS256,
  describeCallbackFailure,
  describeTokenExchangeFailure,
  installationUrl,
  isTokenUsable,
  nonCanonicalTarget,
  normalizeCanonicalOrigin,
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
    ).toEqual({ clientId: 'Iv23abc', slug: 'bulk-replace', canonicalOrigin: null });
  });

  it('正規のオリジンがあれば、オリジンの形に揃えて持つ', () => {
    expect(
      readGitHubAppConfig({
        VITE_GITHUB_APP_CLIENT_ID: 'x',
        VITE_GITHUB_APP_SLUG: 'a',
        VITE_GITHUB_APP_ORIGIN: ' https://Bulk.Example.com/ ',
      }),
    ).toEqual({ clientId: 'x', slug: 'a', canonicalOrigin: 'https://bulk.example.com' });
    // 空は「固定しない」（未設定と同じ）。
    expect(
      readGitHubAppConfig({
        VITE_GITHUB_APP_CLIENT_ID: 'x',
        VITE_GITHUB_APP_SLUG: 'a',
        VITE_GITHUB_APP_ORIGIN: '  ',
      })?.canonicalOrigin,
    ).toBeNull();
  });

  it('正規のオリジンが読めない値なら、連携ごと無効にする', () => {
    for (const origin of ['bulk.example.com', 'https://bulk.example.com/app', 'ftp://x']) {
      expect(
        readGitHubAppConfig({
          VITE_GITHUB_APP_CLIENT_ID: 'x',
          VITE_GITHUB_APP_SLUG: 'a',
          VITE_GITHUB_APP_ORIGIN: origin,
        }),
      ).toBeNull();
    }
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
    expect(installationUrl({ clientId: 'x', slug: 'bulk-replace', canonicalOrigin: null })).toBe(
      'https://github.com/apps/bulk-replace/installations/new',
    );
  });

  it('正規のオリジンはオリジンそのものだけを受け付ける', () => {
    expect(normalizeCanonicalOrigin('https://bulk.example.com')).toBe('https://bulk.example.com');
    expect(normalizeCanonicalOrigin('https://bulk.example.com/')).toBe('https://bulk.example.com');
    expect(normalizeCanonicalOrigin('https://bulk.example.com:8443')).toBe(
      'https://bulk.example.com:8443',
    );
    // ローカルで確かめるための loopback だけ http を許す。
    expect(normalizeCanonicalOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
    expect(normalizeCanonicalOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
    for (const value of [
      'http://bulk.example.com',
      'https://bulk.example.com/sub/',
      'https://bulk.example.com/?x=1',
      'https://bulk.example.com/?',
      'https://bulk.example.com/#top',
      'https://user:pass@bulk.example.com',
      'bulk.example.com',
      'javascript:alert(1)',
      '',
    ]) {
      expect(normalizeCanonicalOrigin(value), value).toBeNull();
    }
  });

  it('正規でないオリジンでは、正規のオリジンの URL を返す', () => {
    const config = { clientId: 'x', slug: 'a', canonicalOrigin: 'https://bulk.example.com' };
    expect(nonCanonicalTarget(config, 'https://bulk.example.com')).toBeNull();
    expect(nonCanonicalTarget(config, 'https://bulk-git-main-team.vercel.app')).toBe(
      'https://bulk.example.com/',
    );
    // 固定していなければ、どのオリジンでも始められる。
    expect(nonCanonicalTarget({ ...config, canonicalOrigin: null }, 'http://x.test')).toBeNull();
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

  it('有効期限が無ければ null のまま', () => {
    expect(parseTokenResponse({ access_token: 'ghu_x' }, 0)).toEqual({
      accessToken: 'ghu_x',
      expiresAt: null,
    });
  });

  it('refresh token が紛れ込んでも読まない', () => {
    const token = parseTokenResponse({ access_token: 'ghu_x', refresh_token: 'ghr_y' }, 0);
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
    expect(isTokenUsable({ accessToken: 'x', expiresAt: null }, Number.MAX_SAFE_INTEGER)).toBe(
      true,
    );
  });
});

describe('describeTokenExchangeFailure', () => {
  it('429（Firewall のレート制限）は、待ってから接続し直せばよいと伝える', () => {
    const message = describeTokenExchangeFailure(429);
    expect(message).toContain('1分ほど待ってから');
    expect(message).toContain('もう一度接続');
    expect(message).not.toContain('429');
  });

  it('それ以外は状態コードを添えて失敗を伝える', () => {
    expect(describeTokenExchangeFailure(403)).toBe(
      'GitHub との接続に失敗しました（トークンの交換に失敗: 403）。もう一度接続してください。',
    );
  });
});
