import { readFile } from 'node:fs/promises';
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

test('復旧画面で退避したファイルは、保存データを消したあと通常の作業データの読み込みで戻せる', async ({
  page,
  context,
}) => {
  await breakRendering(page);
  await page.goto('/');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '保存データをダウンロード' }).click(),
  ]);
  const backupPath = await download.path();
  await page.getByRole('button', { name: '保存データを削除して初期状態に戻す' }).click();
  await expect(page.getByRole('button', { name: '保存データをダウンロード' })).toBeDisabled();

  // 落ちない状態で開き直す（init script はページごとなので、別のページでは描画が壊れない）。
  const fresh = await context.newPage();
  await openApp(fresh);
  await fresh.getByRole('button', { name: '作業データ' }).click();
  await fresh
    .locator('dialog[aria-label="作業データ"] input[type="file"]')
    .setInputFiles(backupPath);
  const confirmBlock = fresh.getByRole('region', { name: '読み込む内容の確認' });
  await expect(confirmBlock).toContainText('入力 1件');
  await confirmBlock.getByRole('button', { name: '現在のデータを置き換える' }).click();
  await expect(fresh.locator('.input-card__title')).toHaveValue('a.txt');
  await expect(fresh.locator('.input-card__preview').first()).toContainText('あ');
});

test('保存に失敗している間に落ちたら、保存データに無い最新の作業を退避して読み戻せる', async ({
  page,
  context,
}) => {
  await openApp(page);
  // 以降の保存を失敗させる（容量超過の代わり）。
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('容量超過のテスト', 'QuotaExceededError');
    };
  });
  await page.locator('.input-card__title').fill('unsaved.md');
  await expect(
    page.getByRole('alert').filter({ hasText: 'ブラウザに保存できませんでした' }),
  ).toBeVisible();

  // 保存できないまま編集を続け、その描画で落ちる。
  await page.evaluate(() => {
    Number.prototype.toLocaleString = () => {
      throw new Error('描画テスト用の例外');
    };
  });
  await page.locator('.input-card__title').fill('latest.md');
  const recovery = page.locator('.recovery');
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText('ブラウザに保存できていない作業があります');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '最新の作業内容をダウンロード' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^bulk-replace-latest-.*\.json$/);
  const backupPath = await download.path();
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup.workspace.inputs[0].title).toBe('latest.md');
  // 保存データの方は、最後に保存できた古い内容のまま。
  const saved = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(saved).toContain('a.txt');
  expect(saved).not.toContain('latest.md');

  // 退避したファイルは、通常の作業データの読み込みで戻せる。
  const fresh = await context.newPage();
  await openApp(fresh);
  await fresh.getByRole('button', { name: '作業データ' }).click();
  await fresh
    .locator('dialog[aria-label="作業データ"] input[type="file"]')
    .setInputFiles(backupPath);
  const confirmBlock = fresh.getByRole('region', { name: '読み込む内容の確認' });
  await confirmBlock.getByRole('button', { name: '現在のデータを置き換える' }).click();
  await expect(fresh.locator('.input-card__title')).toHaveValue('latest.md');
});

test('保存済みの内容で落ちたときは、最新の作業内容の退避を出さない', async ({ page }) => {
  await breakRendering(page);
  await page.goto('/');
  await expect(page.locator('.recovery')).toBeVisible();
  await expect(page.getByRole('button', { name: '最新の作業内容をダウンロード' })).toHaveCount(0);
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

test('ID が __proto__ や constructor の保存データでも起動し、置換先どおりに変換できる', async ({
  browser,
}) => {
  // beforeEach の仕込みを使わないよう、別のページで開く。
  const page = await browser.newPage();
  await seedRawWorkspace(
    page,
    `{
      "theme": "light",
      "inputs": [{ "id": "__proto__", "title": "a.txt", "text": "アリス" }],
      "groups": [{ "id": "__proto__", "name": "A用" }, { "id": "constructor", "name": "B用" }],
      "rules": [{ "id": "toString", "src": "アリス", "values": { "__proto__": "あー", "constructor": "びー" } }]
    }`,
  );
  await openApp(page);
  await expect(page.locator('.recovery')).toHaveCount(0);
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card').first()).toContainText('あー');
  await page.locator('.out-tab', { hasText: 'B用' }).click();
  await expect(page.locator('.file-card').first()).toContainText('びー');
  await expect(page.locator('.file-list')).not.toContainText('[object');
  await page.close();
});

test('例外が起きなければ復旧画面は出ない', async ({ page }) => {
  // このテストだけ breakRendering を呼ばない。
  await openApp(page);
  await expect(page.locator('.recovery')).toHaveCount(0);
});
