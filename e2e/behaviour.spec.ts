import { expect, test } from '@playwright/test';
import { goToTab, makeRule, openApp, seedBasic, seedRawWorkspace, seedWorkspace } from './fixtures';
import { readZipEntries } from './zipReader';

/**
 * 振る舞いを見るテスト。アプリの初回サンプルに依存しないよう、
 * それぞれのテストが必要な状態を localStorage に仕込んでから開く。
 */

const GROUP = { id: 'g1', name: 'G用' };

test.describe('同時と順次の違い', () => {
  test.beforeEach(async ({ page }) => {
    await seedWorkspace(page, {
      inputs: [{ id: 'i1', title: 'a.txt', text: 'A' }],
      groups: [GROUP],
      rules: [makeRule('r1', 'A', { g1: 'a' }), makeRule('r2', 'a', { g1: 'b' })],
    });
    await openApp(page);
  });

  test('同時のままなら置換結果は次のルールに連鎖しない', async ({ page }) => {
    await page.getByRole('button', { name: '変換' }).click();
    await page.getByRole('button', { name: 'テキスト', exact: true }).click();
    await expect(page.locator('.file-card__plain')).toHaveValue('a');
  });

  test('2行目を順次に切り替えると、それまでの結果に対して適用される', async ({ page }) => {
    await goToTab(page, 'ルール');
    const orderToggles = page.getByRole('button', { name: '適用順' });
    await expect(orderToggles.nth(1)).toHaveText('同時');
    await orderToggles.nth(1).click();
    await expect(orderToggles.nth(1)).toHaveText('順次');

    await page.getByRole('button', { name: '変換' }).click();
    await page.getByRole('button', { name: 'テキスト', exact: true }).click();
    await expect(page.locator('.file-card__plain')).toHaveValue('b');
  });
});

// 状態を自前で仕込むので describe の beforeEach とは分ける
// （seed は1回だけ効くため、二重に仕込むと後から書いた方が落ちる）。
test('順次は置換結果と周囲の文字列にまたがる一致も拾う', async ({ page }) => {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'a.txt', text: 'アリスちゃん' }],
    groups: [GROUP],
    rules: [
      makeRule('r1', 'アリス', { g1: 'あー' }),
      makeRule('r2', 'あーちゃん', { g1: 'X' }, { order: 'seq' }),
    ],
  });
  await openApp(page);
  await page.getByRole('button', { name: '変換' }).click();
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  await expect(page.locator('.file-card__plain')).toHaveValue('X');
});

test('ZIP にはグループ名のディレクトリと変換後の本文が入る', async ({ page }) => {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'ch1.md', text: 'アリス' }],
    groups: [
      { id: 'g1', name: 'A用' },
      { id: 'g2', name: 'B用' },
    ],
    rules: [makeRule('r1', 'アリス', { g1: 'あー', g2: 'びー' })],
  });
  await openApp(page);
  await page.getByRole('button', { name: '変換' }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'ZIPですべて保存' }).click(),
  ]);
  const entries = await readZipEntries(await download.path());

  expect(entries).toEqual([
    { name: 'A用/ch1.md', text: 'あー' },
    { name: 'B用/ch1.md', text: 'びー' },
  ]);
});

test('ファイル名に .. が入っていても ZIP の中では無害化される', async ({ page }) => {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: '../../evil.md', text: 'x' }],
    groups: [GROUP],
    rules: [],
  });
  await openApp(page);
  await page.getByRole('button', { name: '変換' }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'ZIPですべて保存' }).click(),
  ]);
  const entries = await readZipEntries(await download.path());
  expect(entries.map((entry) => entry.name)).toEqual(['G用/evil.md']);
});

test('画面を狭めるとルールが自動でカード表示に切り替わる', async ({ page }) => {
  await seedBasic(page);
  await openApp(page);
  await goToTab(page, 'ルール');
  await expect(page.locator('.rule-table')).toHaveCount(1);

  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.locator('.rule-table')).toHaveCount(0);
  await expect(page.locator('.rule-card').first()).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('.rule-table')).toHaveCount(1);
});

test.describe('壊れた保存データからの復帰', () => {
  test('不正な JSON なら初期状態で起動する', async ({ page }) => {
    await seedRawWorkspace(page, '{壊れている');
    await openApp(page);
    // 復旧画面ではなく通常の画面が出ること。中身がサンプルであることは
    // sample.spec.ts の担当なので、ここでは内容に踏み込まない。
    await expect(page.locator('.recovery')).toHaveCount(0);
    await expect(page.locator('.input-card')).toHaveCount(1);
    await goToTab(page, 'ルール');
    await expect(page.locator('.rule-table')).toHaveCount(1);
  });

  test('欠けたフィールドを補って復元し、変換まで通る', async ({ page }) => {
    // 以前はここで描画が例外になり、リロードしても直らなかった。
    await seedRawWorkspace(
      page,
      JSON.stringify({
        inputs: [{ id: 'i1', title: 'kept.md' }],
        groups: [{ id: 'g1' }],
        rules: [{ id: 'r1', src: 'a' }],
      }),
    );
    await openApp(page);
    await expect(page.locator('.input-card__title')).toHaveValue('kept.md');
    await expect(page.locator('.input-card__meta')).toHaveText('0行');

    await page.getByRole('button', { name: '変換' }).click();
    await expect(page.locator('.file-card__path')).toBeVisible();
  });
});

test('プレビューのキャレット位置をエディタへ引き継ぐ', async ({ page }) => {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'a.txt', text: '0123456789' }],
    groups: [GROUP],
    rules: [],
  });
  await openApp(page);

  const preview = page.locator('.input-card__preview');
  await preview.focus();
  await page.evaluate(() => {
    document.querySelector<HTMLTextAreaElement>('.input-card__preview')?.setSelectionRange(5, 5);
  });
  await page.keyboard.press('Enter');

  await expect(page.locator('dialog.editor')).toBeVisible();
  const caret = await page.evaluate(
    () => document.querySelector<HTMLTextAreaElement>('.editor__textarea')?.selectionStart,
  );
  expect(caret).toBe(5);
});

test.describe('ドラッグ＆ドロップ', () => {
  // DataTransfer をスクリプトから組み立てる必要があり、挙動がブラウザで揺れるため
  // Chromium でだけ回す。他のブラウザではファイル選択の経路が同じコードを通る。
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium のみ');

  test('ドラッグ中は案内が出て、ドロップすると取り込まれる', async ({ page }) => {
    await seedBasic(page);
    await openApp(page);

    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['# 落とした'], 'dropped.md', { type: 'text/markdown' }));
      return transfer;
    });

    await page.dispatchEvent('.app', 'dragenter', { dataTransfer });
    await expect(page.locator('.drop-overlay')).toBeVisible();

    await page.dispatchEvent('.app', 'drop', { dataTransfer });
    await expect(page.locator('.drop-overlay')).toHaveCount(0);
    await expect(page.locator('.toast')).toHaveText('1件のファイルを追加しました');
    await expect(page.locator('.input-card__title').nth(1)).toHaveValue('dropped.md');
  });

  test('ドラッグしたまま枠外で終わっても案内が残らない', async ({ page }) => {
    await seedBasic(page);
    await openApp(page);
    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'a.md', { type: 'text/markdown' }));
      return transfer;
    });

    await page.dispatchEvent('.app', 'dragenter', { dataTransfer });
    await expect(page.locator('.drop-overlay')).toBeVisible();

    await page.dispatchEvent('body', 'dragend', { dataTransfer });
    await expect(page.locator('.drop-overlay')).toHaveCount(0);
  });
});
