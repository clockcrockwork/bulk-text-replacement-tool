import { expect, test } from '@playwright/test';
import { goToTab, makeRule, openApp, seedWorkspace } from './fixtures';

/**
 * README の「入力したテキストとルールは外部へ送信されません」を不変条件として固定する。
 *
 * 宛先ホストだけを見ていると、同一オリジンの `/api/log` に原稿を POST するコードが
 * 入っても素通りする。原稿とルールに目印（sentinel）を仕込み、**どのリクエストにも
 * その文字列が現れないこと**を見る。
 */

/** 原稿・ルールに仕込む目印。通常のテキストと衝突しない形にする。 */
const MANUSCRIPT_SENTINEL = 'DO-NOT-LEAK-MANUSCRIPT-6f2a1c';
const RULE_SRC_SENTINEL = 'DO-NOT-LEAK-RULESRC-6f2a1c';
const RULE_VALUE_SENTINEL = 'DO-NOT-LEAK-RULEVALUE-6f2a1c';

/** 接続してよい宛先。フォントの配信元だけ。 */
const ALLOWED_HOSTS = ['127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com'];

test('原稿とルールがどのリクエストにも現れない', async ({ page }) => {
  const leaks: string[] = [];
  const unexpectedHosts: string[] = [];

  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http')) return; // data: や blob: は外部通信ではない

    if (!ALLOWED_HOSTS.includes(new URL(url).hostname)) {
      unexpectedHosts.push(url);
    }

    // URL・ヘッダ・本文のどこに混ぜても気づけるようにする。
    const haystack = [url, JSON.stringify(request.headers()), request.postData() ?? ''].join('\n');
    for (const sentinel of [MANUSCRIPT_SENTINEL, RULE_SRC_SENTINEL, RULE_VALUE_SENTINEL]) {
      if (haystack.includes(sentinel)) leaks.push(`${sentinel} → ${url}`);
    }
  });

  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'secret.md', text: `${MANUSCRIPT_SENTINEL}を含む本文` }],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [makeRule('r1', RULE_SRC_SENTINEL, { g1: RULE_VALUE_SENTINEL })],
  });
  await openApp(page);

  // 入力・ルール・変換・出力まで一通り動かしてから判定する。
  await goToTab(page, 'ルール');
  await goToTab(page, '入力');
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card__path')).toBeVisible();

  expect(leaks, '原稿またはルールが外部リクエストに含まれている').toEqual([]);
  expect(unexpectedHosts, '許可していない宛先への通信').toEqual([]);
});

test('CSP が fetch と XHR を塞いでいる', async ({ page }) => {
  await openApp(page);

  // connect-src 'none' が効いていれば、ページ内から外へは出られない。
  const fetchResult = await page.evaluate(async () => {
    try {
      await fetch('/api/anything', { method: 'POST', body: 'x' });
      return 'なぜか成功した';
    } catch (error) {
      return `拒否された: ${(error as Error).name}`;
    }
  });
  expect(fetchResult).toContain('拒否された');

  const xhrResult = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.onerror = () => resolve('拒否された');
        xhr.onload = () => resolve('なぜか成功した');
        try {
          xhr.open('POST', '/api/anything');
          xhr.send('x');
        } catch {
          resolve('拒否された');
        }
      }),
  );
  expect(xhrResult).toBe('拒否された');
});
