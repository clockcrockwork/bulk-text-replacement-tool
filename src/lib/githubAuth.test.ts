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
  MAX_TOKEN_LIFETIME_SECONDS,
  PENDING_AUTH_TTL_MS,
  type PendingAuth,
  parseExchangeErrorCode,
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

describe('トークン交換の失敗の知らせ', () => {
  it('理由コードは公開の識別子の形だけを読む', () => {
    expect(parseExchangeErrorCode({ error: 'origin_not_allowed' })).toBe('origin_not_allowed');
    expect(parseExchangeErrorCode({ error: '<script>' })).toBeNull();
    expect(parseExchangeErrorCode({ error: 'x'.repeat(41) })).toBeNull();
    expect(parseExchangeErrorCode({ error: 1 })).toBeNull();
    expect(parseExchangeErrorCode(null)).toBeNull();
  });

  it('状態コードに理由コードを添える（利用者から運用者へそのまま伝えられる）', () => {
    expect(describeTokenExchangeFailure(403, 'origin_not_allowed')).toContain(
      '403 origin_not_allowed',
    );
    expect(describeTokenExchangeFailure(502)).toContain('（トークンの交換に失敗: 502）');
  });

  it('429 は一時的な制限として、待ってから接続し直すよう伝える', () => {
    const message = describeTokenExchangeFailure(429, 'rate_limited');
    expect(message).toContain('一時的に制限');
    expect(message).toContain('作業データはそのまま残っています');
  });
});

describe('トークン', () => {
  const VALID_TOKEN = { access_token: 'ghu_x', token_type: 'bearer', expires_in: 28800 };

  it('access_token と有効期限を読む', () => {
    expect(parseTokenResponse(VALID_TOKEN, 1000)).toEqual({
      accessToken: 'ghu_x',
      expiresAt: 1000 + 28_800_000,
    });
    // token_type の大文字小文字は問わない。上限ちょうどの期限は受け付ける。
    expect(parseTokenResponse({ ...VALID_TOKEN, token_type: 'Bearer' }, 0)).not.toBeNull();
    expect(
      parseTokenResponse({ ...VALID_TOKEN, expires_in: MAX_TOKEN_LIFETIME_SECONDS }, 0),
    ).not.toBeNull();
  });

  it.each([
    ['期限が無い', { expires_in: undefined }],
    ['期限が 0', { expires_in: 0 }],
    ['期限が負', { expires_in: -60 }],
    ['期限が文字列', { expires_in: '28800' }],
    ['期限が NaN', { expires_in: Number.NaN }],
    ['期限が Infinity', { expires_in: Number.POSITIVE_INFINITY }],
    ['期限が整数でない', { expires_in: 28800.5 }],
    ['期限が上限を超える', { expires_in: MAX_TOKEN_LIFETIME_SECONDS + 1 }],
    // 有限だが、ミリ秒に直すと Infinity になる値。通すと実質無期限になる。
    ['期限が有限だが巨大（Number.MAX_VALUE）', { expires_in: Number.MAX_VALUE }],
    ['期限が有限だが巨大（1e308）', { expires_in: 1e308 }],
    ['token_type が無い', { token_type: undefined }],
    ['token_type が bearer でない', { token_type: 'mac' }],
  ])('%s トークンは受け付けない（期限なし・想定外の応答として扱う）', (_, override) => {
    expect(parseTokenResponse({ ...VALID_TOKEN, ...override }, 0)).toBeNull();
  });

  it('計算した失効時刻が有限でなければ受け付けない', () => {
    expect(parseTokenResponse(VALID_TOKEN, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('refresh token が紛れ込んでも読まない', () => {
    const token = parseTokenResponse({ ...VALID_TOKEN, refresh_token: 'ghr_y' }, 0);
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
