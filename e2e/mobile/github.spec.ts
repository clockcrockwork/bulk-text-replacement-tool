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

test('スマホ幅でもフォルダをチェックして複数ファイルをまとめて取り込める', async ({ page }) => {
  const mock = new GitHubMock([novelRepository()]);
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);

  await page.getByRole('button', { name: 'GitHubから追加' }).tap();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).tap();
  await dialog(page).getByRole('button', { name: 'octo/novel' }).tap();

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  const tapTarget = chapters.locator('..');
  const size = await tapTarget.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);

  // iOS Safari はフォーカスした入力欄の文字が 16px 未満だと自動で拡大する。
  const filterSize = await dialog(page)
    .getByRole('searchbox', { name: 'このフォルダを絞り込み' })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(filterSize).toBeGreaterThanOrEqual(16);

  await chapters.tap();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).tap();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan.getByRole('heading', { name: '2ファイルが見つかりました' })).toBeVisible();
  await expectFitsWidth(page);
  await plan.getByRole('button', { name: '2ファイルを取得' }).tap();
  await expectFitsWidth(page);

  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch).toContainText('chapters/ch1.md');
  await expect(batch).toContainText('chapters/ch2.txt');
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).tap();

  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__source')).toHaveText([
    /chapters\/ch1\.md/,
    /chapters\/ch2\.txt/,
  ]);
});
