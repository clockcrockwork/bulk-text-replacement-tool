import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { STORAGE_KEY } from '../src/lib/storage';
import { openApp, seedBasic } from './fixtures';

/**
 * 同じオリジンを複数のタブで開いたとき（issue #30）。
 *
 * どのタブも同じキーへ自動保存するので、検知しないと後から保存したタブが前のタブの
 * 編集を黙って消す。別のタブの書き込みを `storage` イベントで検知したら、このタブの
 * 保存を止め、出したままの警告でどちらを正とするかを選んでもらう。
 *
 * 2つめのタブは仕込みをしないで開く（仕込みはタブごとに1回効くので、開いた時点で
 * 保存データを書き戻してしまう）。
 */

const CONFLICT = '別のタブで作業データが更新されました';

async function savedTitle(page: Page): Promise<string | undefined> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  const parsed = JSON.parse(raw ?? '{}') as { inputs?: { title?: string }[] };
  return parsed.inputs?.[0]?.title;
}

async function openTwoTabs(page: Page, context: BrowserContext): Promise<Page> {
  await seedBasic(page);
  await openApp(page);
  const other = await context.newPage();
  await openApp(other);
  await expect(other.locator('.input-card__title')).toHaveValue('story.md');
  return other;
}

test('別のタブが保存したら、警告を出してこのタブからは保存しない', async ({ page, context }) => {
  const other = await openTwoTabs(page, context);

  await other.locator('.input-card__title').fill('from-other.md');
  await expect.poll(() => savedTitle(other)).toBe('from-other.md');

  const alert = page.getByRole('alert').filter({ hasText: CONFLICT });
  await expect(alert).toBeVisible();
  // 書いた側のタブには出さない（storage イベントは書いたタブには届かない）。
  await expect(other.getByRole('alert').filter({ hasText: CONFLICT })).toHaveCount(0);

  // このタブで編集しても、離れても、別のタブの内容を上書きしない。
  await page.locator('.input-card__title').fill('from-this.md');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(800);
  expect(await savedTitle(page)).toBe('from-other.md');
});

test('「このタブの内容で続ける」を確認したら上書きし、今度は別のタブに警告が出る', async ({
  page,
  context,
}) => {
  const other = await openTwoTabs(page, context);
  await other.locator('.input-card__title').fill('from-other.md');
  const alert = page.getByRole('alert').filter({ hasText: CONFLICT });
  await expect(alert).toBeVisible();
  await page.locator('.input-card__title').fill('from-this.md');

  await alert.getByRole('button', { name: 'このタブの内容で続ける（上書き）' }).click();
  // 確認を取り消せば何も変わらない。
  await page.getByRole('button', { name: 'キャンセル' }).click();
  expect(await savedTitle(page)).toBe('from-other.md');

  await alert.getByRole('button', { name: 'このタブの内容で続ける（上書き）' }).click();
  await page.getByRole('button', { name: '上書きして続ける' }).click();
  await expect(alert).toHaveCount(0);
  expect(await savedTitle(page)).toBe('from-this.md');
  await expect(other.getByRole('alert').filter({ hasText: CONFLICT })).toBeVisible();

  // 保存は再開している。
  await page.locator('.input-card__title').fill('again.md');
  await expect.poll(() => savedTitle(page)).toBe('again.md');
});

test('「再読み込み」を確認したら、別のタブが保存した内容に切り替わる', async ({
  page,
  context,
}) => {
  const other = await openTwoTabs(page, context);
  await other.locator('.input-card__title').fill('from-other.md');
  const alert = page.getByRole('alert').filter({ hasText: CONFLICT });
  await expect(alert).toBeVisible();
  await page.locator('.input-card__title').fill('from-this.md');

  await alert.getByRole('button', { name: '再読み込み（別タブの内容を読む）' }).click();
  await page.getByRole('button', { name: '再読み込みする' }).click();
  await expect(page.locator('.input-card__title')).toHaveValue('from-other.md');
  await expect(page.getByRole('alert').filter({ hasText: CONFLICT })).toHaveCount(0);
  expect(await savedTitle(page)).toBe('from-other.md');
});

test('別のタブが同じ内容を保存しただけなら、警告を出さない', async ({ page, context }) => {
  const other = await openTwoTabs(page, context);
  // 開いた直後の自動保存（同じ内容）を待ってから、どちらにも警告が無いことを見る。
  await other.waitForTimeout(800);
  await page.waitForTimeout(800);
  await expect(page.getByRole('alert').filter({ hasText: CONFLICT })).toHaveCount(0);
  await expect(other.getByRole('alert').filter({ hasText: CONFLICT })).toHaveCount(0);
});

test('食い違いの間は、作業データの書き出しへ案内する', async ({ page, context }) => {
  const other = await openTwoTabs(page, context);
  await other.locator('.input-card__title').fill('from-other.md');
  const alert = page.getByRole('alert').filter({ hasText: CONFLICT });
  await alert.getByRole('button', { name: '作業データを書き出す' }).click();
  const dialog = page.locator('dialog[aria-label="作業データ"]');
  await expect(dialog).toBeVisible();
});

test('別のタブの storage イベントが届く前でも、保存の直前に気づいて上書きしない', async ({
  page,
  context,
}) => {
  await seedBasic(page);
  await openApp(page);
  // このタブには storage イベントを届けない（届くのが遅れた状態を作る）。
  const late = await context.newPage();
  await late.addInitScript(() => {
    window.addEventListener('storage', (event) => event.stopImmediatePropagation(), true);
  });
  await openApp(late);
  await expect(late.locator('.input-card__title')).toHaveValue('story.md');
  // 開いた直後の自動保存（同じ内容）を待つ。
  await late.waitForTimeout(800);

  await page.locator('.input-card__title').fill('from-other.md');
  await expect.poll(() => savedTitle(page)).toBe('from-other.md');

  await late.locator('.input-card__title').fill('from-late.md');
  await expect(late.getByRole('alert').filter({ hasText: CONFLICT })).toBeVisible();
  expect(await savedTitle(late)).toBe('from-other.md');
});
