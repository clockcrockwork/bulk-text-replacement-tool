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

/**
 * 保存データを文字列のまま仕込む。壊れたデータからの復旧を見るテスト用。
 *
 * 仕込むのは最初の1回だけ。init script は読み込みのたびに走るので、素朴に書くと
 * リロードのたびに書き戻してしまい、「保存された内容がリロード後も残るか」
 * 「消したら消えたままか」を確かめられない。同じタブの中だけ残る sessionStorage を
 * 目印に使う。
 */
export async function seedRawWorkspace(page: Page, raw: string): Promise<void> {
  await page.addInitScript(
    ([key, value, flag]) => {
      if (sessionStorage.getItem(flag)) return;
      sessionStorage.setItem(flag, '1');
      localStorage.setItem(key, value);
    },
    [STORAGE_KEY, raw, 'e2e-seeded'] as const,
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

/**
 * 多くの spec が共有する、テスト側が持つ標準の状態。
 *
 * アプリの初回サンプルをそのまま fixture にすると、オンボーディング用の文言を
 * 変えただけで広範囲のテストが落ちる（実際に落ちた）。サンプルの内容と
 * テストの前提を切り離すため、テスト用のデータはここで持つ。
 *
 * ルールの3行目は意図的に空。表に「入力可能な空行が1本ある」状態を作る。
 */
export const BASIC_GROUPS: Group[] = [
  { id: 'g1', name: 'A用' },
  { id: 'g2', name: 'B用' },
];

export const BASIC_INPUT: InputText = {
  id: 'i1',
  title: 'story.md',
  text: 'アリスとビルが並ぶ。アリスは笑った。\n',
};

export const BASIC_RULES: Rule[] = [
  makeRule('r1', 'アリス', { g1: 'あーちゃん', g2: 'びーちゃん' }),
  makeRule('r2', 'ビル', { g1: 'びる', g2: 'れいちゃん' }),
  makeRule('r3', '', {}),
];

/** 標準の状態を仕込む。`openApp` は呼び出し側で行う。 */
export async function seedBasic(page: Page): Promise<void> {
  await seedWorkspace(page, {
    inputs: [BASIC_INPUT],
    groups: BASIC_GROUPS,
    rules: BASIC_RULES,
  });
}
