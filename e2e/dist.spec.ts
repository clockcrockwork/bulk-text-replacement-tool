import { expect, test } from '@playwright/test';

/**
 * 配信される本番ビルドそのものを見る。
 *
 * ここで守るのは「アプリの配信物には不要なものを載せない」という一点で、
 * ユーザーが扱うテキスト（原稿・ルール・変換結果）には一切適用しない境界がある。
 * そちらは改行も空白もコードポイントの差も意味を持つので、詰めたり正規化したりしない。
 */
test('配信する HTML に開発者向けのコメントを残さない', async ({ request, baseURL }) => {
  const html = await (await request.get(baseURL ?? '/')).text();
  expect(html).not.toContain('<!--');
});

test('本番ビルドに sourcemap を配らない', async ({ page, baseURL }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto(baseURL ?? '/');
  await page.waitForSelector('.brand__name');

  expect(requested.filter((url) => url.endsWith('.map'))).toEqual([]);

  // 参照コメント（//# sourceMappingURL=）も残さない。
  const scripts = requested.filter((url) => url.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const url of scripts) {
    const body = await (await page.request.get(url)).text();
    expect(body).not.toContain('sourceMappingURL');
  }
});

/**
 * 配信時のセキュリティヘッダ。値の正本は vercel.json で、`vite preview` も同じ値を返す
 * （vite.config.ts）。E2E 全体がこのヘッダの下で動くので、OAuth の戻りや描画を壊す
 * ヘッダを足せばほかの spec が落ちる。ここでは中身そのものを確かめる。
 * `source` のパス条件（`/api/` の除外）は preview では再現しないので、Preview / 本番で確かめる
 * （docs/github-app-setup.md §5）。
 */
test('配信する HTML にフレーム埋め込み禁止・nosniff・Referrer-Policy・COOP を付ける', async ({
  request,
  baseURL,
}) => {
  const response = await request.get(baseURL ?? '/');
  const headers = response.headers();
  expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin');
  // 他サイトが window.open で開いたときに、このページへのウィンドウ参照を持たせない。
  // OAuth の往復（github.com へ移って戻る）でブラウジングコンテキストグループが切り替わっても
  // sessionStorage の state と verifier が残ることは、github.spec.ts がこのヘッダの下で確かめる。
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  // 使っていない強い機能は閉じておく（多層防御）。クリップボードはコピーで使うので閉じない。
  const permissions = headers['permissions-policy'] ?? '';
  for (const feature of [
    'camera',
    'microphone',
    'geolocation',
    'payment',
    'usb',
    'display-capture',
  ]) {
    expect(permissions).toContain(`${feature}=()`);
  }
  expect(permissions).not.toContain('clipboard');

  // ヘッダを無視する配信先でも Referer を絞れるよう、HTML 側にも同じ方針を書く。
  // connect-src などの本体の CSP は meta 側にあり、ヘッダの CSP は frame-ancestors だけ
  // （meta の CSP では frame-ancestors を指定できないため）。
  const html = await response.text();
  expect(html).toContain('<meta name="referrer" content="strict-origin" />');
  expect(html).toContain("connect-src 'self' https://api.github.com;");
});
