import { expect, test } from '@playwright/test';
import { goToTab, openApp } from './fixtures';

/**
 * アプリの初回サンプルそのものを見る唯一の spec。
 *
 * 他の spec は `seedBasic` などでテスト側の状態を仕込む。サンプルの文言を変えたら
 * 落ちるのはここだけ、という状態を保つ。
 */
test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('初回はサンプルの入力とルールが並ぶ', async ({ page }) => {
  await expect(page.locator('.input-card')).toHaveCount(1);
  await expect(page.locator('.input-card__title')).toHaveValue('chapter1.md');

  await goToTab(page, 'ルール');
  await expect(page.locator('.rule-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.rule-table__group-name').first()).toHaveValue('A用');
  await expect(page.locator('.rule-table__group-name').nth(1)).toHaveValue('B用');
});

test('サンプルはそのまま変換まで通る（使い方が一目で分かる状態になっている）', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card__path')).toHaveText('A用/chapter1.md');
  await expect(page.locator('.file-card__body mark').first()).toBeVisible();
});
