import type { Page } from '@playwright/test';

/**
 * 初期状態（サンプルの入力1件 + ルール2行 + グループ2つ）でアプリを開く。
 * localStorage はテストごとに空なので、毎回サンプルから始まる。
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.brand__name');
}

/** タブを切り替える。 */
export async function goToTab(page: Page, label: '入力' | 'ルール' | '出力'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
}

/** ルール表のセル（行, 列）。列0が置換元、列1以降がグループ。 */
export function cell(page: Page, row: number, col: number) {
  return page.locator(`[data-cell="${row}:${col}"]`);
}
