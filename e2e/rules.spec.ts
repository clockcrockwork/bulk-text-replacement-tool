import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { BOM } from '../src/lib/text';
import { cell, goToTab, openApp, seedBasic } from './fixtures';

test.beforeEach(async ({ page }) => {
  await seedBasic(page);
  await openApp(page);
  await goToTab(page, 'ルール');
});

test('最終セルで Tab を押すと行が増えてそこへ移る', async ({ page }) => {
  const rows = page.locator('.rule-table tbody tr');
  await expect(rows).toHaveCount(3);

  await cell(page, 0, 0).click();
  await page.keyboard.press('Tab');
  await expect(cell(page, 0, 1)).toBeFocused();

  // 最終行・最終列（2行目 × A用/B用 の右端）から Tab で行が増える。
  await cell(page, 2, 2).click();
  await page.keyboard.press('Tab');
  await expect(rows).toHaveCount(4);
  await expect(cell(page, 3, 0)).toBeFocused();
});

test('Enter は同じ列の下の行へ移る', async ({ page }) => {
  await cell(page, 0, 2).click();
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, 2)).toBeFocused();
});

test('カード表示に切り替えると1ルール1カードになる', async ({ page }) => {
  await page.getByRole('button', { name: 'カード' }).click();
  await expect(page.locator('.rule-table')).toHaveCount(0);
  await expect(page.locator('.rule-card')).toHaveCount(3);
  await expect(page.locator('.group-chip')).toHaveCount(2);

  await page.getByRole('button', { name: '表', exact: true }).click();
  await expect(page.locator('.rule-table')).toHaveCount(1);
});

test('グループ列を足すとルール表に置換先の欄が増える', async ({ page }) => {
  // 同じラベルのボタンがツールバーと表ヘッダーの両方にあるので、それぞれ別に確かめる。
  await page.locator('.toolbar').getByRole('button', { name: 'グループ（列）を追加' }).click();
  await expect(page.locator('.rule-table__group-name')).toHaveCount(3);
  await expect(cell(page, 0, 3)).toBeVisible();

  await page.locator('.rule-table__add-group').click();
  await expect(page.locator('.rule-table__group-name')).toHaveCount(4);
});

test('最後のグループは削除できない', async ({ page }) => {
  await page.getByRole('button', { name: 'この列を削除' }).first().click();
  await expect(page.locator('.rule-table__group-name')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'この列を削除' })).toBeDisabled();
});

test('正規表現として不正なパターンにはエラーを出す', async ({ page }) => {
  await cell(page, 0, 0).fill('(');
  await page.getByRole('button', { name: '正規表現' }).first().click();
  await expect(page.locator('.rule-table__error')).toContainText('正規表現エラー');
});

test('Markdown 表からルールを読み込む', async ({ page }) => {
  await page.getByRole('button', { name: '表から読み込み' }).click();
  await expect(page.locator('dialog[open]')).toBeVisible();
  // 既定は「末尾に追加」なので、置き換えたいときは明示的に選ぶ。
  await page.getByRole('button', { name: '置き換える' }).click();

  await page
    .locator('.dialog__textarea')
    .fill('| 元テキスト | C用 |\n| --- | --- |\n| 川辺 | 海辺 |');
  await expect(page.locator('.dialog__detect')).toHaveText('Markdown · 見出し＋1行 · 1列');

  await page.getByRole('button', { name: '読み込む' }).click();
  await page.locator('dialog.dialog--confirm').getByRole('button', { name: '置き換える' }).click();
  await expect(page.locator('.toast')).toHaveText('1行を読み込みました');
  await expect(page.locator('.rule-table__group-name')).toHaveCount(1);
  await expect(page.locator('.rule-table__group-name')).toHaveValue('C用');
  await expect(cell(page, 0, 0)).toHaveValue('川辺');
});

