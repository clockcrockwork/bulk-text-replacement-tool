import { expect, type Page, test } from '@playwright/test';
import { makeRule, openApp, seedWorkspace } from '../fixtures';
import { GitHubMock, novelRepository } from '../githubMock';

/** スマホ幅で「GitHubから追加」をタップだけで最後まで進められること。 */

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'GitHubから追加' });
}

/** ダイアログが画面幅からはみ出していないか（横スクロールが出ないか）。 */
async function expectFitsWidth(page: Page): Promise<void> {
  const overflow = await dialog(page).evaluate((element) => ({
    dialog: element.getBoundingClientRect().right,
    viewport: window.innerWidth,
    scroll: element.scrollWidth - element.clientWidth,
  }));
  expect(overflow.dialog).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.scroll).toBeLessThanOrEqual(0);
}

test('スマホ幅でもタップで GitHub から1ファイル取り込める', async ({ page }) => {
  const mock = new GitHubMock([novelRepository()]);
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [makeRule('r1', 'アリス', { g1: 'あーちゃん' })],
  });
  await openApp(page);

  await page.getByRole('button', { name: 'GitHubから追加' }).tap();
  await expectFitsWidth(page);
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).tap();
  await dialog(page).getByRole('button', { name: 'octo/novel' }).tap();
  await dialog(page)
    .getByRole('button', { name: /^chapters\// })
    .tap();
  await expectFitsWidth(page);

  // 一覧の1行はタッチの最小サイズ（44px）を確保する。
  const heights = await dialog(page)
    .locator('.github__entry')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);

  await dialog(page)
    .getByRole('button', { name: /^ch1\.md/ })
    .tap();
  // 本文の確認欄も iOS Safari の自動ズームを避ける大きさにする。
  const previewSize = await dialog(page)
    .getByRole('textbox', { name: '取り込む本文' })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(previewSize).toBeGreaterThanOrEqual(16);
  await expectFitsWidth(page);

  await dialog(page).getByRole('button', { name: '入力に追加' }).tap();
  await expect(page.locator('.input-card__source')).toContainText('chapters/ch1.md');
});
