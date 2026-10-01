import { expect, type Page, test } from '@playwright/test';
import { goToTab, makeRule, openApp, seedWorkspace } from './fixtures';

/**
 * 変換を Web Worker に隔離したこと（issue #31）。
 *
 * 破滅的なバックトラック（`(a+)+$` を `aaaa…b` に当てる）はメインスレッドで走らせると
 * タブごと固まり、始まったら止められない。Worker なら画面は動き続け、中止・時間切れで
 * Worker ごと捨てられる。
 */

const GROUPS = [{ id: 'g1', name: 'A用' }];
const CATASTROPHIC = makeRule('r1', '(a+)+$', { g1: 'x' }, { regex: true });

async function seedCatastrophic(page: Page): Promise<void> {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'slow.txt', text: `${'a'.repeat(40)}b` }],
    groups: GROUPS,
    rules: [CATASTROPHIC],
  });
}

function status(page: Page) {
  return page.locator('.conversion-status');
}

test('止まらない正規表現でも画面は操作でき、中止で止められる', async ({ page }) => {
  await seedCatastrophic(page);
  await openApp(page);
  await page.getByRole('button', { name: '変換', exact: true }).click();
  await expect(status(page)).toContainText('変換しています（1 / 1 ファイル）');

  // メインスレッドは空いている（タブを切り替えられる）。
  await goToTab(page, 'ルール');
  await expect(page.getByRole('region', { name: 'ルール' })).toBeVisible();
  await goToTab(page, '入力');
  await page.locator('.input-card__title').focus();

  await status(page).getByRole('button', { name: '中止' }).click();
  await expect(status(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveText('変換を中止しました');
});

test('1つのパスが終わらなければ時間切れにし、原因のルールを出したままにする', async ({ page }) => {
  await page.clock.install();
  await seedCatastrophic(page);
  await openApp(page);
  await page.getByRole('button', { name: '変換', exact: true }).click();
  await expect(status(page)).toContainText('変換しています');
  // Worker から最初の進み（止まるパスの開始）が届くのを実時間で待つ。時計は止めてあるので、
  // 届く前に進めると「進みが一度も無かった」側の知らせになる。
  await page.waitForTimeout(500);
  await page.clock.runFor(31_000);

  const alert = page.getByRole('alert').filter({ hasText: '変換を中止しました' });
  await expect(alert).toContainText('slow.txt で');
  await expect(alert).toContainText('ルール 1 行目（置換元: (a+)+$）');
  await expect(alert).toContainText('30 秒');
  // 消えるトーストにしない。閉じるまで残る。
  await page.clock.runFor(10_000);
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: '閉じる' }).click();
  await expect(alert).toHaveCount(0);
});

test('置換で結果が膨らみすぎたら、膨らみきる前に止めてルールを示す', async ({ page }) => {
  const grow = (id: string) =>
    makeRule(id, '.+', { g1: '$&'.repeat(64) }, { regex: true, order: 'seq' });
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'grow.txt', text: 'abcdefgh' }],
    groups: GROUPS,
    // 8 × 64 × 64 × 64 × 64 は上限を超える（4行目で止まる）。
    rules: [grow('r1'), grow('r2'), grow('r3'), grow('r4')],
  });
  await openApp(page);
  await page.getByRole('button', { name: '変換', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: '大きくなりすぎた' });
  await expect(alert).toContainText('grow.txt で');
  await expect(alert).toContainText('ルール 4 行目');
  // 結果は作らない（途中までの結果を持ち出せる状態にしない）。
  await expect(page.locator('.file-card')).toHaveCount(0);
});

test('変換中に入力を変えたら、古い内容の変換を取り消す', async ({ page }) => {
  await seedCatastrophic(page);
  await openApp(page);
  await page.getByRole('button', { name: '変換', exact: true }).click();
  await expect(status(page)).toContainText('変換しています');
  await page.locator('.input-card__title').fill('renamed.txt');
  await expect(status(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveText('入力かルールが変わったため、変換を中止しました');
});
