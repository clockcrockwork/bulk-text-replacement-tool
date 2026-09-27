import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import {
  GITHUB_CORS_ALLOWED_REQUEST_HEADERS,
  GITHUB_CORS_EXPOSED_RESPONSE_HEADERS,
  GITHUB_FETCH_INIT,
  githubRequestHeaders,
} from '../src/lib/githubApi';

/**
 * ブラウザから api.github.com へ直接 fetch できる構成かを、実ブラウザの CORS で確かめる。
 *
 * ほかの GitHub の E2E は `page.route` でモックしており、ブラウザの CORS 判定（preflight で
 * 許可されない要求ヘッダ、公開されない応答ヘッダ）を通らない。ここでは GitHub の公式
 * ドキュメントにある preflight 応答どおりに振る舞う**本物の HTTP サーバー**を別オリジンに
 * 立て、アプリと同じヘッダ（`githubRequestHeaders`）と同じ fetch オプション
 * （`GITHUB_FETCH_INIT`）で通ることを見る。
 * https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests
 */

const ALLOW_HEADERS =
  'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, X-Requested-With';
const EXPOSE_HEADERS =
  'ETag, Link, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval';

/** API 役（GitHub の代わり）とページ役。ポートが違えば別オリジンになる。 */
let api: Server;
let site: Server;
let apiPort = 0;
let sitePort = 0;
/** preflight で要求されたヘッダ（Access-Control-Request-Headers）。 */
const preflights: string[] = [];

function servePage(_: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>cors</title>');
}

function handleApi(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'OPTIONS') {
    preflights.push(String(request.headers['access-control-request-headers'] ?? ''));
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': ALLOW_HEADERS,
      'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
      'access-control-expose-headers': EXPOSE_HEADERS,
      'access-control-max-age': '86400',
    });
    response.end();
    return;
  }
  response.writeHead(request.headers.authorization === 'Bearer t' ? 200 : 401, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': EXPOSE_HEADERS,
    link: '<https://api.github.com/x?page=2>; rel="next"',
    'x-ratelimit-remaining': '42',
    // GitHub は返すが CORS で公開していないヘッダ。ブラウザからは読めないはず。
    'retry-after': '30',
    'x-github-sso': 'required',
    'cache-control': 'private, max-age=60',
  });
  response.end('{"ok":true}');
}

/**
 * IPv4 に固定する。`localhost` はデュアルスタックの CI で `::1` に解決されることがあり
 * （playwright.config.ts の HOST と同じ理由）、つながらずに落ちる。
 */
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

test.beforeAll(async () => {
  ({ server: api, port: apiPort } = await listen(handleApi));
  ({ server: site, port: sitePort } = await listen(servePage));
});

test.afterAll(async () => {
  await Promise.all(
    [api, site].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

test.beforeEach(() => {
  preflights.length = 0;
});

/** 別オリジン（ポート違い）のページから、API 役のサーバーへ fetch する。 */
async function fetchFromOtherOrigin(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
) {
  await page.goto(`http://127.0.0.1:${sitePort}/`);
  return page.evaluate(
    async ({ url, headers, init }) => {
      try {
        const response = await fetch(url, { ...init, headers });
        return {
          ok: true,
          status: response.status,
          link: response.headers.get('link'),
          remaining: response.headers.get('x-ratelimit-remaining'),
          retryAfter: response.headers.get('retry-after'),
          sso: response.headers.get('x-github-sso'),
        };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    { url: `http://127.0.0.1:${apiPort}/user/installations`, headers, init: GITHUB_FETCH_INIT },
  );
}

test('アプリと同じヘッダとオプションなら、GitHub の CORS 方針のもとで直接 fetch できる', async ({
  page,
}) => {
  const result = await fetchFromOtherOrigin(
    page,
    githubRequestHeaders('t', 'application/vnd.github+json'),
  );
  expect(result).toMatchObject({ ok: true, status: 200 });

  // preflight で要求したのは許可リストにあるヘッダだけ（no-store が足すヘッダは含まれない）。
  expect(preflights.length).toBeGreaterThan(0);
  for (const requested of preflights) {
    for (const name of requested.split(',').map((item) => item.trim().toLowerCase())) {
      if (name) expect(GITHUB_CORS_ALLOWED_REQUEST_HEADERS).toContain(name);
    }
  }

  // 読める応答ヘッダと読めない応答ヘッダ。rate limit の判定が前者だけに頼る理由。
  expect(result).toMatchObject({
    link: '<https://api.github.com/x?page=2>; rel="next"',
    remaining: '42',
    retryAfter: null,
    sso: null,
  });
  expect(GITHUB_CORS_EXPOSED_RESPONSE_HEADERS).not.toContain('retry-after');
});

test('許可リストに無いヘッダ（X-GitHub-Api-Version）を付けると preflight で止まる', async ({
  page,
}) => {
  // このサーバーが GitHub の方針どおりに拒否することの確認（対照実験）。
  const result = await fetchFromOtherOrigin(page, {
    ...githubRequestHeaders('t', 'application/vnd.github+json'),
    'X-GitHub-Api-Version': '2026-03-10',
  });
  expect(result.ok).toBe(false);
});
