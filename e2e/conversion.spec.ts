import { expect, test } from '@playwright/test';
import { cell, goToTab, openApp, seedBasic } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedBasic(page);
  await openApp(page);
});

test('変換するとグループごとの結果が置換箇所つきで出る', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();

  await expect(page.locator('.file-card__path')).toHaveText('A用/story.md');
  await expect(page.locator('.file-card__body mark')).toHaveText([
    'あーちゃん',
    'びる',
    'あーちゃん',
  ]);

  // グループを切り替えると同じ入力の別バージョンが出る。
  await page.getByRole('button', { name: /^B用/ }).click();
  await expect(page.locator('.file-card__path')).toHaveText('B用/story.md');
  await expect(page.locator('.file-card__body mark').first()).toHaveText('びーちゃん');
});

test('テキスト表示に切り替えると変換後の本文がそのまま読める', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  await expect(page.locator('.file-card__plain')).toContainText('あーちゃんとびるが並ぶ。');
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
  await page.getByRole('button', { name: 'すべて削除' }).click();
  await page.getByRole('button', { name: 'すべて削除する' }).click();
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
  expect(download.suggestedFilename()).toBe('story.md');
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

test.describe('未反映の結果は持ち出せない', () => {
  test('入力やルールを変えると、コピー・保存・ZIPが無効になり再変換で戻る', async ({ page }) => {
    await page.getByRole('button', { name: '変換' }).click();
    const zip = page.getByRole('button', { name: 'ZIPですべて保存' });
    const save = page.getByRole('button', { name: 'このファイルを保存' }).first();
    const copy = page.getByRole('button', { name: 'コピー' }).first();
    await expect(zip).toBeEnabled();

    await goToTab(page, 'ルール');
    await cell(page, 0, 1).fill('ありす');
    await goToTab(page, '出力');

    // 古い結果はプレビューとしては残る。持ち出す操作だけ止める。
    await expect(page.locator('.file-card__body mark').first()).toHaveText('あーちゃん');
    await expect(zip).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(copy).toBeDisabled();
    await expect(page.locator('.result-bar__stale')).toContainText('再変換してください');

    await page.getByRole('button', { name: '再変換' }).click();
    await expect(zip).toBeEnabled();
    await expect(save).toBeEnabled();
    await expect(copy).toBeEnabled();
    await expect(page.locator('.result-bar__stale')).toHaveCount(0);
  });
});

test.describe('変換前の点検', () => {
  test('正規表現エラーがあると変換せずルールタブへ戻される', async ({ page }) => {
    await goToTab(page, 'ルール');
    await cell(page, 2, 0).fill('(');
    await cell(page, 2, 1).fill('x');
    await page.getByRole('button', { name: '正規表現' }).nth(2).click();
    await expect(page.locator('.rule-table__error')).toContainText('正規表現エラー');

    // 出力タブの空状態には「変換する」もあるので、ヘッダーの「変換」だけを指す。
    await goToTab(page, '出力');
    await page.getByRole('button', { name: '変換', exact: true }).click();
    await expect(page.locator('.toast')).toHaveText(
      '正規表現エラーが1件あります。直してから変換してください',
    );
    // 結果は作られず、ルールタブへ移る。
    await expect(page.locator('.tab.is-active')).toContainText('ルール');
    await expect(page.locator('.file-card__path')).toHaveCount(0);
  });

  test('1件も置換されなかったルールがあると変換後に知らせる', async ({ page }) => {
    await goToTab(page, 'ルール');
    await cell(page, 2, 0).fill('出てこない語');
    await cell(page, 2, 1).fill('X');

    await page.getByRole('button', { name: '変換' }).click();
    await expect(page.locator('.toast')).toHaveText(
      '変換しました（1件も置換されなかったルールが1件あります）',
    );
    // 警告なので結果は作られる。
    await expect(page.locator('.file-card__path')).toBeVisible();
  });
});
