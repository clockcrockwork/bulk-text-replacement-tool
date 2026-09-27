import { expect, test } from '@playwright/test';
import { goToTab, openApp, seedBasic } from '../fixtures';

/** 狭い画面（スマホ）専用。デスクトップとはレイアウトの前提が違うので分けている。 */

test.beforeEach(async ({ page }) => {
  await seedBasic(page);
  await openApp(page);
});

test('狭い画面ではルールが表ではなくカードで出る', async ({ page }) => {
  await goToTab(page, 'ルール');
  await expect(page.locator('.rule-table')).toHaveCount(0);
  await expect(page.locator('.rule-card')).toHaveCount(3);
  await expect(page.locator('.group-chip')).toHaveCount(2);
});

test('フォーム要素の文字は16px以上（iOS Safari の自動ズームを避ける）', async ({ page }) => {
  const collect = () =>
    page.$$eval('input:not([type="file"]), textarea', (elements) =>
      elements
        .filter((el) => el.checkVisibility())
        .map((el) => ({
          name: el.className.split(' ').slice(-1)[0] ?? el.tagName,
          size: Number.parseFloat(getComputedStyle(el).fontSize),
        })),
    );

  const inputTab = await collect();
  expect(inputTab.length).toBeGreaterThan(0);
  for (const control of inputTab) {
    expect(control.size, `入力タブ: ${control.name}`).toBeGreaterThanOrEqual(16);
  }

  await goToTab(page, 'ルール');
  const rulesTab = await collect();
  expect(rulesTab.length).toBeGreaterThan(0);
  for (const control of rulesTab) {
    expect(control.size, `ルールタブ: ${control.name}`).toBeGreaterThanOrEqual(16);
  }
});

test('スマホ幅でも変換して結果を確認できる', async ({ page }) => {
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card__path')).toHaveText('A用/story.md');
  await expect(page.locator('.file-card__body mark').first()).toHaveText('あーちゃん');
});

test('全画面エディタが開いて編集でき、閉じると反映される', async ({ page }) => {
  await page.locator('.input-card__preview').click();
  await expect(page.locator('dialog.editor[open]')).toBeVisible();

  await page.locator('.editor__textarea').fill('スマホから書き換え');
  await page.getByRole('button', { name: '完了' }).click();

  await expect(page.locator('dialog.editor')).toHaveCount(0);
  await expect(page.locator('.input-card__preview')).toHaveValue('スマホから書き換え');
});

test('カード表示ではキーボード無しで複数行にできる', async ({ page }) => {
  await goToTab(page, 'ルール');
  await page.getByRole('button', { name: '1行目の置換先（A用）を複数行で編集' }).click();

  const editor = page.locator('dialog.dialog--cell[open]');
  await expect(editor).toBeVisible();
  await editor.locator('textarea').fill('一行目\n二行目');
  await editor.getByRole('button', { name: '完了' }).click();

  await expect(page.locator('[data-cell="0:1"]')).toHaveText('一行目… [複数行]');
});
