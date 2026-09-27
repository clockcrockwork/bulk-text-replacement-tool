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
