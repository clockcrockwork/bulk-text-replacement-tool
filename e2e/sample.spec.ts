import { expect, test } from '@playwright/test';
import { goToTab, openApp } from './fixtures';
import { GitHubMock, novelRepository } from './githubMock';

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

test('原稿を取り込むとサンプルは自動で片付き、元に戻せる', async ({ page }) => {
  await expect(page.locator('.sample-notice')).toBeVisible();

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([{ name: 'real.md', mimeType: 'text/markdown', buffer: Buffer.from('実原稿') }]);

  // サンプルの入力・ルールは残らない（結果に混ざらない）。
  await expect(page.locator('.input-card')).toHaveCount(1);
  await expect(page.locator('.input-card__title')).toHaveValue('real.md');
  await expect(page.locator('.sample-notice')).toHaveCount(0);
  await goToTab(page, 'ルール');
  await expect(page.locator('[data-cell="0:0"]')).toHaveValue('');

  await goToTab(page, '入力');
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.locator('.input-card__title').first()).toHaveValue('chapter1.md');
  await expect(page.locator('.sample-notice')).toBeVisible();
});

test('GitHub から一括で取り込むとサンプルは片付き、元に戻すと確認画面ごと戻る', async ({
  page,
}) => {
  // 戻しても取得した一括は失わない（確認画面へ戻るだけ。docs/github-import-v2.md §7）。
  const mock = new GitHubMock([novelRepository()]);
  await mock.install(page);
  const dialog = page.getByRole('dialog', { name: 'GitHubから追加' });

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog.getByRole('button', { name: 'GitHubに接続' }).click();
  await dialog.getByRole('button', { name: 'octo/novel' }).click();
  await dialog.getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  await dialog.getByRole('button', { name: '選択したファイルを確認' }).click();
  await dialog.getByRole('button', { name: '2ファイルを取得' }).click();
  await dialog.getByRole('button', { name: '2ファイルを取り込む' }).click();

  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__title').nth(0)).toHaveValue('ch1.md');
  await expect(page.locator('.input-card__title').nth(1)).toHaveValue('ch2.txt');
  await expect(page.locator('.sample-notice')).toHaveCount(0);
  await expect(page.getByText('サンプルを片付けました')).toBeVisible();
  await goToTab(page, 'ルール');
  await expect(page.locator('[data-cell="0:0"]')).toHaveValue('');

  await page.getByRole('button', { name: '元に戻す' }).click();
  const blobs = mock.apiCalls(/\/git\/blobs\//).length;
  await expect(dialog.getByRole('button', { name: '2ファイルを取り込む' })).toBeVisible();
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await goToTab(page, '入力');
  await expect(page.locator('.sample-notice')).toBeVisible();
  await expect(page.locator('.input-card__title').first()).toHaveValue('chapter1.md');
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(blobs);
});

test('一括取り込みの確認では、手つかずのサンプルとの同名を警告しない', async ({ page }) => {
  // サンプルは同じ取り込みの中で片付くので、消える入力との衝突を知らせても意味が無い。
  const mock = new GitHubMock([
    novelRepository({
      branches: { main: [{ path: 'chapters/chapter1.md', content: '本物の1章。\n' }] },
    }),
  ]);
  await mock.install(page);
  const dialog = page.getByRole('dialog', { name: 'GitHubから追加' });

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog.getByRole('button', { name: 'GitHubに接続' }).click();
  await dialog.getByRole('button', { name: 'octo/novel' }).click();
  await dialog.getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  await dialog.getByRole('button', { name: '選択したファイルを確認' }).click();
  await dialog.getByRole('button', { name: '1ファイルを取得' }).click();

  const batch = dialog.getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch.getByText('新しい入力として追加')).toBeVisible();
  await expect(batch.getByText(/同じファイル名の別入力があります/)).toHaveCount(0);
  await batch.getByRole('button', { name: '1ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(1);
  await expect(page.locator('.input-card__preview')).toHaveValue('本物の1章。\n');
});

test('サンプルを自分で片付けられる', async ({ page }) => {
  await page.getByRole('button', { name: 'サンプルを片付ける' }).click();
  await expect(page.locator('.input-card')).toHaveCount(0);
  await expect(page.locator('.sample-notice')).toHaveCount(0);
  await expect(page.locator('.empty')).toContainText('入力がありません');
});

test('サンプルを編集したら、以降は自動で片付けない', async ({ page }) => {
  await page.locator('.input-card__title').fill('書き換えた.md');
  await expect(page.locator('.sample-notice')).toHaveCount(0);

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([{ name: 'real.md', mimeType: 'text/markdown', buffer: Buffer.from('実原稿') }]);

  // 手を入れたものは勝手に消さない。
  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__title').first()).toHaveValue('書き換えた.md');
});
