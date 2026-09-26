import { expect, test } from '@playwright/test';
import { goToTab, openApp } from './fixtures';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('ファイルを選ぶと入力として取り込まれ、対応外の拡張子はスキップされる', async ({ page }) => {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([
      { name: 'a.md', mimeType: 'text/markdown', buffer: Buffer.from('# あ\n') },
      { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('い') },
      { name: 'c.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
    ]);

  await expect(page.locator('.toast')).toHaveText(
    '2件のファイルを追加しました · 1件は非対応形式のためスキップ',
  );
  // 手つかずのサンプルではなく中身があるので、既存の入力は残る。
  await expect(page.locator('.input-card')).toHaveCount(3);
  await expect(page.locator('.input-card__title').nth(1)).toHaveValue('a.md');
});

test('本文をクリックすると全画面エディタが開き、編集が反映される', async ({ page }) => {
  await page.locator('.input-card__preview').click();
  await expect(page.locator('.editor')).toBeVisible();
  await expect(page.locator('.editor__meta-pos')).toHaveText('1 / 1');

  await page.locator('.editor__textarea').fill('書き換えた本文');
  await page.getByRole('button', { name: '完了' }).click();

  await expect(page.locator('.editor')).toHaveCount(0);
  await expect(page.locator('.input-card__preview')).toHaveValue('書き換えた本文');
  await expect(page.locator('.input-card__meta')).toHaveText('7 文字 · 1 行');
});

test('エディタは Escape でも閉じられる', async ({ page }) => {
  await page.locator('.input-card__preview').click();
  await expect(page.locator('.editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.editor')).toHaveCount(0);
});

test('エディタは本物のモーダルで、フォーカスが背面へ抜けない', async ({ page }) => {
  await page.locator('.input-card__preview').click();
  const dialog = page.locator('dialog.editor');
  await expect(dialog).toBeVisible();

  // 開いた直後は本文にフォーカスがある
  await expect(page.locator('.editor__textarea')).toBeFocused();

  // 背面の操作要素にフォーカスが移らないこと。
  // タブ順が一周する瞬間は document.body を通るので、それは外へ出たとは見なさない。
  const focusedOutside = async (): Promise<string | null> =>
    page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      return active.closest('dialog.editor') ? null : active.className || active.tagName;
    });

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await focusedOutside(), `Tab ${i + 1} 回目`).toBeNull();
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focusedOutside(), `Shift+Tab ${i + 1} 回目`).toBeNull();
  }

  // 背面の要素は inert 扱いなので、プログラムから focus() しても受け取らない
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('.app-header .btn--primary')?.focus();
  });
  expect(await focusedOutside(), '背面のボタンへ focus() したとき').toBeNull();
});

test('エディタを閉じると起点のプレビューへフォーカスが戻る', async ({ page }) => {
  await page.locator('.input-card__preview').click();
  await expect(page.locator('dialog.editor')).toBeVisible();

  await page.getByRole('button', { name: '完了' }).click();
  await expect(page.locator('dialog.editor')).toHaveCount(0);
  await expect(page.locator('.input-card__preview')).toBeFocused();
});

test('テキスト欄を追加するとそのままエディタが開く', async ({ page }) => {
  await page.getByRole('button', { name: 'テキスト欄を追加' }).click();
  await expect(page.locator('.editor')).toBeVisible();
  await expect(page.locator('.editor__title')).toHaveValue('text-2.txt');

  await page.locator('.editor__textarea').fill('新しい原稿');
  await page.getByRole('button', { name: '完了' }).click();
  await expect(page.locator('.input-card')).toHaveCount(2);
});

test('エディタから前後のテキストへ移動できる', async ({ page }) => {
  await page.getByRole('button', { name: 'テキスト欄を追加' }).click();
  await page.locator('.editor__textarea').fill('2つめ');
  await expect(page.locator('.editor__meta-pos')).toHaveText('2 / 2');

  await page.getByRole('button', { name: '前のテキスト' }).click();
  await expect(page.locator('.editor__title')).toHaveValue('chapter1.md');
  await expect(page.getByRole('button', { name: '前のテキスト' })).toBeDisabled();

  await page.getByRole('button', { name: '次のテキスト' }).click();
  await expect(page.locator('.editor__textarea')).toHaveValue('2つめ');
});

test('入力とルールはリロード後も残る', async ({ page }) => {
  await page.locator('.input-card__title').fill('renamed.md');
  await goToTab(page, 'ルール');
  await page.locator('[data-cell="0:1"]').fill('ありす');

  // 保存はデバウンスしているので、書き込まれるまで待つ。
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('bt-bulk-replace-v1') ?? ''))
    .toContain('ありす');

  await page.reload();
  await expect(page.locator('.input-card__title')).toHaveValue('renamed.md');
  await goToTab(page, 'ルール');
  await expect(page.locator('[data-cell="0:1"]')).toHaveValue('ありす');
});

test('テーマを切り替えると html の data-theme が変わり、リロード後も維持される', async ({
  page,
}) => {
  const initial = await page.getAttribute('html', 'data-theme');
  await page.getByRole('button', { name: 'テーマ切替' }).click();
  const toggled = initial === 'dark' ? 'light' : 'dark';
  await expect(page.locator('html')).toHaveAttribute('data-theme', toggled);

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('bt-bulk-replace-v1') ?? ''))
    .toContain(`"theme":"${toggled}"`);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', toggled);
});
