import { expect, type Page, test } from '@playwright/test';
import { openApp, seedBasic } from './fixtures';

/**
 * 取り込む入力の大きさの上限（docs/resource-policy.md）。ローカルのファイルの経路。
 * GitHub の経路は github.spec.ts で見る（上限の値は同じ）。
 */

const MiB = 1024 * 1024;

function textFile(name: string, bytes: number) {
  return { name, mimeType: 'text/plain', buffer: Buffer.alloc(bytes, 'a') };
}

async function pick(page: Page, files: ReturnType<typeof textFile>[]): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(files);
}

test.beforeEach(async ({ page }) => {
  await seedBasic(page);
  await openApp(page);
});

test('5MiB を超えるファイルは読まずに外し、名前を知らせて、残りは取り込む', async ({ page }) => {
  await pick(page, [textFile('huge.md', 5 * MiB + 1), textFile('ok.md', 10)]);

  await expect(page.locator('.toast')).toHaveText(
    '1件のファイルを追加しました · huge.md は 5MiB を超えるため取り込みませんでした',
  );
  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__title').nth(1)).toHaveValue('ok.md');
});

test('1件ずつは上限内でも、合計が 5MiB を超えたら1件も取り込まない', async ({ page }) => {
  await pick(page, [textFile('a.md', 3 * MiB), textFile('b.md', 3 * MiB)]);

  await expect(page.locator('.toast')).toContainText('選んだファイルの合計が 5MiB を超えるため');
  await expect(page.locator('.input-card')).toHaveCount(1);
});

test.describe('保存容量を超えそうなとき', () => {
  const large = textFile('large.md', 4.5 * MiB);

  test('取り込む前に確かめ、キャンセルすれば入力を変えない', async ({ page }) => {
    await pick(page, [large]);

    const dialog = page.getByRole('dialog', { name: 'ブラウザに保存できない可能性があります' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('取り込むファイル 1件');
    // 既定のフォーカスはキャンセル側（破壊的な確認と同じ作法）。
    await expect(dialog.getByRole('button', { name: 'キャンセル' })).toBeFocused();
    await dialog.getByRole('button', { name: 'キャンセル' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.input-card')).toHaveCount(1);
  });

  test('「取り込む」を選べば取り込む', async ({ page }) => {
    await pick(page, [large]);
    await page
      .getByRole('dialog', { name: 'ブラウザに保存できない可能性があります' })
      .getByRole('button', { name: '取り込む' })
      .click();

    // 大きな本文の描画に時間がかかり、トーストは確かめる前に消えることがあるので、入力で見る。
    await expect(page.locator('.input-card')).toHaveCount(2);
    await expect(page.locator('.input-card__title').nth(1)).toHaveValue('large.md');
  });

  test('小さいファイルでは確かめない', async ({ page }) => {
    await pick(page, [textFile('small.md', 1024)]);
    await expect(page.locator('.toast')).toHaveText('1件のファイルを追加しました');
    await expect(page.locator('dialog.dialog--confirm')).toHaveCount(0);
  });
});
