import { expect, test } from '@playwright/test';
import { goToTab, openApp } from './fixtures';

/**
 * README で「入力したテキストとルールは外部へ送信しない」と約束しているので、
 * その不変条件をテストで固定する。解析ツール等が後から無意識に混ざるのも防げる。
 */
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', 'fonts.googleapis.com', 'fonts.gstatic.com'];

test('外部へ出る通信はフォントの配信元だけ', async ({ page }) => {
  const unexpected: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http')) return; // data: や blob: は外部通信ではない
    if (!ALLOWED_HOSTS.includes(new URL(url).hostname)) unexpected.push(url);
  });

  await openApp(page);
  // 入力・ルール・変換・出力まで一通り動かしてから判定する
  await goToTab(page, 'ルール');
  await goToTab(page, '入力');
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card__path')).toBeVisible();

  expect(unexpected, '許可していない宛先への通信').toEqual([]);
});
