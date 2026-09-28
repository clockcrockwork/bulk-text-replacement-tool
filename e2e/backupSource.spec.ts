import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import type { GitHubInputSource } from '../src/types';
import { makeRule, openApp, seedWorkspace } from './fixtures';

/**
 * 作業データの版 2（入力の出自 `source` を持つ）。
 *
 * GitHub から取り込んだ入力の出自は、書き出して読み戻しても消えないこと、
 * 出自を知らない版 1 のファイルも引き続き読めることを確かめる。
 */

const SOURCE: GitHubInputSource = {
  kind: 'github',
  repositoryId: 4242,
  owner: 'octo',
  repo: 'novel',
  ref: 'main',
  commitSha: 'a'.repeat(40),
  path: 'chapters/ch1.md',
  blobSha: 'b'.repeat(40),
};

const GROUPS = [{ id: 'g1', name: 'A用' }];
const RULES = [makeRule('r1', 'アリス', { g1: 'あーちゃん' })];

function backupDialog(page: Page) {
  return page.locator('dialog[aria-label="作業データ"]');
}

async function openBackup(page: Page): Promise<void> {
  await page.getByRole('button', { name: '作業データ' }).click();
  await expect(backupDialog(page)).toBeVisible();
}

test('GitHub の出自は書き出して読み戻しても残る', async ({ page }) => {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'ch1.md', text: '本文\n', source: SOURCE }],
    groups: GROUPS,
    rules: RULES,
  });
  await openApp(page);
  await expect(page.locator('.input-card__source')).toContainText('octo/novel · chapters/ch1.md');

  await openBackup(page);
  // 出自も書き出すこと（ファイルを渡すとリポジトリ名やパスも伝わること）を先に知らせる。
  await expect(backupDialog(page)).toContainText(
    '取り込み元（リポジトリ・ブランチ・パス・コミットの',
  );
  await expect(backupDialog(page)).toContainText('一緒に書き出します');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '書き出す' }).click(),
  ]);
  const backupPath = await download.path();
  const saved: unknown = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(saved).toMatchObject({ version: 2, workspace: { inputs: [{ source: SOURCE }] } });

  await backupDialog(page).getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'すべて削除' }).click();
  await page.getByRole('button', { name: 'すべて削除する' }).click();
  await expect(page.locator('.input-card')).toHaveCount(0);

  await openBackup(page);
  await backupDialog(page).locator('input[type="file"]').setInputFiles(backupPath);
  await page.getByRole('button', { name: '現在のデータを置き換える' }).click();
  await expect(page.locator('.input-card__source')).toContainText('octo/novel · chapters/ch1.md');
});

test('版 1 の作業データも読み込める（出自の無い入力として）', async ({ page }) => {
  await seedWorkspace(page, { inputs: [], groups: GROUPS, rules: RULES });
  await openApp(page);
  await openBackup(page);
  await backupDialog(page)
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'v1.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          app: 'bulk-text-replacement-tool',
          version: 1,
          savedAt: '2026-09-01T00:00:00.000Z',
          workspace: {
            inputs: [{ id: 'old', title: 'old.md', text: '旧版の原稿' }],
            groups: GROUPS,
            rules: RULES,
            theme: 'light',
          },
        }),
      ),
    });
  await expect(page.getByRole('region', { name: '読み込む内容の確認' })).toContainText('入力 1件');
  await page.getByRole('button', { name: '現在のデータを置き換える' }).click();
  await expect(page.locator('.input-card__title')).toHaveValue('old.md');
  await expect(page.locator('.input-card__source')).toHaveCount(0);
});
