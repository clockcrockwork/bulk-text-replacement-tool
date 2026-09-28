import { expect, type Page, test } from '@playwright/test';
import { makeRule, openApp, seedWorkspace } from '../fixtures';
import { GitHubMock, novelRepository } from '../githubMock';

/** スマホ幅で「GitHubから追加」をタップだけで最後まで進められること。 */

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'GitHubから追加' });
}

/** ダイアログが画面幅からはみ出していないか（横スクロールが出ないか）。 */
async function expectFitsWidth(page: Page): Promise<void> {
  const overflow = await dialog(page).evaluate((element) => ({
    dialog: element.getBoundingClientRect().right,
    viewport: window.innerWidth,
    scroll: element.scrollWidth - element.clientWidth,
  }));
  expect(overflow.dialog).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.scroll).toBeLessThanOrEqual(0);
}

test('スマホ幅でもタップで GitHub から1ファイル取り込める', async ({ page }) => {
  const mock = new GitHubMock([novelRepository()]);
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [makeRule('r1', 'アリス', { g1: 'あーちゃん' })],
  });
  await openApp(page);

  await page.getByRole('button', { name: 'GitHubから追加' }).tap();
  await expectFitsWidth(page);
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).tap();
  await dialog(page).getByRole('button', { name: 'octo/novel' }).tap();
  await dialog(page)
    .getByRole('button', { name: /^chapters\// })
    .tap();
  await expectFitsWidth(page);

  // 一覧の1行はタッチの最小サイズ（44px）を確保する。
  const heights = await dialog(page)
    .locator('.github__entry')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);

  await dialog(page)
    .getByRole('button', { name: /^ch1\.md/ })
    .tap();
  // 本文の確認欄も iOS Safari の自動ズームを避ける大きさにする。
  const previewSize = await dialog(page)
    .getByRole('textbox', { name: '取り込む本文' })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(previewSize).toBeGreaterThanOrEqual(16);
  await expectFitsWidth(page);

  await dialog(page).getByRole('button', { name: '入力に追加' }).tap();
  await expect(page.locator('.input-card__source')).toContainText('chapters/ch1.md');
});

test('スマホ幅でもフォルダをチェックして複数ファイルをまとめて取り込める', async ({ page }) => {
  const mock = new GitHubMock([novelRepository()]);
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);

  await page.getByRole('button', { name: 'GitHubから追加' }).tap();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).tap();
  await dialog(page).getByRole('button', { name: 'octo/novel' }).tap();

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  const tapTarget = chapters.locator('..');
  const size = await tapTarget.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);

  // iOS Safari はフォーカスした入力欄の文字が 16px 未満だと自動で拡大する。
  const filterSize = await dialog(page)
    .getByRole('searchbox', { name: 'このフォルダを絞り込み' })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(filterSize).toBeGreaterThanOrEqual(16);

  await chapters.tap();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).tap();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan.getByRole('heading', { name: '2ファイルが見つかりました' })).toBeVisible();
  await expectFitsWidth(page);
  await plan.getByRole('button', { name: '2ファイルを取得' }).tap();
  await expectFitsWidth(page);

  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch).toContainText('chapters/ch1.md');
  await expect(batch).toContainText('chapters/ch2.txt');
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).tap();

  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__source')).toHaveText([
    /chapters\/ch1\.md/,
    /chapters\/ch2\.txt/,
  ]);
});

// 320px は WCAG のリフローの基準幅で、保証する最も狭い画面として扱う。
test.describe('320px 幅の端末', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('件数入りの長いまとめ操作とページ送りも、画面幅に収まる', async ({ page }) => {
    const files = Array.from({ length: 250 }, (_, index) => ({
      path: `many/f${String(index).padStart(3, '0')}.md`,
      content: `新しい${index}\n`,
    }));
    const repository = novelRepository({ branches: { main: files } });
    const mock = new GitHubMock([repository]);
    const sourceOf = (path: string) => ({
      kind: 'github' as const,
      repositoryId: repository.id,
      owner: repository.owner,
      repo: repository.name,
      ref: 'main',
      commitSha: 'a'.repeat(40),
      path,
      blobSha: 'b'.repeat(40),
    });
    // どの候補にも同じ取り込み元の入力が1件ずつある（まとめ操作が2つとも出る）。
    const inputs = files.map((file, index) => ({
      id: `old${index}`,
      title: `old-${index}.md`,
      text: '古い\n',
      source: sourceOf(file.path),
    }));
    await mock.install(page);
    await seedWorkspace(page, { inputs, groups: [{ id: 'g1', name: 'A用' }], rules: [] });
    await openApp(page);

    await page.getByRole('button', { name: 'GitHubから追加' }).tap();
    await dialog(page).getByRole('button', { name: 'GitHubに接続' }).tap();
    await dialog(page).getByRole('button', { name: 'octo/novel' }).tap();
    await dialog(page).getByRole('checkbox', { name: 'many フォルダを選択' }).tap();
    await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).tap();
    await dialog(page).getByRole('button', { name: '250ファイルを取得' }).tap();

    const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
    const bulk = [
      batch.getByRole('button', { name: '更新先が1件の250件をすべて更新' }),
      batch.getByRole('button', { name: '未決定の250件をすべて別の入力として追加' }),
      batch.getByRole('button', { name: '次の100件' }),
    ];
    for (const button of bulk) await expect(button).toBeVisible();
    await expectFitsWidth(page);
    // ボタンの文言は折り返して確認画面の幅に収まる。ダイアログ自体は余白の分だけ広いので、
    // ダイアログの横スクロールだけを見ていると、余白へのはみ出しを見逃す。
    for (const button of bulk) {
      const fits = await button.evaluate((element) => {
        const region = element.closest('section')?.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return (
          region !== undefined &&
          element.scrollWidth <= element.clientWidth &&
          rect.left >= region.left &&
          rect.right <= region.right
        );
      });
      expect(fits).toBe(true);
    }

    await bulk[0]?.tap();
    await batch.getByRole('button', { name: '250ファイルを取り込む' }).tap();
    await expect(page.locator('.input-card')).toHaveCount(250);
  });
});
