import type { Page } from '@playwright/test';
import { STORAGE_KEY } from '../src/lib/storage';
import type { Group, InputText, Rule, Theme } from '../src/types';

export interface SeedWorkspace {
  inputs: InputText[];
  groups: Group[];
  rules: Rule[];
  theme?: Theme;
}

/**
 * テスト専用の状態を localStorage に仕込んでから開く。
 *
 * これを使わないと、アプリの初回サンプル（chapter1.md / アリス / ビル）が
 * 暗黙の fixture になり、オンボーディング用の文言を変えただけで広範囲の
 * テストが壊れる。サンプルそのものを見たいテストだけ `openApp` を使う。
 */
export async function seedWorkspace(page: Page, workspace: SeedWorkspace): Promise<void> {
  await seedRawWorkspace(page, JSON.stringify({ theme: 'light', ...workspace }));
}

/** 保存データを文字列のまま仕込む。壊れたデータからの復旧を見るテスト用。 */
export async function seedRawWorkspace(page: Page, raw: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [STORAGE_KEY, raw] as const,
  );
}

/** アプリを開く。seedWorkspace を先に呼んでいなければ初回サンプルで始まる。 */
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

/** 置換ルールを1行作る。 */
export function makeRule(
  id: string,
  src: string,
  values: Record<string, string>,
  overrides: Partial<Pick<Rule, 'regex' | 'cs' | 'order'>> = {},
): Rule {
  return { id, src, regex: false, cs: true, order: 'sim', values, ...overrides };
}