test('末尾に追加モードでは既存のルールを残す', async ({ page }) => {
  await page.getByRole('button', { name: '表から読み込み' }).click();
  await page.locator('.dialog__textarea').fill('元テキスト,A用\n川辺,海辺');
  await expect(page.locator('.dialog__detect')).toHaveText('CSV · 見出し＋1行 · 1列');
  await page.getByRole('button', { name: '読み込む' }).click();

  // fixture の「アリス」「ビル」の後ろに追加される（空行は捨てられる）。
  await expect(cell(page, 0, 0)).toHaveValue('アリス');
  await expect(cell(page, 2, 0)).toHaveValue('川辺');
});

test('キャンセルするとルールは変わらない', async ({ page }) => {
  await page.getByRole('button', { name: '表から読み込み' }).click();
  await page.locator('.dialog__textarea').fill('元テキスト,C用\n川辺,海辺');
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(cell(page, 0, 0)).toHaveValue('アリス');
});

test('Escape でもモーダルを閉じられる', async ({ page }) => {
  await page.getByRole('button', { name: '表から読み込み' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('CSV に書き出すとオプション列つきの表になる', async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('rules.csv');

  const text = await readFile(await download.path(), 'utf8');
  expect(text).toBe(
    `${BOM}元テキスト,A用,B用,正規表現,大小区別,適用順\r\n` +
      'アリス,あーちゃん,びーちゃん,0,1,同時\r\n' +
      'ビル,びる,れいちゃん,0,1,同時',
  );
});

test('TSV に書き出すとタブ区切りの表になる', async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'TSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('rules.tsv');

  const text = await readFile(await download.path(), 'utf8');
  expect(text).toBe(
    `${BOM}元テキスト\tA用\tB用\t正規表現\t大小区別\t適用順\r\n` +
      'アリス\tあーちゃん\tびーちゃん\t0\t1\t同時\r\n' +
      'ビル\tびる\tれいちゃん\t0\t1\t同時',
  );
});

test.describe('取り込みは既定で非破壊', () => {
  test('既定は「末尾に追加」で、既存のルールを消さない', async ({ page }) => {
    await page.getByRole('button', { name: '表から読み込み' }).click();
    await expect(page.getByRole('button', { name: '末尾に追加' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.locator('.dialog__textarea').fill('元テキスト,A用\n川辺,海辺');
    await page.getByRole('button', { name: '読み込む' }).click();

    // 確認は出ず、既存の2行はそのまま残る。
    await expect(page.locator('dialog.dialog--confirm')).toHaveCount(0);
    await expect(cell(page, 0, 0)).toHaveValue('アリス');
    await expect(cell(page, 2, 0)).toHaveValue('川辺');
  });

  test('「置き換える」は何が失われるか見せて確認する', async ({ page }) => {
    await page.getByRole('button', { name: '表から読み込み' }).click();
    await page.getByRole('button', { name: '置き換える' }).click();
    await page.locator('.dialog__textarea').fill('元テキスト,C用\n川辺,海辺');
    await page.getByRole('button', { name: '読み込む' }).click();

    const confirmDialog = page.locator('dialog.dialog--confirm[open]');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.locator('.dialog__details')).toContainText('ルール 2行');
    await expect(confirmDialog.locator('.dialog__details')).toContainText('グループ 2件');

    // キャンセルすれば何も変わらない。
    await confirmDialog.getByRole('button', { name: 'キャンセル' }).click();
    await expect(cell(page, 0, 0)).toHaveValue('アリス');
    await expect(page.locator('.rule-table__group-name')).toHaveCount(2);
  });

  test('確認を通すと置き換わる', async ({ page }) => {
    await page.getByRole('button', { name: '表から読み込み' }).click();
    await page.getByRole('button', { name: '置き換える' }).click();
    await page.locator('.dialog__textarea').fill('元テキスト,C用\n川辺,海辺');
    await page.getByRole('button', { name: '読み込む' }).click();
    await page
      .locator('dialog.dialog--confirm')
      .getByRole('button', { name: '置き換える' })
      .click();

    await expect(page.locator('.rule-table__group-name')).toHaveCount(1);
    await expect(page.locator('.rule-table__group-name')).toHaveValue('C用');
    await expect(cell(page, 0, 0)).toHaveValue('川辺');
  });
});
