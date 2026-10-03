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
  // 1件目はすぐ終わる。2件目で止まる。2件目の進みが届いたこと（「2 / 2」）を画面で
  // 確かめてから時計を進める。届く前に進めると「進みが一度も無かった」側の知らせになり、
  // 実時間の固定の待ちだと Worker の起動が遅い環境で取り違える。
  await seedWorkspace(page, {
    inputs: [
      { id: 'i0', title: 'fast.txt', text: 'b' },
      { id: 'i1', title: 'slow.txt', text: `${'a'.repeat(40)}b` },
    ],
    groups: GROUPS,
    rules: [CATASTROPHIC],
  });
  await openApp(page);
  await page.getByRole('button', { name: '変換', exact: true }).click();
  await expect(status(page)).toContainText('変換しています（2 / 2 ファイル）');
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
  // 変えた操作が出したトースト（「元に戻す」など）を上書きしないよう、知らせは変換の帯に出す。
  await expect(status(page)).toHaveAttribute('role', 'alert');
  await expect(status(page)).toContainText('入力かルールが変わったため');
  await expect(status(page).getByRole('button', { name: '中止' })).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('変換の Worker のスクリプトには、通信を許さない CSP ヘッダが付く', async ({ page }) => {
  // 同一オリジンの Worker にはページの <meta> の CSP が引き継がれない。原稿とルールが渡る
  // Worker から外へ送れないよう、スクリプトの応答ヘッダで塞いでいる（vercel.json と同じ値）。
  await seedCatastrophic(page);
  await openApp(page);
  const created = page.waitForEvent('worker');
  await page.getByRole('button', { name: '変換', exact: true }).click();
  const worker = await created;
  expect(worker.url()).toMatch(/\/assets\/conversion\.worker-[^/]+\.js$/);
  const response = await page.request.get(worker.url());
  expect(response.headers()['content-security-policy']).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  await status(page).getByRole('button', { name: '中止' }).click();
});
