import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { STORAGE_KEY } from '../src/lib/storage';
import { goToTab, openApp, seedBasic } from './fixtures';

/**
 * 作業データ（原稿・グループ・ルール）の書き出しと読み込み。
 *
 * localStorage だけが保存先なので、ブラウザ側の都合で消えたときに戻せる経路が
 * 画面の中で完結していることを確かめる。
 */
test.beforeEach(async ({ page }) => {
  await seedBasic(page);
  await openApp(page);
});

async function openBackup(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '作業データ' }).click();
  await expect(page.locator('dialog[aria-label="作業データ"][open]')).toBeVisible();
}

test('書き出すと、読み戻せる JSON が落ちてくる', async ({ page }) => {
  await openBackup(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '書き出す' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^bulk-replace-workspace-\d{8}-\d{4}\.json$/);

  const saved: unknown = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(saved).toMatchObject({
    app: 'bulk-text-replacement-tool',
    version: 2,
    workspace: {
      inputs: [{ title: 'story.md' }],
      groups: [{ name: 'A用' }, { name: 'B用' }],
    },
  });
});

test('書き出したものを読み込むと、確認を経て復元される', async ({ page }) => {
  await openBackup(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '書き出す' }).click(),
  ]);
  const backupPath = await download.path();

  // 原稿を消してしまった状態を作る。
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'すべて削除' }).click();
  await page.getByRole('button', { name: 'すべて削除する' }).click();
  await expect(page.locator('.input-card')).toHaveCount(0);

  await openBackup(page);
  await page
    .locator('dialog[aria-label="作業データ"] input[type="file"]')
    .setInputFiles(backupPath);

  // 選んだだけでは反映されない。中身を見せて確認を取る。
  const confirmBlock = page.getByRole('region', { name: '読み込む内容の確認' });
  await expect(confirmBlock).toContainText('入力 1件');
  await expect(confirmBlock).toContainText('グループ 2件');
  await expect(confirmBlock).toContainText('ルール 2行');
  await expect(page.locator('.input-card')).toHaveCount(0);

  await confirmBlock.getByRole('button', { name: '現在のデータを置き換える' }).click();
  await expect(page.locator('dialog[aria-label="作業データ"]')).toHaveCount(0);
  await expect(page.locator('.input-card__title')).toHaveValue('story.md');
  await goToTab(page, 'ルール');
  await expect(page.locator('[data-cell="0:0"]')).toHaveValue('アリス');
});

test('読めないファイルを選んでも、いまのデータは消えない', async ({ page }) => {
  await openBackup(page);
  await page
    .locator('dialog[aria-label="作業データ"] input[type="file"]')
    .setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });

  await expect(page.locator('.dialog__error')).toContainText('JSON として読めません');
  await expect(page.getByRole('region', { name: '読み込む内容の確認' })).toHaveCount(0);

  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('.input-card__title')).toHaveValue('story.md');
});

test('別のツールの JSON は受け付けない', async ({ page }) => {
  await openBackup(page);
  await page.locator('dialog[aria-label="作業データ"] input[type="file"]').setInputFiles({
    name: 'other.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ app: 'something-else', version: 1 })),
  });
  await expect(page.locator('.dialog__error')).toContainText(
    'このツールの作業データではありません',
  );
});

test('保存できないときは、消えるトーストではなく出したままの警告で知らせる', async ({ page }) => {
  // 容量超過を起こす。setItem だけを失敗させ、読み取りは生かす。
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name: string, value: string) {
      if (name === key) throw new Error('QuotaExceededError');
      return original.call(this, name, value);
    };
  }, STORAGE_KEY);
  await page.reload();

  await page.locator('.input-card__title').fill('changed.md');
  const banner = page.locator('.save-error');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('保存できませんでした');

  // 書き出しへ誘導できる。
  await banner.getByRole('button', { name: '作業データを書き出す' }).click();
  await expect(page.locator('dialog[aria-label="作業データ"][open]')).toBeVisible();
});

test('ファイル自体を読めなかったら、理由を出して、いまのデータは消えない', async ({ page }) => {
  await page.evaluate(() => {
    File.prototype.arrayBuffer = () =>
      Promise.reject(new DOMException('読めません', 'NotReadableError'));
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBackup(page);
  await page
    .locator('dialog[aria-label="作業データ"] input[type="file"]')
    .setInputFiles({ name: 'cloud.json', mimeType: 'application/json', buffer: Buffer.from('{}') });

  await expect(page.locator('.dialog__error')).toContainText('ファイルを読み込めませんでした');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('.input-card')).toHaveCount(1);
  expect(errors).toEqual([]);
});
