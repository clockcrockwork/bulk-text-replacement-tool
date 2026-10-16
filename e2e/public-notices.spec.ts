import { expect, test } from '@playwright/test';

test('公開画面からプライバシーと第三者ライセンスに到達できる', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo', { name: '公開情報' });
  await expect(footer.getByRole('link', { name: 'データの取扱い' })).toHaveAttribute(
    'href',
    '/privacy.html',
  );
  await expect(footer.getByRole('link', { name: '第三者ライセンス' })).toHaveAttribute(
    'href',
    '/licenses.html',
  );

  await page.goto('/privacy.html');
  await expect(page.getByRole('heading', { name: 'データの取扱い' })).toBeVisible();
  await expect(page.getByText('GitHubからの取り込み（任意）')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('TODO');

  await page.goto('/licenses.html');
  await expect(page.getByRole('heading', { name: '第三者ライセンス' })).toBeVisible();
  await expect(page.getByRole('link', { name: /第三者ライセンス全文/ })).toHaveAttribute(
    'href',
    '/third-party-notices.txt',
  );
  await page.goto('/third-party-notices.txt');
  await expect(page.locator('body')).toContainText('Lucide icons (ISC + Feather-derived icons MIT)');
  await expect(page.locator('body')).toContainText('SIL OPEN FONT LICENSE');
});
