import { expect, test } from '@playwright/test';
import { STORAGE_KEY } from '../src/lib/storage';
import { openApp, seedRawWorkspace } from './fixtures';

/**
 * 描画中に例外が出たときの最後の受け皿（ErrorBoundary）。
 *
 * 保存データが原因で落ちるとリロードしても同じ場所で落ち続けるので、
 * 「退避してから消す」が画面の中だけで完結することを確かめる。
 * 落とし方は、入力カードの行数表示が使う `toLocaleString` を投げさせる。
 * 復旧画面自体は数値整形を使わないので、受け皿ごと巻き込まれない。
 */
async function breakRendering(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    Number.prototype.toLocaleString = () => {
      throw new Error('描画テスト用の例外');
    };
  });
}

const SAVED = JSON.stringify({
  theme: 'light',
  inputs: [{ id: 'i1', title: 'a.txt', text: 'あ' }],
  groups: [{ id: 'g1', name: 'G用' }],
  rules: [],
});

test.beforeEach(async ({ page }) => {
  await seedRawWorkspace(page, SAVED);
});

test('描画に失敗したら白画面ではなく復旧画面が出る', async ({ page }) => {
  await breakRendering(page);
  await page.goto('/');
  const recovery = page.locator('.recovery');
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('heading')).toHaveText('画面の表示に失敗しました');
  await expect(page.locator('.recovery__detail')).toContainText('描画テスト用の例外');
});

test('復旧画面から保存データを退避できる', async ({ page }) => {
  await breakRendering(page);
  await page.goto('/');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '保存データをダウンロード' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^bulk-replace-backup-.*\.json$/);
  const saved = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(saved).toContain('a.txt');
});

test('復旧画面から保存データを消せる', async ({ page }) => {
  await breakRendering(page);
  await page.goto('/');
  await page.getByRole('button', { name: '保存データを削除して初期状態に戻す' }).click();
  // reload 後も同じ init script で落ちるが、保存データは消えている。
  await expect(page.locator('.recovery')).toBeVisible();
  const saved = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(saved).toBeNull();
  await expect(page.getByRole('button', { name: '保存データをダウンロード' })).toBeDisabled();
});

test('保存データが無ければ退避も削除も押せない', async ({ page }) => {
  await breakRendering(page);
  await page.addInitScript((key) => localStorage.removeItem(key), STORAGE_KEY);
  await page.goto('/');
  await expect(page.locator('.recovery')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存データをダウンロード' })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '保存データを削除して初期状態に戻す' }),
  ).toBeDisabled();
});

test('例外が起きなければ復旧画面は出ない', async ({ page }) => {
  // このテストだけ breakRendering を呼ばない。
  await openApp(page);
  await expect(page.locator('.recovery')).toHaveCount(0);
});
