import { expect, test } from '@playwright/test';
import { cell, goToTab, openApp } from './fixtures';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('初期表示ではサンプルの入力とルールが並ぶ', async ({ page }) => {
  await expect(page.locator('.input-card')).toHaveCount(1);
  await expect(page.locator('.input-card__title')).toHaveValue('chapter1.md');
  await goToTab(page, 'ルール');
  await expect(page.locator('.rule-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.rule-table__group-name').first()).toHaveValue('A用');
  await expect(page.locator('.rule-table__group-name').nth(1)).toHaveValue('B用');
});

test('変換するとグループごとの結果が置換箇所つきで出る', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();

  await expect(page.locator('.file-card__path')).toHaveText('A用/chapter1.md');
  await expect(page.locator('.file-card__body mark')).toHaveText([
    'あーちゃん',
    'びる',
    'びる',
    'あーちゃん',
    'あーちゃん',
  ]);

  // グループを切り替えると同じ入力の別バージョンが出る。
  await page.getByRole('button', { name: /^B用/ }).click();
  await expect(page.locator('.file-card__path')).toHaveText('B用/chapter1.md');
  await expect(page.locator('.file-card__body mark').first()).toHaveText('びーちゃん');
});

test('テキスト表示に切り替えると変換後の本文がそのまま読める', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  await expect(page.locator('.file-card__plain')).toContainText(
    'あーちゃんは川辺でびると並んで座っていた。',
  );
});

test('入力を変えると未反映バッジが出て、再変換で消える', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.tab__badge')).toHaveCount(0);

  await goToTab(page, 'ルール');
  await cell(page, 0, 1).fill('ありす');
  await expect(page.locator('.tab__badge')).toHaveCount(1);

  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.tab__badge')).toHaveCount(0);
  await expect(page.locator('.file-card__body mark').first()).toHaveText('ありす');
});

test('入力が無いまま変換すると入力タブへ戻される', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'すべて削除' }).click();
  await expect(page.locator('.empty')).toContainText('入力がありません');

  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.toast')).toHaveText('入力テキストがありません');
  await expect(page.locator('.tab.is-active')).toContainText('入力');
});

test('ZIPですべて保存するとグループ名のディレクトリを含むZIPが落ちてくる', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'ZIPですべて保存' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^converted-\d{8}-\d{4}\.zip$/);
  await expect(page.locator('.toast')).toHaveText('2ファイルをZIPで保存しました');
});

test('個別に保存すると1ファイルだけ落ちてくる', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'このファイルを保存' }).first().click(),
  ]);
  expect(download.suggestedFilename()).toBe('chapter1.md');
});

test('コピーを押すと変換後の本文がクリップボードに入る', async ({ page, context, browserName }) => {
  // WebKit にはクリップボードの権限 API が無い（読み出しの許可が出せない）。
  test.skip(browserName === 'webkit', 'WebKit ではクリップボードを読み出せない');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '変換' }).click();

  const body = await page.locator('.file-card__body').first().innerText();
  await page.getByRole('button', { name: 'コピー' }).first().click();
  await expect(page.locator('.toast')).toHaveText('コピーしました');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body);
});
