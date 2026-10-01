import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page, type Request, type Route, test } from '@playwright/test';
import { PENDING_AUTH_KEY } from '../src/lib/githubAuth';
import { STORAGE_KEY } from '../src/lib/storage';
import { goToTab, makeRule, openApp, seedWorkspace } from './fixtures';
import {
  E2E_APP_SLUG,
  E2E_CLIENT_ID,
  E2E_CODE,
  E2E_REFRESH_TOKEN,
  E2E_TOKEN,
  GitHubMock,
  novelRepository,
} from './githubMock';

/**
 * 「GitHubから追加」: 同意 → PKCE 認可 → リポジトリ → ブランチ（コミット固定）→
 * フォルダを辿って1ファイル → 入力に追加、の流れ。GitHub は `GitHubMock` で置き換える。
 */

const REPO = novelRepository();

const MiB = 1024 * 1024;

async function seed(page: Page): Promise<void> {
  await seedWorkspace(page, {
    inputs: [{ id: 'i1', title: 'local.md', text: 'ローカルの原稿\n' }],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [makeRule('r1', 'アリス', { g1: 'あーちゃん' })],
  });
}

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'GitHubから追加' });
}

/** 同意画面から接続し、リポジトリの一覧が出るところまで進める。 */
async function connect(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toBeVisible();
}

/** リポジトリを選んで、既定ブランチのルートが開くまで。 */
async function openRepository(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeVisible();
}

function entry(page: Page, name: string) {
  return dialog(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

/**
 * 選択を列挙して計画画面で件数を確かめ、取得して、取り込み方法の確認画面を返す。
 * 取得（blob）は計画画面で「取得」を押すまで始まらない。
 */
async function fetchSelection(page: Page, files: number) {
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(
    plan.getByRole('heading', { name: `${files}ファイルが見つかりました` }),
  ).toBeVisible();
  await plan.getByRole('button', { name: `${files}ファイルを取得` }).click();
  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  // 確認画面が出るまで待つ（取得はそこで終わっている）。押した直後に返すと、呼び出し側が
  // blob の要求を数えたときに、まだ出ていない要求を取りこぼす。
  await expect(batch).toBeVisible();
  return batch;
}

/**
 * 条件に合う GitHub API の要求を、`release` まで応答させずに止めておく。
 * 止めている間に中断された要求は `failed` に入る（`requestfailed` で数える）。
 * 待ち時間で近似せず、中断が実際に起きたかを確かめるために使う。
 *
 * `release` でルートとリスナーを外す。Playwright の `unroute` は関数の matcher を
 * 参照の同一性でしか照合しないので、`route` と同じ関数を渡す（別に書くと何も外れない）。
 */
async function hold(page: Page, pattern: RegExp) {
  const held: string[] = [];
  const failed: string[] = [];
  let open = (): void => {};
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  const matcher = (url: URL): boolean =>
    url.origin === 'https://api.github.com' && pattern.test(url.href);
  const handler = async (route: Route): Promise<void> => {
    held.push(route.request().url());
    await released;
    // 中断済みの要求は応答できない（それで正しい）。
    await route.fallback().catch(() => {});
  };
  const onFailed = (request: Request): void => {
    if (pattern.test(request.url())) failed.push(request.url());
  };
  page.on('requestfailed', onFailed);
  await page.route(matcher, handler);
  return {
    held,
    failed,
    release: async (): Promise<void> => {
      open();
      page.off('requestfailed', onFailed);
      await page.unroute(matcher, handler);
    },
  };
}

async function start(page: Page, mock: GitHubMock): Promise<void> {
  await mock.install(page);
  await seed(page);
  await openApp(page);
}

test('接続前に同意画面を出し、読み取り専用であることと保存しないことを説明する', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();

  const consent = dialog(page).getByRole('region', { name: 'GitHub との接続' });
  await expect(consent).toContainText('読み取り専用');
  await expect(consent).toContainText('リポジトリ単位');
  await expect(consent).toContainText(
    '再読み込み・タブを閉じる・ほかのページへ移動したあとは、もう一度接続が必要',
  );
  // 取得するもの（一覧のためのメタデータと、選んだファイルの本文だけ）と、残るもの（出自）。
  await expect(consent).toContainText('リポジトリ・ブランチ・フォルダの情報');
  await expect(consent).toContainText('本文を取得するのは、この画面で選んだファイルだけ');
  await expect(consent).toContainText('owner/repo・ブランチ・パス・コミットの SHA');
  await expect(consent).toContainText('localStorage');
  await expect(consent).toContainText('作業データの書き出しにも含まれます');
  // 同意するまでは GitHub にもバックエンドにも何も送らない。
  expect(mock.requests.filter((request) => /github\.com|\/api\//.test(request.url))).toEqual([]);

  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('PKCE（S256）と state で認可を始め、戻ったら URL と一時情報を片付ける', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);

  // 認可 URL
  expect(mock.authorizeCalls).toHaveLength(1);
  const authorize = mock.authorizeCalls[0];
  expect(authorize?.get('client_id')).toBe(E2E_CLIENT_ID);
  expect(authorize?.get('redirect_uri')).toBe('http://127.0.0.1:4173/');
  expect(authorize?.get('code_challenge_method')).toBe('S256');
  expect(authorize?.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // 交換に送ったのは code / verifier / redirect_uri の3つだけで、verifier は challenge と対応する。
  expect(mock.tokenCalls).toHaveLength(1);
  const sent = JSON.parse(mock.tokenCalls[0] ?? '{}') as Record<string, string>;
  expect(Object.keys(sent).sort()).toEqual(['code', 'code_verifier', 'redirect_uri']);
  expect(sent.code).toBe(E2E_CODE);
  expect(sent.redirect_uri).toBe('http://127.0.0.1:4173/');
  const challenge = createHash('sha256')
    .update(sent.code_verifier ?? '')
    .digest('base64url');
  expect(challenge).toBe(authorize?.get('code_challenge'));
  // Function は Origin を許可リストと照合する。Referrer-Policy は Origin にも効き、
  // `null` になると本番の交換が 403 で止まるので、配信時のヘッダの下で付いていることを見る。
  expect(mock.tokenOrigins).toEqual(['http://127.0.0.1:4173']);

  // アドレスバーから code / state が消え、一時情報も残らない。
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();

  // API には固定した版とトークンを付けて行く。
  const call = mock.apiCalls(/^\/user\/installations$/)[0];
  expect(call?.headers.authorization).toBe(`Bearer ${E2E_TOKEN}`);
  // GitHub の CORS が許可していないヘッダは付けない（付けると本番の preflight で止まる）。
  expect(call?.headers['x-github-api-version']).toBeUndefined();
});

test('認可から戻った直後の読み込みで、code と state を Referer に載せない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);

  // 戻り先の HTML は `/?code=…&state=…` のまま開かれ、`history.replaceState` を走らせる JS
  // そのものを読む要求には、まだその URL が Referer として付き得る。同一オリジンの要求にも
  // クエリを載せない方針（Referrer-Policy: strict-origin）を、実際の要求で確かめる。
  // route を張るとブラウザのキャッシュが効かなくなり、戻りの読み込みでも要求が必ず出る。
  const referers: { url: string; referer: string | null }[] = [];
  await page.route('http://127.0.0.1:4173/**', async (route) => {
    const request = route.request();
    referers.push({ url: request.url(), referer: await request.headerValue('referer') });
    await route.fallback();
  });

  await connect(page);

  // 戻りの読み込みで、同一オリジンの JS を取りに行っていること（何も見ずに通らないように）。
  // 戻りの要求そのものを捕まえていなければ、以降の検証は初回の読み込みを見ているだけになる。
  const callbackIndex = referers.findIndex((entry) => entry.url.includes(`code=${E2E_CODE}`));
  expect(callbackIndex).toBeGreaterThanOrEqual(0);
  const afterCallback = referers.slice(callbackIndex + 1);
  expect(afterCallback.some((entry) => /\/assets\/.+\.js$/.test(entry.url))).toBe(true);
  for (const { url, referer } of referers) {
    expect(referer ?? '', url).not.toContain('code=');
    expect(referer ?? '', url).not.toContain('state=');
  }
});

/**
 * bfcache への出入りを起こす。
 *
 * Playwright の Chromium は `--disable-back-forward-cache` で起動し、route で差し替えた
 * 要求があるページも bfcache に載らないので、本物の「戻る」では再現できない。
 * ページが受け取るのと同じ `persisted` 付きの pagehide / pageshow を送り、アプリの
 * 片付けがつながっていることを確かめる（実機の「戻る」は手で確かめる）。
 */
async function leaveAndComeBack(page: Page, persisted: boolean): Promise<void> {
  await page.evaluate((flag) => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: flag }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: flag }));
  }, persisted);
}

test('接続したまま bfcache に入ると接続を解除し、戻っても前の接続では読めない', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);

  // タブを離れずにページが残る（persisted でない）遷移の合図では切らない。
  await leaveAndComeBack(page, false);
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toBeVisible();

  const callsBefore = mock.requests.length;
  await leaveAndComeBack(page, true);

  // 同意画面へ戻り、理由を知らせる。リポジトリの一覧は出ない。
  const consent = dialog(page).getByRole('region', { name: 'GitHub との接続' });
  await expect(consent.getByRole('alert')).toContainText('ページを離れたため');
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();
  // 閉じて開き直しても、前のトークンで GitHub へ取りに行かない。
  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeVisible();
  expect(mock.requests.slice(callsBefore)).toEqual([]);
});

test('トークン交換の途中で bfcache に入ったら、あとから返った交換の結果で接続し直さない', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);

  // 交換の応答を止めておく（モックより後に張った route が先に効く）。
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => {};
  const exchangeStarted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route('**/api/github/token', async (route) => {
    reached();
    await held;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await exchangeStarted;

  await leaveAndComeBack(page, true);
  release();

  // 交換は返ってくるが、その結果でトークンを持ち直さない（一覧を取りに行かない）。
  await expect.poll(() => mock.tokenCalls.length).toBe(1);
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toHaveCount(0);
  expect(mock.apiCalls(/^\/user\/installations$/)).toEqual([]);
});

test('アクセストークンはどこにも保存せず、再読み込みすると接続し直しになる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);

  const stored = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(stored).not.toContain(E2E_TOKEN);
  expect(stored).not.toContain(E2E_REFRESH_TOKEN);
  expect(stored).not.toContain(E2E_CODE);

  // 作業データの書き出しにも載らない。
  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  const saved = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(saved ?? '').not.toContain(E2E_TOKEN);

  await page.reload();
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeVisible();
});

test('GitHub から追加した直後（保存のデバウンス中）に再読み込みしても、追加した入力は残る', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  // 時計を止めて、デバウンス（400ms）の保存が走らないうちに再読み込みする状況を確実に作る。
  // 残るのは、離れるとき（pagehide / visibilitychange）の書き出しが最新の内容を書いた場合だけ。
  await page.clock.install();
  await openApp(page);
  await page.clock.pauseAt(Date.now() + 60_000);
  await connect(page);
  await openRepository(page);
  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();
  await dialog(page)
    .getByRole('region', { name: '取り込む内容の確認' })
    .getByRole('button', { name: '入力に追加' })
    .click();
  await expect(page.locator('.input-card')).toHaveCount(2);

  await page.reload();
  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card').nth(1).locator('.input-card__title')).toHaveValue(
    'ch1.md',
  );
});

test('リポジトリ → 既定ブランチの固定 → フォルダ → 1ファイルを入力に追加し、変換に使える', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  // 既定ブランチの HEAD で固定したことを見せる。
  const head = mock.headOf(REPO.id, 'main');
  await expect(dialog(page).locator('.github__facts')).toContainText('main');
  await expect(dialog(page).locator('.github__facts')).toContainText(head.slice(0, 7));
  // 「閉じる」では接続が残ることを、共用の端末を想定して見せる。
  await expect(dialog(page).locator('.github__session-note')).toContainText(
    '「閉じる」では、このタブの GitHub との接続は残ります',
  );

  // ルートは非再帰の tree で取り、フォルダを開くと次の階層を取りに行く。
  await expect(entry(page, 'chapters/')).toBeVisible();
  await entry(page, 'chapters/').click();
  await expect(dialog(page).getByRole('navigation', { name: '現在の場所' })).toContainText(
    'chapters',
  );

  // 選べないものは理由付きで並ぶ。
  const list = dialog(page).locator('.github__list');
  await expect(list.locator('.is-disabled', { hasText: 'cover.png' })).toContainText(
    '非対応の形式',
  );
  await expect(list.locator('.is-disabled', { hasText: 'link.md' })).toContainText(
    'シンボリックリンク',
  );

  await entry(page, 'ch1.md').click();
  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm.getByRole('textbox', { name: '取り込む本文' })).toHaveValue(
    'アリスは川辺に座っていた。\n',
  );
  await expect(confirm).toContainText(`octo/novel の main（${head.slice(0, 7)}）: chapters/ch1.md`);
  await confirm.getByRole('button', { name: '入力に追加' }).click();

  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('GitHub から ch1.md を追加しました');
  const card = page.locator('.input-card').nth(1);
  await expect(card.locator('.input-card__title')).toHaveValue('ch1.md');
  await expect(card.locator('.input-card__source')).toContainText('octo/novel · chapters/ch1.md');

  // 普通の入力として変換に使える。
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card', { hasText: 'ch1.md' })).toContainText(
    'あーちゃんは川辺に座っていた。',
  );

  // 固定したコミットの tree / blob だけを読んでいる。
  const rootTree = mock.treeOf(head);
  expect(mock.apiCalls(new RegExp(`/git/trees/${rootTree}$`))).toHaveLength(1);
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(1);

  // 出自は保存データにも残る（リロード後も GitHub 由来と分かる）。
  await page.reload();
  await expect(page.locator('.input-card').nth(1).locator('.input-card__source')).toContainText(
    'chapters/ch1.md',
  );
});

test('フォルダ選択を未展開の子へ継承し、子を外すと親が mixed になる。絞り込みでも選択は消えない', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  await chapters.check();
  await entry(page, 'chapters/').click();

  const ch1 = dialog(page).getByRole('checkbox', { name: 'ch1.md を選択' });
  const ch2 = dialog(page).getByRole('checkbox', { name: 'ch2.txt を選択' });
  await expect(ch1).toBeChecked();
  await expect(ch2).toBeChecked();
  await ch2.uncheck();

  const filter = dialog(page).getByRole('searchbox', { name: 'このフォルダを絞り込み' });
  await filter.fill('ch2');
  await expect(entry(page, 'ch1.md')).toHaveCount(0);

  await dialog(page)
    .getByRole('navigation', { name: '現在の場所' })
    .getByRole('button', { name: 'novel' })
    .click();
  await expect(chapters).toBeChecked({ indeterminate: true });

  const batch = await fetchSelection(page, 1);
  await expect(batch).toContainText('chapters/ch1.md');
  await expect(batch).not.toContainText('chapters/ch2.txt');
  await batch.getByRole('button', { name: '1ファイルを取り込む' }).click();

  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__source').nth(0)).toContainText('chapters/ch1.md');
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(1);
});

test('checkbox はキーボードで操作でき、mixed はネイティブの indeterminate で伝える', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  await chapters.focus();
  await page.keyboard.press('Space');
  await expect(chapters).toBeChecked();

  await entry(page, 'chapters/').click();
  const ch2 = dialog(page).getByRole('checkbox', { name: 'ch2.txt を選択' });
  await ch2.focus();
  await page.keyboard.press('Space');
  await expect(ch2).not.toBeChecked();

  await dialog(page)
    .getByRole('navigation', { name: '現在の場所' })
    .getByRole('button', { name: 'novel' })
    .click();
  await expect(chapters).toBeChecked({ indeterminate: true });
  // 状態は indeterminate から伝わるので、食い違い得る aria-checked は付けない。
  await expect(chapters).not.toHaveAttribute('aria-checked');
});

test('複数選択の列挙は recursive tree を fast path として使う', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const before = mock.requests.length;
  const batch = await fetchSelection(page, 2);
  await expect(batch).toContainText('chapters/ch1.md');
  await expect(batch).toContainText('chapters/ch2.txt');

  const batchTreeCalls = mock.requests
    .slice(before)
    .filter((request) => request.url.includes('/git/trees/'));
  expect(batchTreeCalls.some((request) => request.url.includes('recursive=1'))).toBe(true);
  expect(batchTreeCalls.filter((request) => !request.url.includes('recursive=1'))).toHaveLength(0);
});

test('recursive tree が truncated なら partial list を捨て、非再帰 traversal で完全列挙する', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  mock.recursiveTreeTruncations = 1;
  const before = mock.requests.length;
  const batch = await fetchSelection(page, 2);
  await expect(batch).toContainText('chapters/ch1.md');
  await expect(batch).toContainText('chapters/ch2.txt');

  const batchTreeCalls = mock.requests
    .slice(before)
    .filter((request) => request.url.includes('/git/trees/'));
  expect(batchTreeCalls.some((request) => request.url.includes('recursive=1'))).toBe(true);
  expect(batchTreeCalls.some((request) => !request.url.includes('recursive=1'))).toBe(true);
});

test('recursive tree が 5xx なら、失敗にせず非再帰 traversal で完全列挙する', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  mock.recursiveTreeServerErrors = 1;
  const before = mock.requests.length;
  const batch = await fetchSelection(page, 2);
  await expect(batch).toContainText('chapters/ch1.md');
  await expect(batch).toContainText('chapters/ch2.txt');

  const batchTreeCalls = mock.requests
    .slice(before)
    .filter((request) => request.url.includes('/git/trees/'));
  // 再帰は最初の1回だけ。以降は1階層ずつ辿る。
  expect(batchTreeCalls.filter((request) => request.url.includes('recursive=1'))).toHaveLength(1);
  expect(batchTreeCalls.some((request) => !request.url.includes('recursive=1'))).toBe(true);
});

test('複数取得の途中でblobが1件でも失敗したら入力を1件も変更せず、再試行後にまとめて反映する', async ({
  page,
}) => {
  const repository = novelRepository({
    branches: {
      main: [
        { path: 'one.md', content: 'one\n' },
        { path: 'two.md', content: 'two\n' },
      ],
    },
  });
  const mock = new GitHubMock([repository]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'one.md を選択' }).check();
  await dialog(page).getByRole('checkbox', { name: 'two.md を選択' }).check();
  mock.failPaths = ['/git/blobs/'];

  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await plan.getByRole('button', { name: '2ファイルを取得' }).click();
  const failure = dialog(page).getByRole('alert');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText(/one\.md|two\.md/);
  await expect(page.locator('.input-card')).toHaveCount(1);

  mock.failPaths = [];
  await dialog(page).getByRole('button', { name: '再試行' }).click();
  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch).toContainText('2ファイルを取り込む');
  await expect(page.locator('.input-card')).toHaveCount(1);

  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(3);
});

test('batch で同じsourceが複数あると更新先を推測せず、明示するまで確定できない', async ({
  page,
}) => {
  const repository = novelRepository({
    branches: {
      main: [{ path: 'chapters/ch1.md', content: '新しい本文\n' }],
    },
  });
  const mock = new GitHubMock([repository]);
  const oldSource = {
    kind: 'github' as const,
    repositoryId: repository.id,
    owner: repository.owner,
    repo: repository.name,
    ref: 'main',
    commitSha: 'a'.repeat(40),
    path: 'chapters/ch1.md',
    blobSha: 'b'.repeat(40),
  };
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [
      { id: 'old-1', title: 'custom-one.md', text: '古い1\n', source: oldSource },
      { id: 'old-2', title: 'custom-two.md', text: '古い2\n', source: oldSource },
    ],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 1);
  const decision = batch.getByRole('combobox', { name: 'chapters/ch1.md の取り込み方法' });
  await expect(decision).toHaveValue('');
  const commitButton = batch.getByRole('button', { name: '1ファイルを取り込む' });
  await expect(commitButton).toBeDisabled();

  await decision.selectOption('update:old-2');
  await expect(commitButton).toBeEnabled();
  await commitButton.click();

  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card').nth(0).locator('.input-card__title')).toHaveValue(
    'custom-one.md',
  );
  await expect(page.locator('.input-card').nth(1).locator('.input-card__title')).toHaveValue(
    'custom-two.md',
  );
  await expect(page.locator('.input-card').nth(1).locator('.input-card__preview')).toHaveValue(
    '新しい本文\n',
  );
});

test('同じbasenameの別パスを一括選択すると衝突を知らせ、別の入力として両方取り込む', async ({
  page,
}) => {
  const repository = novelRepository({
    branches: {
      main: [
        { path: 'a/ch1.md', content: 'A\n' },
        { path: 'b/ch1.md', content: 'B\n' },
      ],
    },
  });
  const mock = new GitHubMock([repository]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'a フォルダを選択' }).check();
  await dialog(page).getByRole('checkbox', { name: 'b フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  await expect(batch.locator('.github__batch-warning')).toHaveCount(2);
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();

  await expect(page.locator('.input-card')).toHaveCount(3);
  await expect(page.locator('.input-card__source')).toHaveText([/a\/ch1\.md/, /b\/ch1\.md/]);
});

test('NovelText 型の深いパスで同名 body.md が複数あり、同じ blob / tree SHA でもすべて別入力にする', async ({
  page,
}) => {
  const shared = '同じ本文\n';
  const repository = novelRepository({
    branches: {
      main: [
        { path: '作品/texts/CT-0001/body.md', content: shared },
        { path: '作品/texts/CT-0002/body.md', content: shared },
        { path: '作品/texts/CT-0003/body.md', content: '別の本文\n' },
      ],
    },
  });
  const mock = new GitHubMock([repository]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await entry(page, '作品/').click();
  await dialog(page).getByRole('checkbox', { name: 'texts フォルダを選択' }).check();
  const batch = await fetchSelection(page, 3);

  // basename は全部 body.md でも、取り込み元は path で別物。warning のみで確定を妨げない。
  await expect(batch.locator('.github__batch-warning')).toHaveCount(3);
  const commit = batch.getByRole('button', { name: '3ファイルを取り込む' });
  await expect(commit).toBeEnabled();
  await commit.click();

  await expect(page.locator('.input-card')).toHaveCount(4);
  await expect(page.locator('.input-card__source')).toHaveText([
    /作品\/texts\/CT-0001\/body\.md/,
    /作品\/texts\/CT-0002\/body\.md/,
    /作品\/texts\/CT-0003\/body\.md/,
  ]);

  // 入力名が同じでも変換対象から落とさない。出力名だけ既存規則で安全に重複解決する。
  await page.getByRole('button', { name: '変換' }).click();
  await expect(page.locator('.file-card__path')).toHaveText([
    'A用/local.md',
    'A用/body.md',
    'A用/body (2).md',
    'A用/body (3).md',
  ]);

  // 同一内容で blob SHA が同じでも、source.path は別なので入力は3件残る。
  // blobCache は再試行用で、同時進行中の同一 SHA リクエストを coalesce する契約ではない。
});

test('別ディレクトリへ移動しながら同名 body.md を個別チェックしても選択を保持する', async ({
  page,
}) => {
  const repository = novelRepository({
    branches: {
      main: [
        { path: '作品/texts/CT-0001/body.md', content: '本文1\\n' },
        { path: '作品/texts/CT-0002/body.md', content: '本文2\\n' },
      ],
    },
  });
  const mock = new GitHubMock([repository]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await entry(page, '作品/').click();
  await entry(page, 'texts/').click();

  await entry(page, 'CT-0001/').click();
  await dialog(page).getByRole('checkbox', { name: 'body.md を選択' }).check();
  await dialog(page).getByRole('button', { name: '上の階層へ' }).click();

  await entry(page, 'CT-0002/').click();
  await dialog(page).getByRole('checkbox', { name: 'body.md を選択' }).check();

  const batch = await fetchSelection(page, 2);
  await expect(batch.locator('.github__batch-warning')).toHaveCount(2);
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();

  await expect(page.locator('.input-card__source')).toHaveText([
    /作品\/texts\/CT-0001\/body\.md/,
    /作品\/texts\/CT-0002\/body\.md/,
  ]);
});

test('NovelText 実構成相当の36個の body.md を一括で別入力として保持し、出力名だけ重複解決する', async ({
  page,
}) => {
  const files = Array.from({ length: 36 }, (_, index) => {
    const id = String(index + 1).padStart(4, '0');
    return {
      path: `ほどけない、と気づくまで/texts/CT-${id}/body.md`,
      content: `本文 ${id}\\n`,
    };
  });
  const mock = new GitHubMock([
    novelRepository({
      branches: { main: files },
    }),
  ]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await entry(page, 'ほどけない、と気づくまで/').click();
  await dialog(page).getByRole('checkbox', { name: 'texts フォルダを選択' }).check();
  const batch = await fetchSelection(page, 36);
  await expect(batch.locator('.github__batch-warning')).toHaveCount(36);

  const commit = batch.getByRole('button', { name: '36ファイルを取り込む' });
  await expect(commit).toBeEnabled();
  await commit.click();

  await expect(page.locator('.input-card')).toHaveCount(37);
  await expect(page.locator('.input-card__source')).toHaveCount(36);
  await expect(page.locator('.input-card__source').first()).toContainText(
    'ほどけない、と気づくまで/texts/CT-0001/body.md',
  );
  await expect(page.locator('.input-card__source').last()).toContainText(
    'ほどけない、と気づくまで/texts/CT-0036/body.md',
  );

  await page.getByRole('button', { name: '変換' }).click();
  const paths = page.locator('.file-card__path');
  await expect(paths).toHaveCount(37);
  await expect(paths.nth(1)).toHaveText('A用/body.md');
  await expect(paths.last()).toHaveText('A用/body (36).md');
});

test('既存workspaceに body.md があっても、別pathのGitHub body.mdは追加できる', async ({ page }) => {
  const repository = novelRepository({
    branches: {
      main: [{ path: '作品/texts/CT-0001/body.md', content: 'GitHub本文\\n' }],
    },
  });
  const mock = new GitHubMock([repository]);
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [{ id: 'existing', title: 'body.md', text: '既存本文\\n' }],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await entry(page, '作品/').click();
  await entry(page, 'texts/').click();
  await entry(page, 'CT-0001/').click();
  await entry(page, 'body.md').click();

  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm).toContainText('同じファイル名の入力が別にあります');
  await expect(confirm.getByRole('group')).toHaveCount(0);
  await confirm.getByRole('button', { name: '入力に追加' }).click();

  await expect(page.locator('.input-card')).toHaveCount(2);
  const titles = page.locator('.input-card__title');
  await expect(titles.nth(0)).toHaveValue('body.md');
  await expect(titles.nth(1)).toHaveValue('body.md');
  await expect(page.locator('.input-card__source')).toHaveCount(1);
  await expect(page.locator('.input-card__source')).toContainText('作品/texts/CT-0001/body.md');
});

test('未展開のフォルダを選ぶと、blob を取る前に正確な件数と容量を見せ、戻れば選択は残る', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  // 文字を押しても切り替わる（チェックボックスの label の中にある）。
  await dialog(page).getByText('このフォルダ全体を選択').click();
  const root = dialog(page).getByRole('checkbox', { name: 'このフォルダ全体を選択' });
  await expect(root).toBeChecked();
  await dialog(page).getByRole('checkbox', { name: 'drafts フォルダを選択' }).uncheck();
  await expect(root).toBeChecked({ indeterminate: true });

  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan.getByRole('heading', { name: '3ファイルが見つかりました' })).toBeVisible();
  const files = plan.getByRole('list', { name: '取り込むファイル' });
  await expect(files.getByRole('listitem')).toHaveText([
    /^README\.md/,
    /^chapters\/ch1\.md/,
    /^chapters\/ch2\.txt/,
  ]);
  const bytes =
    Buffer.byteLength('# novel\n') +
    Buffer.byteLength('アリスは川辺に座っていた。\n') +
    Buffer.byteLength('ビルがやってきた。\n');
  await expect(plan).toContainText(`合計 ${bytes}B`);
  // 数えただけで、本文はまだ1件も取っていない。
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(0);
  await expect(plan).not.toContainText('利用上限');

  await plan.getByRole('button', { name: '選択へ戻る' }).click();
  await expect(root).toBeChecked({ indeterminate: true });
  await expect(page.locator('.input-card')).toHaveCount(1);
});

test('分かっている合計が 5MiB を超える選択は、取得を始めさせない', async ({ page }) => {
  const repository = novelRepository({
    branches: {
      main: [
        { path: 'big/a.md', content: 'a'.repeat(3 * MiB) },
        { path: 'big/b.md', content: 'b'.repeat(3 * MiB) },
      ],
    },
  });
  const mock = new GitHubMock([repository]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'big フォルダを選択' }).check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan.getByRole('alert')).toContainText('選んだファイルの合計が 5MiB を超えるため');
  await expect(plan.getByRole('button', { name: '2ファイルを取得' })).toBeDisabled();
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(0);
});

test('数えている間はチェックを変えられず、取得の途中で閉じれば残りの取得を中断し、計画の画面から続けられる', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  await chapters.check();

  const trees = await hold(page, /\/git\/trees\//);
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  await expect.poll(() => trees.held.length).toBeGreaterThan(0);
  // 数えている一覧と画面の選択が食い違わないよう、終わるまで選択は固定する。
  await expect(chapters).toBeDisabled();
  await trees.release();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan.getByRole('heading', { name: '2ファイルが見つかりました' })).toBeVisible();

  const blobs = await hold(page, /\/git\/blobs\//);
  await plan.getByRole('button', { name: '2ファイルを取得' }).click();
  await expect.poll(() => blobs.held.length).toBe(2);
  await dialog(page).getByRole('button', { name: '閉じる' }).click();

  // 閉じた時点で、走っていた取得はすべて中断される（遅れて届くのを待つだけではない）。
  await expect.poll(() => blobs.failed.length).toBe(2);
  await blobs.release();
  await expect(page.locator('.input-card')).toHaveCount(1);

  // 数え終えた計画は残るので、開き直せば数え直さずに取得からやり直せる。
  const treeCalls = mock.apiCalls(/\/git\/trees\//).length;
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(plan.getByRole('heading', { name: '2ファイルが見つかりました' })).toBeVisible();
  await plan.getByRole('button', { name: '2ファイルを取得' }).click();
  await dialog(page)
    .getByRole('region', { name: '複数ファイルの取り込み確認' })
    .getByRole('button', { name: '2ファイルを取り込む' })
    .click();
  await expect(page.locator('.input-card')).toHaveCount(3);
  expect(mock.apiCalls(/\/git\/trees\//)).toHaveLength(treeCalls);
});

test('確認画面で決めた内容は、Escape・背景のクリック・「閉じる」で閉じても残る', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  const head = mock.headOf(REPO.id, 'main');
  const sourceOf = (path: string) => ({
    kind: 'github' as const,
    repositoryId: REPO.id,
    owner: REPO.owner,
    repo: REPO.name,
    ref: 'main',
    commitSha: head,
    path,
    blobSha: 'b'.repeat(40),
  });
  // どちらの候補にも同じ取り込み元の入力が2件ずつある（1件ずつ決める必要がある）。
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [
      { id: 'a1', title: 'a1.md', text: '古い\n', source: sourceOf('chapters/ch1.md') },
      { id: 'a2', title: 'a2.md', text: '古い\n', source: sourceOf('chapters/ch1.md') },
      { id: 'b1', title: 'b1.md', text: '古い\n', source: sourceOf('chapters/ch2.txt') },
      { id: 'b2', title: 'b2.md', text: '古い\n', source: sourceOf('chapters/ch2.txt') },
    ],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  const blobCalls = mock.apiCalls(/\/git\/blobs\//).length;
  const first = batch.getByRole('combobox', { name: 'chapters/ch1.md の取り込み方法' });
  const second = batch.getByRole('combobox', { name: 'chapters/ch2.txt の取り込み方法' });
  await first.selectOption('update:a2');
  const reopen = () => page.getByRole('button', { name: 'GitHubから追加' }).click();

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await reopen();
  await expect(first).toHaveValue('update:a2');
  await second.selectOption('add');

  // 背景（ダイアログの外側）をクリックして閉じる。
  await page.mouse.click(2, 2);
  await expect(dialog(page)).toHaveCount(0);
  await reopen();
  await expect(first).toHaveValue('update:a2');
  await expect(second).toHaveValue('add');

  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await reopen();
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();

  // 取り直していない。1件は更新、1件は追加。
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(blobCalls);
  await expect(page.locator('.input-card')).toHaveCount(5);
  await expect(page.locator('.input-card__title').nth(1)).toHaveValue('a2.md');
  await expect(page.locator('.input-card__preview').nth(1)).toHaveValue(
    'アリスは川辺に座っていた。\n',
  );
});

test('閉じている間に更新先の入力が消えたら、その決定は捨てて選び直してもらう', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  const head = mock.headOf(REPO.id, 'main');
  const source = {
    kind: 'github' as const,
    repositoryId: REPO.id,
    owner: REPO.owner,
    repo: REPO.name,
    ref: 'main',
    commitSha: head,
    path: 'chapters/ch1.md',
    blobSha: 'b'.repeat(40),
  };
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [
      { id: 'a1', title: 'a1.md', text: '古い\n', source },
      { id: 'a2', title: 'a2.md', text: '古い\n', source },
      { id: 'a3', title: 'a3.md', text: '古い\n', source },
    ],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  const first = batch.getByRole('combobox', { name: 'chapters/ch1.md の取り込み方法' });
  await first.selectOption('update:a3');
  await dialog(page).getByRole('button', { name: '閉じる' }).click();

  await page.locator('.input-card').nth(2).getByRole('button', { name: '削除' }).click();
  await expect(page.locator('.input-card')).toHaveCount(2);

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(first).toHaveValue('');
  await expect(batch.getByRole('button', { name: '2ファイルを取り込む' })).toBeDisabled();
});

test('取得の途中で「選択へ戻る」を押すと、取得を中断して選択の画面に戻る', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  await chapters.check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });

  const blobs = await hold(page, /\/git\/blobs\//);
  await plan.getByRole('button', { name: '2ファイルを取得' }).click();
  await expect.poll(() => blobs.held.length).toBe(2);
  await plan.getByRole('button', { name: '選択へ戻る' }).click();

  // 取得は止まり、待ち表示も選択の固定も残らない。
  await expect.poll(() => blobs.failed.length).toBe(2);
  await expect(dialog(page).getByRole('status')).toHaveCount(0);
  await expect(chapters).toBeEnabled();
  await expect(chapters).toBeChecked();
  await blobs.release();

  // 固まっていないので、もう一度確かめて取り込める。
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  await plan.getByRole('button', { name: '2ファイルを取得' }).click();
  await dialog(page)
    .getByRole('region', { name: '複数ファイルの取り込み確認' })
    .getByRole('button', { name: '2ファイルを取り込む' })
    .click();
  await expect(page.locator('.input-card')).toHaveCount(3);
  // 解放したルートは外れている（2回目の取得は止められず、数えられもしない）。
  expect(blobs.held).toHaveLength(2);
});

test('1件だけ確かめて取り込んでも、組んでいた複数選択は残る', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  await chapters.check();
  await entry(page, 'README.md').click();
  await dialog(page).getByRole('button', { name: '入力に追加' }).click();
  await expect(page.locator('.input-card')).toHaveCount(2);

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(chapters).toBeChecked();

  // 一括で取り込んだら、その選択は役目を終えたので片付く。
  const batch = await fetchSelection(page, 2);
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(chapters).not.toBeChecked();
});

test('大量の選択でも、計画画面は先頭だけを並べ、確認画面は100件ずつ送って全件に届く', async ({
  page,
}) => {
  const files = Array.from({ length: 120 }, (_, index) => ({
    path: `many/f${String(index).padStart(3, '0')}.md`,
    content: `${index}\n`,
  }));
  const mock = new GitHubMock([novelRepository({ branches: { main: files } })]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'many フォルダを選択' }).check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan.getByRole('heading', { name: '120ファイルが見つかりました' })).toBeVisible();
  await expect(
    plan.getByRole('list', { name: '取り込むファイル' }).getByRole('listitem'),
  ).toHaveCount(100);
  // 本文を取る前の最後の確認なので、101件目以降もページを送って見られる。
  await expect(plan).toContainText('1〜100件目 / 全120件');
  await plan.getByRole('button', { name: '次の100件' }).click();
  const planRows = plan.getByRole('list', { name: '取り込むファイル' }).getByRole('listitem');
  await expect(planRows).toHaveCount(20);
  await expect(planRows.last()).toContainText('many/f119.md');
  await expect(plan.getByText('101〜120件目 / 全120件')).toBeFocused();

  await plan.getByRole('button', { name: '120ファイルを取得' }).click();
  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  const rows = batch.getByRole('list', { name: '取り込むファイル' }).getByRole('listitem');
  await expect(rows).toHaveCount(100);
  await expect(batch).toContainText('1〜100件目 / 全120件');

  // ページャは一覧の下にあるので、末尾までスクロールしてから送るのが自然な操作になる。
  const list = batch.getByRole('list', { name: '取り込むファイル' });
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await batch.getByRole('button', { name: '次の100件' }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.last()).toContainText('many/f119.md');
  // 次のページは先頭から見え、押したボタンが無効になってもフォーカスは範囲の表示に残る。
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  const range = batch.getByText('101〜120件目 / 全120件');
  await expect(range).toBeFocused();
  await expect(range).toHaveAttribute('aria-live', 'polite');
  await expect(batch.getByRole('button', { name: '次の100件' })).toBeDisabled();
  await batch.getByRole('button', { name: '120ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(121);
});

test('更新先が2件以上ある候補が100件を超えても、ページを送れば101件目を個別に決められる', async ({
  page,
}) => {
  const files = Array.from({ length: 101 }, (_, index) => ({
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
  // どの候補にも同じ取り込み元の入力が2件ずつある（更新先を推測できない）。
  const inputs = files.flatMap((file, index) =>
    ['x', 'y'].map((copy) => ({
      id: `${copy}${index}`,
      title: `${copy}-${index}.md`,
      text: '古い\n',
      source: sourceOf(file.path),
    })),
  );
  await mock.install(page);
  await seedWorkspace(page, { inputs, groups: [{ id: 'g1', name: 'A用' }], rules: [] });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'many フォルダを選択' }).check();
  const batch = await fetchSelection(page, 101);
  // 更新先が2件の候補しか無いので、「更新先が1件」のまとめ操作は出ない。
  await expect(batch.getByRole('button', { name: /更新先が1件/ })).toHaveCount(0);
  await expect(batch).toContainText('未決定 101件');

  await batch.getByRole('button', { name: '次の100件' }).click();
  const last = batch.getByRole('combobox', { name: 'many/f100.md の取り込み方法' });
  await last.selectOption('update:y100');
  await expect(batch).toContainText('未決定 100件');
  // 前のページへ戻っても、決めた内容は残る。
  await batch.getByRole('button', { name: '前の100件' }).click();
  await batch.getByRole('button', { name: '次の100件' }).click();
  await expect(last).toHaveValue('update:y100');

  await batch.getByRole('button', { name: '未決定の100件をすべて別の入力として追加' }).click();
  await batch.getByRole('button', { name: '101ファイルを取り込む' }).click();
  // 1件は更新、100件は追加。
  await expect(page.locator('.input-card')).toHaveCount(202 + 100);
});

test('同じ取り込み元の候補は、更新先が1件のものをまとめて更新に決められる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  const head = mock.headOf(REPO.id, 'main');
  const sourceOf = (path: string) => ({
    kind: 'github' as const,
    repositoryId: REPO.id,
    owner: REPO.owner,
    repo: REPO.name,
    ref: 'main',
    commitSha: head,
    path,
    blobSha: 'b'.repeat(40),
  });
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [
      { id: 'one', title: 'one.md', text: '古い1\n', source: sourceOf('chapters/ch1.md') },
      { id: 'two', title: 'two.txt', text: '古い2\n', source: sourceOf('chapters/ch2.txt') },
    ],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  const commit = batch.getByRole('button', { name: '2ファイルを取り込む' });
  await expect(commit).toBeDisabled();
  await expect(batch).toContainText('未決定 2件');

  await batch.getByRole('button', { name: '更新先が1件の2件をすべて更新' }).click();
  await expect(batch.getByRole('combobox', { name: 'chapters/ch1.md の取り込み方法' })).toHaveValue(
    'update:one',
  );
  // 押したボタンは消えるので、フォーカスは見出しへ移る（body へ外れない）。
  await expect(batch.getByRole('button', { name: /すべて更新/ })).toHaveCount(0);
  await expect(batch.getByRole('heading', { name: '2ファイルを取り込む' })).toBeFocused();
  await commit.click();

  // 追加ではなく更新なので、入力は増えず、タイトル（出力名）はそのまま本文が入れ替わる。
  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__title').nth(0)).toHaveValue('one.md');
  await expect(page.locator('.input-card__preview').nth(0)).toHaveValue(
    'アリスは川辺に座っていた。\n',
  );
});

test('更新先が選択欄に並べきれないほどあっても、ページを送るか入力の番号で選んで更新できる', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  const head = mock.headOf(REPO.id, 'main');
  const source = {
    kind: 'github' as const,
    repositoryId: REPO.id,
    owner: REPO.owner,
    repo: REPO.name,
    ref: 'main',
    commitSha: head,
    path: 'chapters/ch1.md',
    blobSha: 'b'.repeat(40),
  };
  // 「別の入力として追加」を繰り返すと、同じ取り込み元の入力はいくらでも増える。
  const inputs = Array.from({ length: 55 }, (_, index) => ({
    id: `copy${index}`,
    title: `copy-${index}.md`,
    text: '古い\n',
    source,
  }));
  await mock.install(page);
  await seedWorkspace(page, { inputs, groups: [{ id: 'g1', name: 'A用' }], rules: [] });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  const decision = batch.getByRole('combobox', { name: 'chapters/ch1.md の取り込み方法' });
  // 「選ぶ」「追加」と、先頭の 50 件だけを並べる。
  await expect(decision.locator('option')).toHaveCount(52);
  await expect(batch).toContainText('更新先 1〜50件目 / 全55件');

  // 残りの更新先も、ページを送れば番号と名前を見て選べる。
  await batch.getByRole('button', { name: 'chapters/ch1.md の更新先: 次の50件' }).click();
  await expect(decision.locator('option')).toHaveCount(7);
  await decision.selectOption({ label: '54 copy-53.md を更新' });
  await expect(decision).toHaveValue('update:copy53');
  await batch.getByRole('button', { name: 'chapters/ch1.md の更新先: 前の50件' }).click();
  // 別のページに戻っても、選んだ更新先は選択欄に残る。
  await expect(decision.locator('option')).toHaveCount(53);
  await expect(decision).toHaveValue('update:copy53');

  // 番号が分かっていれば直接指定もできる（近道）。

  const number = batch.getByRole('textbox', { name: 'chapters/ch1.md の更新先の入力の番号' });
  await number.fill('999');
  await batch.getByRole('button', { name: 'この番号を更新' }).click();
  await expect(batch.getByRole('alert')).toContainText(
    '999 はこのファイルから取り込んだ入力の番号ではありません',
  );
  // 受け付けなかった番号では、選んでいた更新先を変えない。
  await expect(decision).toHaveValue('update:copy53');

  // 全角数字でも番号として読む。
  await number.fill('５５');
  await batch.getByRole('button', { name: 'この番号を更新' }).click();
  await expect(batch.getByRole('alert')).toHaveCount(0);
  // 選んだ更新先は並べきれない範囲でも選択欄に出す（未決定に戻ったように見せない）。
  await expect(decision).toHaveValue('update:copy54');
  await expect(decision.locator('option')).toHaveCount(53);

  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(56);
  await expect(page.locator('.input-card__title').nth(54)).toHaveValue('copy-54.md');
  await expect(page.locator('.input-card__preview').nth(54)).toHaveValue(
    'アリスは川辺に座っていた。\n',
  );
});

test('接続の解除はこのタブだけだと、ボタンの名前と補足で伝える', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);

  const disconnect = dialog(page).getByRole('button', { name: 'このタブの接続を解除' });
  await expect(disconnect).toHaveAccessibleDescription(/GitHub の設定から変更できます/);
  await disconnect.click();
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'このタブの接続を解除' })).toHaveCount(0);
});

test('GitHub 側が変わっていない候補は、まとめて更新の対象外にし、確定前に置き換えの件数を示す', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  const head = mock.headOf(REPO.id, 'main');
  const sourceOf = (path: string, blobSha: string) => ({
    kind: 'github' as const,
    repositoryId: REPO.id,
    owner: REPO.owner,
    repo: REPO.name,
    ref: 'main',
    commitSha: head,
    path,
    blobSha,
  });
  await mock.install(page);
  await seedWorkspace(page, {
    inputs: [
      // 前回の取り込みから GitHub 側は変わっておらず、手元で直している。
      {
        id: 'one',
        title: 'one.md',
        text: '手元で直した\n',
        source: sourceOf('chapters/ch1.md', GitHubMock.blobSha('アリスは川辺に座っていた。\n')),
      },
      {
        id: 'two',
        title: 'two.txt',
        text: '古い2\n',
        source: sourceOf('chapters/ch2.txt', 'b'.repeat(40)),
      },
    ],
    groups: [{ id: 'g1', name: 'A用' }],
    rules: [],
  });
  await openApp(page);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  const blobCalls = mock.apiCalls(/\/git\/blobs\//).length;
  const first = batch.getByRole('combobox', { name: 'chapters/ch1.md の取り込み方法' });

  // まとめて更新するのは、GitHub 側が変わった1件だけ。
  await batch.getByRole('button', { name: '更新先が1件の1件をすべて更新' }).click();
  await expect(batch).toContainText('GitHub 側は前回の取り込みから変わっていません');
  await expect(batch).toContainText('未決定が1件あります');
  const commit = batch.getByRole('button', { name: '2ファイルを取り込む' });
  await expect(commit).toBeDisabled();

  // 押せない理由の横から、残りの未決定へ移れる。
  await batch.getByRole('button', { name: '次の未決定へ' }).click();
  await expect(first).toBeFocused();
  await first.selectOption('update:one');
  await expect(batch.getByRole('note')).toContainText('手元で直した内容が失われるだけです');
  await expect(commit).toHaveAccessibleDescription(
    /追加 0件 · 本文の置き換え 2件（うち1件は GitHub 側が前回の取り込みから変わっていない/,
  );
  await commit.click();
  await expect(page.locator('.input-card__preview').nth(0)).toHaveValue(
    'アリスは川辺に座っていた。\n',
  );

  // 「元に戻す」で、置き換えた本文も確認画面も決めた内容ごと戻る（取り直さない）。
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.locator('.input-card__preview').nth(0)).toHaveValue('手元で直した\n');
  await expect(page.locator('.input-card__preview').nth(1)).toHaveValue('古い2\n');
  await expect(first).toHaveValue('update:one');
  await expect(
    batch.getByRole('combobox', { name: 'chapters/ch2.txt の取り込み方法' }),
  ).toHaveValue('update:two');
  // 今度は追加に決め直して取り込める。
  await first.selectOption('add');
  await commit.click();
  await expect(page.locator('.input-card')).toHaveCount(3);
  await expect(page.locator('.input-card__preview').nth(0)).toHaveValue('手元で直した\n');
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(blobCalls);
});

test('一括の確認画面で、Shift_JIS と推測した本文をその場で確かめられる（取り直さない）', async ({
  page,
}) => {
  const mock = new GitHubMock([
    novelRepository({
      branches: {
        main: [
          { path: 'old/a.txt', content: Buffer.from([0x82, 0xa0, 0x0a]) },
          { path: 'old/b.md', content: 'UTF-8 の本文\n' },
        ],
      },
    }),
  ]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'old フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  const blobCalls = mock.apiCalls(/\/git\/blobs\//).length;
  await expect(batch).toContainText('その行の「本文を確認」で確かめてください');
  // Shift_JIS の行にだけ出す。
  await expect(batch.getByRole('button', { name: /の本文を確認/ })).toHaveCount(1);
  await batch.getByRole('button', { name: 'old/a.txt の本文を確認' }).click();
  await expect(batch.getByRole('textbox', { name: 'old/a.txt の本文' })).toHaveValue('あ\n');
  await batch.getByRole('button', { name: 'old/a.txt の本文を閉じる' }).click();
  await expect(batch.getByRole('textbox', { name: 'old/a.txt の本文' })).toHaveCount(0);
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(blobCalls);
});

test('選び直して取得し直しても、取得済みの本文は GitHub へ取りに行かない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  await chapters.check();
  const batch = await fetchSelection(page, 2);
  const blobCalls = mock.apiCalls(/\/git\/blobs\//).length;
  expect(blobCalls).toBe(2);

  // 1件だけ外すために選択へ戻る（取得した一括は破棄される）。
  await batch.getByRole('button', { name: '選択へ戻る（取得した内容を破棄）' }).click();
  await entry(page, 'chapters/').click();
  await dialog(page).getByRole('checkbox', { name: 'ch2.txt を選択' }).uncheck();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  await dialog(page).getByRole('button', { name: '1ファイルを取得' }).click();
  await dialog(page)
    .getByRole('region', { name: '複数ファイルの取り込み確認' })
    .getByRole('button', { name: '1ファイルを取り込む' })
    .click();
  await expect(page.locator('.input-card')).toHaveCount(2);
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(blobCalls);
});

test('一括取り込みの途中で接続を解除するときは、破棄してよいか確かめる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  const disconnect = dialog(page).getByRole('button', { name: 'このタブの接続を解除' });

  await disconnect.click();
  const confirm = page.getByRole('dialog', { name: 'GitHub との接続を解除する' });
  await expect(confirm).toContainText('取得済みの 2ファイルと、決めた取り込み方法');
  await confirm.getByRole('button', { name: 'キャンセル' }).click();
  await expect(batch.getByRole('button', { name: '2ファイルを取り込む' })).toBeVisible();

  await disconnect.click();
  await confirm.getByRole('button', { name: '接続を解除する' }).click();
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeVisible();
});

test('絞り込み中の「このフォルダ全体を選択」は、隠れている項目も選ぶことを名前で伝える', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'chapters/').click();

  await expect(
    dialog(page).getByRole('checkbox', { name: 'このフォルダ全体を選択' }),
  ).toBeVisible();
  await dialog(page).getByRole('searchbox', { name: 'このフォルダを絞り込み' }).fill('ch1');
  const whole = dialog(page).getByRole('checkbox', {
    name: 'このフォルダ全体を選択（絞り込みで隠れている項目も含む）',
  });
  await whole.check();
  // 絞り込みを外すと、隠れていた ch2.txt も選ばれている。
  await dialog(page).getByRole('searchbox', { name: 'このフォルダを絞り込み' }).fill('');
  await expect(dialog(page).getByRole('checkbox', { name: 'ch2.txt を選択' })).toBeChecked();
});

test('ダイアログの中で文字をドラッグで選び、外側で離しても閉じない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();

  const preview = dialog(page).getByRole('textbox', { name: '取り込む本文' });
  const box = await preview.boundingBox();
  if (!box) throw new Error('本文欄の位置が取れません');
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(2, 2, { steps: 5 });
  await page.mouse.up();
  await expect(preview).toBeVisible();

  // 背景で押して背景で離せば、これまでどおり閉じる。
  await page.mouse.click(2, 2);
  await expect(dialog(page)).toHaveCount(0);
});

test('開かずにフォルダを選んでも、計画画面で対象外の項目の件数と、対応する形式だけを取り込むことを示す', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan).toContainText('対応する形式（.md / .txt / .tex）のファイルだけを取り込みます');
  await expect(plan).toContainText(
    'ほかに対象外が 2件あります（非対応の形式 1件 · シンボリックリンク 1件）',
  );
  await expect(plan).toContainText('再読み込みやタブを閉じると、取得し直しになります');
});

test('本文の取得中は、何件目まで進んだかを出す', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  // 2件のうち ch2.txt だけを止め、ch1.md が先に終わった状態を作る。
  const second = await hold(page, new RegExp(GitHubMock.blobSha('ビルがやってきた。\n')));
  await dialog(page).getByRole('button', { name: '2ファイルを取得' }).click();
  await expect(dialog(page).getByRole('status')).toContainText(
    '選択したファイルを取得しています（1 / 2）',
  );
  await second.release();
  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch).toContainText('一括取り込みは追加と更新だけを行います');
});

test('一括取り込みの途中は、再読み込みやタブを閉じる前に確かめる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  const leaving = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });

  expect(await leaving()).toBe(false);
  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  expect(await leaving()).toBe(true);
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  expect(await leaving()).toBe(false);
});

test('接続したあとで保存に失敗したら、一括の取得と確定を止めて書き出しへ案内する', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  // 接続（画面遷移）のあとで、保存だけを失敗させられるようにする。
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name: string, value: string) {
      if (name === key && (window as { failSave?: boolean }).failSave) {
        throw new Error('QuotaExceededError');
      }
      return original.call(this, name, value);
    };
  }, STORAGE_KEY);
  await openApp(page);
  await connect(page);
  await openRepository(page);
  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await plan.getByRole('button', { name: '2ファイルを取得' }).click();
  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await dialog(page).getByRole('button', { name: '閉じる' }).click();

  await page.evaluate(() => {
    (window as { failSave?: boolean }).failSave = true;
  });
  await page.locator('.input-card__title').fill('changed.md');
  await expect(page.locator('.save-error')).toBeVisible();

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(batch.getByRole('alert')).toContainText('いまブラウザへの保存に失敗しています');
  await expect(batch.getByRole('button', { name: '2ファイルを取り込む' })).toBeDisabled();
  // 背後の警告は操作できないので、ダイアログの中から書き出せる。
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    batch.getByRole('button', { name: '作業データを書き出す' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
});

test('大きさの分からないファイルがあれば、合計が小さくても取得の前に警告する', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  mock.omitTreeSizes = true;
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  await expect(plan).toContainText('2件は大きさを事前に確認できません');
  await expect(plan).toContainText('以上（2件は大きさ不明）');
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(0);
});

test('「最新に更新」でコミットが進んだら、選択を解除したことを知らせる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const chapters = dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' });
  await chapters.check();

  // 先頭が変わっていなければ、選択はそのまま残る。
  await dialog(page).getByRole('button', { name: '最新に更新' }).click();
  await expect(dialog(page).getByRole('status')).toContainText('最新です');
  await expect(chapters).toBeChecked();

  const moved = mock.setBranch(REPO.id, 'main', [
    { path: 'chapters/ch1.md', content: '新しい版の ch1。\n' },
  ]);
  await dialog(page).getByRole('button', { name: '最新に更新' }).click();
  await expect(dialog(page).getByRole('status')).toContainText(
    `${moved.slice(0, 7)} に更新しました。選択は解除しました`,
  );
  await expect(chapters).not.toBeChecked();
});

test('絞り込みは、NFD で保存されたファイル名にも NFC の入力で一致する', async ({ page }) => {
  const decomposed = 'がくや.md'.normalize('NFD');
  const repository = novelRepository({
    branches: {
      main: [
        { path: decomposed, content: '楽屋\n' },
        { path: 'other.md', content: '別\n' },
      ],
    },
  });
  const mock = new GitHubMock([repository]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page)
    .getByRole('searchbox', { name: 'このフォルダを絞り込み' })
    .fill('がく'.normalize('NFC'));
  await expect(dialog(page).getByRole('checkbox', { name: `${decomposed} を選択` })).toBeVisible();
  await expect(dialog(page).getByRole('checkbox', { name: 'other.md を選択' })).toHaveCount(0);
});

test('取得の途中で閉じても、開き直せば続きから読み込む', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  // フォルダの一覧を待っているあいだに閉じる。
  await page.route('https://api.github.com/**/git/trees/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fallback();
  });
  await entry(page, 'chapters/').click();
  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mock.install(page);

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(entry(page, 'ch1.md')).toBeVisible();
});

test('パンくずと「上の階層へ」で戻れる。一度開いたフォルダは取り直さない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await entry(page, 'chapters/').click();
  await expect(entry(page, 'ch1.md')).toBeVisible();
  await dialog(page).getByRole('button', { name: '上の階層へ' }).click();
  await expect(entry(page, 'drafts/')).toBeVisible();
  await entry(page, 'chapters/').click();
  await dialog(page)
    .getByRole('navigation', { name: '現在の場所' })
    .getByRole('button', { name: 'novel' })
    .click();
  await expect(entry(page, 'README.md')).toBeVisible();

  expect(mock.apiCalls(/\/git\/trees\//)).toHaveLength(2);
});

test('中身が同じ別のフォルダ（tree SHA が同じ）を開いても、選んだ側のパスで取り込む', async ({
  page,
}) => {
  // Git では中身が同じディレクトリは同じ tree SHA になる。一覧を使い回すときにパスを
  // 取り違えると、出自（source.path）と取り込み元の同一性が別のファイルに結び付く。
  const twins = novelRepository({
    branches: {
      main: [
        { path: 'a/ch1.md', content: '同じ本文\n' },
        { path: 'b/ch1.md', content: '同じ本文\n' },
      ],
    },
  });
  const mock = new GitHubMock([twins]);
  const rootTree = mock.treeOf(mock.headOf(twins.id, 'main'));
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  // a/ を一度開いて一覧をキャッシュさせてから、ルートへ戻って b/ を開く。
  await entry(page, 'a/').click();
  await expect(entry(page, 'ch1.md')).toBeVisible();
  await dialog(page)
    .getByRole('navigation', { name: '現在の場所' })
    .getByRole('button', { name: 'novel' })
    .click();
  await entry(page, 'b/').click();
  await expect(
    dialog(page).getByRole('navigation', { name: '現在の場所' }).locator('[aria-current]'),
  ).toHaveText('b');
  await entry(page, 'ch1.md').click();

  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm).toContainText(': b/ch1.md');
  await confirm.getByRole('button', { name: '入力に追加' }).click();
  await expect(page.locator('.input-card__source')).toContainText('octo/novel · b/ch1.md');

  // 保存された出自（source identity に使う path）も b/ch1.md。
  const readSaved = () => page.evaluate((key) => localStorage.getItem(key) ?? '', STORAGE_KEY);
  await expect.poll(readSaved).toContain('"path":"b/ch1.md"');
  expect(await readSaved()).not.toContain('"path":"a/ch1.md"');

  // 取り違えが起き得る条件（a/ と b/ が同じ tree SHA）を満たしていたことの確認。
  const subtreeShas = mock
    .apiCalls(/\/git\/trees\//)
    .map((call) => call.url.split('/').pop())
    .filter((sha) => sha !== rootTree);
  expect(new Set(subtreeShas).size).toBe(1);
});

/**
 * 一致する API への要求を、`release()` を呼ぶまで止めておく。止めたあいだにアプリが
 * 中断した要求は、そのまま捨てる（中断済みの要求は続きを流せない）。
 * 利用者が「待たずに別のボタンを押す」操作を、応答の遅さに頼らずに再現するために使う。
 */
async function holdRequests(page: Page, pattern: string): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await gate;
    await route.fallback().catch(() => {});
  });
  return release;
}

test('一覧を待っている途中に「最新に更新」を押しても、先頭が同じなら一覧を開き直す', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const releaseTrees = await holdRequests(page, 'https://api.github.com/**/git/trees/**');
  await entry(page, 'chapters/').click();
  await expect(dialog(page).getByRole('status')).toContainText('フォルダを読み込んでいます');

  // 確認のために一覧の取得は中断される。先頭が変わっていなければ、同じ場所を開き直す。
  await dialog(page).getByRole('button', { name: '最新に更新' }).click();
  releaseTrees();
  await expect(entry(page, 'ch1.md')).toBeVisible();
  await expect(dialog(page).getByRole('status')).toContainText('最新です');
  await expect(dialog(page).getByRole('navigation', { name: '現在の場所' })).toContainText(
    'chapters',
  );
});

test('一覧を待っている途中に「ブランチを変更」→「変えずに戻る」としても、一覧を開き直す', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const releaseTrees = await holdRequests(page, 'https://api.github.com/**/git/trees/**');
  const releaseBranches = await holdRequests(page, 'https://api.github.com/**/branches**');
  await entry(page, 'chapters/').click();
  await expect(dialog(page).getByRole('status')).toContainText('フォルダを読み込んでいます');

  // ブランチの一覧も待たずに戻る。どちらの取得も中断されている。
  await dialog(page).getByRole('button', { name: 'ブランチを変更' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'ブランチを選ぶ' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'ブランチを変えずに戻る' }).click();
  releaseBranches();
  releaseTrees();

  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeVisible();
  await expect(entry(page, 'ch1.md')).toBeVisible();
});

test('既定ブランチが改名・削除されていたら、再試行ではなくブランチの一覧から選び直してもらう', async ({
  page,
}) => {
  // リポジトリの一覧は既定ブランチを main と返すが、main はもう無い（trunk に改名された）。
  const mock = new GitHubMock([
    novelRepository({
      defaultBranch: 'main',
      branches: { trunk: [{ path: 'ch1.md', content: '改名後のブランチの原稿\n' }] },
    }),
  ]);
  await start(page, mock);
  await connect(page);
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();

  // 同じ ref を何度解決しても 404 なので、「再試行」は出さずにブランチの一覧へ戻す。
  await expect(dialog(page).getByRole('heading', { name: 'ブランチを選ぶ' })).toBeVisible();
  await expect(dialog(page).getByRole('status')).toContainText(
    'ブランチ main が見つかりませんでした',
  );
  await expect(dialog(page).getByRole('button', { name: '再試行' })).toHaveCount(0);

  await dialog(page)
    .getByRole('button', { name: /^trunk/ })
    .click();
  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeVisible();
  await expect(entry(page, 'ch1.md')).toBeVisible();
});

test('リポジトリが消えた・見えなくなったら、リポジトリの一覧を取り直して選び直してもらう', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);

  // 一覧を取ったあとで、リポジトリが削除されたか App のアクセス対象から外れた。
  // ref もブランチの一覧も 404 になる（どちらも同じ理由なので、再試行では直らない）。
  await page.route('https://api.github.com/repos/octo/novel/**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fallback()
      : route.fulfill({
          status: 404,
          headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'Not Found' }),
        }),
  );
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();

  const alert = dialog(page).getByRole('alert');
  await expect(alert).toContainText('見つかりませんでした');
  await expect(alert.getByRole('button', { name: '再試行' })).toHaveCount(0);
  const installationsBefore = mock.apiCalls(/^\/user\/installations$/).length;
  await alert.getByRole('button', { name: 'リポジトリを選び直す' }).click();

  // 手元の一覧は古いので、取り直してから選んでもらう。
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toBeVisible();
  expect(mock.apiCalls(/^\/user\/installations$/).length).toBeGreaterThan(installationsBefore);
});

test('ブランチを変えると、そのブランチの先頭で固定し直す', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('button', { name: 'ブランチを変更' }).click();
  const branches = dialog(page).getByRole('region', { name: 'ブランチ' });
  await expect(branches.getByRole('button', { name: /^main/ })).toContainText('既定');
  await branches.getByRole('button', { name: /^draft/ }).click();

  await expect(entry(page, 'draft-only.md')).toBeVisible();
  await expect(dialog(page).locator('.github__facts')).toContainText(
    mock.headOf(REPO.id, 'draft').slice(0, 7),
  );
});

test('開いている間にブランチが進んでも、固定したコミットから取り込む。更新は明示操作だけ', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  const pinned = mock.headOf(REPO.id, 'main');

  // 画面を開いたまま、誰かが main に push した。
  const moved = mock.setBranch(REPO.id, 'main', [
    { path: 'chapters/ch1.md', content: '新しい版の ch1。\n' },
  ]);

  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();
  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm.getByRole('textbox', { name: '取り込む本文' })).toHaveValue(
    'アリスは川辺に座っていた。\n',
  );
  await expect(confirm).toContainText(pinned.slice(0, 7));
  // 固定後は ref を引き直していない。
  expect(mock.apiCalls(/\/git\/ref\/heads\/main$/)).toHaveLength(1);

  // 明示的に「最新に更新」したときだけ新しい先頭へ移る。
  await confirm.getByRole('button', { name: '戻る' }).click();
  await dialog(page).getByRole('button', { name: '最新に更新' }).click();
  await expect(dialog(page).locator('.github__facts')).toContainText(moved.slice(0, 7));
  await expect(dialog(page).getByRole('status')).toContainText(
    `${moved.slice(0, 7)} に更新しました`,
  );
  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();
  await expect(dialog(page).getByRole('textbox', { name: '取り込む本文' })).toHaveValue(
    '新しい版の ch1。\n',
  );
});

test('先頭が変わっていなければ「最新です」と知らせる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await dialog(page).getByRole('button', { name: '最新に更新' }).click();
  await expect(dialog(page).getByRole('status')).toContainText('最新です');
});

/** chapters/ch1.md を取り込む。 */
async function importCh1(page: Page, button: string): Promise<void> {
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  // 閉じても接続と場所は残っている。
  const inChapters = entry(page, 'ch1.md');
  if (!(await inChapters.isVisible())) await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();
  await dialog(page).getByRole('button', { name: button }).click();
}

test('同じ取り込み元をもう一度取り込むと、更新 / 別の入力として追加 / キャンセルを選べる', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();
  await dialog(page).getByRole('button', { name: '入力に追加' }).click();

  // 出力名を付け直しておく（更新してもタイトルは残る）。
  const titles = page.locator('.input-card__title');
  await titles.nth(1).fill('第一章.md');

  // GitHub 側で内容が変わった。
  mock.setBranch(REPO.id, 'main', [{ path: 'chapters/ch1.md', content: '直した ch1。\n' }]);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: '最新に更新' }).click();
  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();

  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(
    confirm.getByRole('group', { name: 'このファイルは取り込み済みです' }),
  ).toBeVisible();
  await expect(confirm.getByRole('radio', { name: '02 第一章.md' })).toBeChecked();

  // キャンセルではワークスペースは変わらない。
  await confirm.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('.input-card')).toHaveCount(2);

  await entry(page, 'ch1.md').click();
  await dialog(page).getByRole('button', { name: '更新する' }).click();
  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(titles.nth(1)).toHaveValue('第一章.md');
  await expect(page.locator('.input-card__preview').nth(1)).toHaveValue('直した ch1。\n');

  // 別の入力として追加すると、同じ取り込み元が2件になる。
  await importCh1(page, '別の入力として追加');
  await expect(page.locator('.input-card')).toHaveCount(3);

  // 2件あると、どちらを更新するかは推測しない。
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await entry(page, 'ch1.md').click();
  const again = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(again.getByRole('group')).toContainText('2件あります');
  await expect(again.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(again.getByRole('button', { name: '更新する' })).toBeDisabled();
  await again.getByRole('radio', { name: '03 ch1.md' }).check();
  await expect(again.getByRole('button', { name: '更新する' })).toBeEnabled();
});

test('ファイル名が同じでも、別のパスなら上書きの確認を出さず別の入力にする', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();
  await dialog(page).getByRole('button', { name: '入力に追加' }).click();

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: '上の階層へ' }).click();
  await entry(page, 'drafts/').click();
  await entry(page, 'ch1.md').click();
  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm.getByRole('group')).toHaveCount(0);
  await expect(confirm).toContainText('同じファイル名の入力が別にあります');
  await confirm.getByRole('button', { name: '入力に追加' }).click();

  await expect(page.locator('.input-card__source')).toHaveText([
    /chapters\/ch1\.md/,
    /drafts\/ch1\.md/,
  ]);
});

test('Shift_JIS の原稿は取り込めるが、推測で読んだことを知らせる', async ({ page }) => {
  const mock = new GitHubMock([
    novelRepository({
      branches: { main: [{ path: 'old.txt', content: Buffer.from([0x82, 0xa0, 0x0a]) }] },
    }),
  ]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'old.txt').click();
  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm.getByRole('alert')).toContainText('Shift_JIS');
  await expect(confirm.getByRole('textbox', { name: '取り込む本文' })).toHaveValue('あ\n');
  await confirm.getByRole('button', { name: '入力に追加' }).click();
  await expect(page.locator('.toast')).toContainText('Shift_JIS として読み込みました');
});

test('Git LFS のポインタは取り込まない', async ({ page }) => {
  const mock = new GitHubMock([
    novelRepository({
      branches: {
        main: [
          {
            path: 'big.md',
            content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 999999\n',
          },
        ],
      },
    }),
  ]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'big.md').click();
  await expect(dialog(page).getByRole('alert')).toContainText('Git LFS');
  await expect(dialog(page).getByRole('region', { name: '取り込む内容の確認' })).toHaveCount(0);
});

test('取得に失敗しても入力は増えず、再試行できる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'chapters/').click();

  mock.failPaths = ['/git/blobs/'];
  await entry(page, 'ch1.md').click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub 側でエラー');
  await expect(page.locator('.input-card')).toHaveCount(1);

  mock.failPaths = [];
  await dialog(page).getByRole('button', { name: '再試行' }).click();
  await expect(dialog(page).getByRole('region', { name: '取り込む内容の確認' })).toBeVisible();
});

test('rate limit はネットワーク障害と区別して知らせる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  // 解除時刻まで待たずに確かめるため、ページの時計を進められるようにしておく。
  await page.clock.install();
  await start(page, mock);
  await connect(page);
  mock.rateLimitedResponses = 1;
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub API の利用上限に達しました');

  // 表示している解除時刻（10分後）までは、再試行を押せない。
  const retry = dialog(page).getByRole('button', { name: '再試行' });
  await expect(retry).toBeDisabled();
  await page.clock.fastForward('10:30');
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeVisible();
});

test('rate limit のあいだは、どのボタンや操作からも GitHub へ要求しない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  // 解除時刻まで待たずに確かめるため、ページの時計を進められるようにしておく。
  await page.clock.install();
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
  const fetch = plan.getByRole('button', { name: '2ファイルを取得' });

  // 本文の取得中に rate limit になる。
  mock.rateLimitedResponses = 1;
  await fetch.click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub API の利用上限に達しました');
  const githubCalls = (): number => mock.apiCalls(/./).length;
  const requestsAfterLimit = githubCalls();

  // 「再試行」だけでなく、計画画面の「取得」も押せない。
  await expect(dialog(page).getByRole('button', { name: '再試行' })).toBeDisabled();
  await expect(fetch).toBeDisabled();

  // 選択へ戻って失敗の知らせが消えても、待ちは続く。理由も見えている。
  await plan.getByRole('button', { name: '選択へ戻る' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await expect(dialog(page).getByRole('status')).toContainText('GitHub API の利用上限に達しました');
  await expect(dialog(page).getByRole('button', { name: '選択したファイルを確認' })).toBeDisabled();

  // まだ開いていないフォルダを開く操作も、要求を出さずに知らせるだけ。
  await entry(page, 'chapters/').click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub API の利用上限に達しました');
  expect(githubCalls()).toBe(requestsAfterLimit);

  // 解除時刻（10分後）を過ぎれば、続きから取り込める。
  await page.clock.fastForward('10:30');
  await dialog(page).getByRole('button', { name: '再試行' }).click();
  await expect(entry(page, 'ch1.md')).toBeVisible();
  await dialog(page)
    .getByRole('navigation', { name: '現在の場所' })
    .getByRole('button', { name: 'novel' })
    .click();
  const batch = await fetchSelection(page, 2);
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(3);
});

test('secondary rate limit も本文から見分けて知らせる（retry-after は読めない）', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  // 解除時刻まで待たずに確かめるため、ページの時計を進められるようにしておく。
  await page.clock.install();
  await start(page, mock);
  await connect(page);
  mock.secondaryRateLimitedResponses = 1;
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub API の利用上限に達しました');
  await expect(dialog(page).getByRole('alert')).not.toContainText('権限');
  // 解除時刻は分からないので、GitHub の案内どおり少なくとも1分は再試行させない。
  const retry = dialog(page).getByRole('button', { name: '再試行' });
  await expect(retry).toBeDisabled();
  await page.clock.fastForward('01:05');
  await expect(retry).toBeEnabled();
});

test('トークンが失効したら（401）、接続を切って接続し直してもらう', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  mock.tokenRevoked = true;
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub との接続が切れました');
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();
});

test('App が未インストールなら、インストール画面へ案内し、戻ったら再確認できる', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO], []);
  await start(page, mock);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();

  await expect(
    dialog(page).getByRole('heading', { name: 'アクセスできるリポジトリがありません' }),
  ).toBeVisible();
  await expect(
    dialog(page).getByRole('link', { name: 'GitHub Appをインストール / 権限を設定' }),
  ).toHaveAttribute('href', `https://github.com/apps/${E2E_APP_SLUG}/installations/new`);

  // 別タブでインストールを済ませた。インストールは API で確かめ直す。
  mock.installations = [{ id: 9, repositoryIds: [REPO.id] }];
  await dialog(page).getByRole('button', { name: '再確認' }).click();
  await expect(dialog(page).getByRole('button', { name: 'octo/novel' })).toBeVisible();
});

test('GitHub の画面で拒否したら、接続せずに理由を出す', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  mock.authorize = 'deny';
  await start(page, mock);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('承認が取り消されました');
  expect(mock.tokenCalls).toEqual([]);
  expect(new URL(page.url()).search).toBe('');
});

test('GitHub の画面からブラウザの「戻る」で引き返しても、もう一度接続できる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  mock.authorize = 'stay';
  await start(page, mock);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await page.waitForURL(/github\.com\/login\/oauth\/authorize/);

  await page.goBack();
  await page.waitForSelector('.brand__name');
  // bfcache から戻ればダイアログは開いたまま、読み込み直しなら閉じている。どちらでも押せること。
  if (!(await dialog(page).isVisible())) {
    await page.getByRole('button', { name: 'GitHubから追加' }).click();
  }
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();
  expect(mock.tokenCalls).toEqual([]);
});

test('state が一致しない戻りはコードを交換せず、URL と一時情報を片付ける', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  mock.authorize = 'wrongState';
  await start(page, mock);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();

  await expect(dialog(page).getByRole('alert')).toContainText('state が一致しません');
  expect(mock.tokenCalls).toEqual([]);
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();
});

test('トークン交換の途中で閉じたら接続を取り消し、あとから返った交換の結果で接続しない', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);

  // 交換の応答を止めておく（モックより後に張った route が先に効く）。
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => {};
  const exchangeStarted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route('**/api/github/token', async (route) => {
    reached();
    await held;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await exchangeStarted;
  // 認可から戻った画面は「接続しています」のまま、交換の応答を待っている。
  await expect(
    dialog(page).getByRole('heading', { name: 'GitHub に接続しています' }),
  ).toBeVisible();

  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await expect(dialog(page)).toHaveCount(0);
  release();

  // 交換は返ってくるが、その結果でトークンを持たない（一覧を取りに行かない）。
  await expect.poll(() => mock.tokenCalls.length).toBe(1);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  const consent = dialog(page).getByRole('region', { name: 'GitHub との接続' });
  await expect(consent.getByRole('alert')).toContainText('GitHub への接続を取り消しました');
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toHaveCount(0);
  expect(mock.apiCalls(/^\/user\/installations$/)).toEqual([]);
});

test('自分で始めていない戻り URL（直接開かれたもの）では何も交換しない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  await page.goto(`/?code=${E2E_CODE}&state=forged`);
  await expect(dialog(page).getByRole('alert')).toContainText('この画面で始めた接続ではない');
  expect(mock.tokenCalls).toEqual([]);
  expect(new URL(page.url()).search).toBe('');
});

test('ブラウザへの保存に失敗している間は、画面遷移する接続を始めさせない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  // 容量超過を起こす。setItem だけを失敗させる。
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name: string, value: string) {
      if (name === key) throw new Error('QuotaExceededError');
      return original.call(this, name, value);
    };
  }, STORAGE_KEY);
  await openApp(page);
  await page.locator('.input-card__title').fill('changed.md');
  await expect(page.locator('.save-error')).toBeVisible();

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('保存できていない作業が失われます');
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeDisabled();

  // その場から書き出せる（モーダルの外の「作業データ」を探させない）。保存できていない
  // 編集も、書き出したファイルには入っている。
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog(page).getByRole('button', { name: '作業データを書き出す' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^bulk-replace-workspace-\d{8}-\d{4}\.json$/);
  const exported = await readFile(await download.path(), 'utf8');
  expect(exported).toContain('changed.md');
  expect(mock.authorizeCalls).toEqual([]);
});

test('保存の直前（デバウンス中）に接続しても、書き出せなければ画面遷移しない', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  // 最初の保存は通し、編集のあとからだけ容量超過にする（警告がまだ出ていない状態を作る）。
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name: string, value: string) {
      if (name === key && (window as { __failSave?: boolean }).__failSave) {
        throw new Error('QuotaExceededError');
      }
      return original.call(this, name, value);
    };
  }, STORAGE_KEY);
  // 時計を止めて、デバウンス（400ms）の保存が走らないうちに接続を押す状況を確実に作る。
  await page.clock.install();
  await openApp(page);
  await page.clock.pauseAt(Date.now() + 60_000);

  await page.evaluate(() => {
    (window as { __failSave?: boolean }).__failSave = true;
  });
  await page.locator('.input-card__title').fill('changed.md');
  // まだ保存は走っていないので、警告は出ておらず、接続も押せる。
  await expect(page.locator('.save-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();

  // その場で書き出して失敗に気付き、GitHub へは移らない。中止の知らせと保存失敗の警告は
  // 役割を分け、書き出しの案内は1回だけ出す（同じ案内を2回読み上げさせない）。
  const alerts = dialog(page).getByRole('alert');
  await expect(alerts.filter({ hasText: 'GitHub への接続を中止しました' })).toHaveCount(1);
  await expect(alerts.filter({ hasText: '先に作業データを書き出してください' })).toHaveCount(1);
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeDisabled();
  await expect(page.locator('.save-error')).toBeVisible();
  expect(mock.authorizeCalls).toEqual([]);
  expect(new URL(page.url()).origin).toBe('http://127.0.0.1:4173');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();
  // 編集は画面に残っている（書き出して逃がせる）。
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('.input-card__title')).toHaveValue('changed.md');
});

test('保存の直前（デバウンス中）に接続しても、直前の編集を書き出してから移り、戻っても残っている', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  // 保存を記録する。画面を離れるとき（pagehide / 非表示）の書き出しは既存の保険なので、
  // それより前に「直前の編集を含む内容」が書かれたかを区別して残す。記録はタブをまたいで
  // 残るよう sessionStorage に置く（元の setItem で書き、記録そのものは数えない）。
  await page.addInitScript((key) => {
    let leaving = false;
    const markLeaving = (): void => {
      leaving = true;
    };
    window.addEventListener('pagehide', markLeaving, { capture: true });
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') markLeaving();
      },
      { capture: true },
    );
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name: string, value: string) {
      original.call(this, name, value);
      if (name === key && this === window.localStorage) {
        const log = JSON.parse(window.sessionStorage.getItem('e2e-saves') ?? '[]') as unknown[];
        log.push({ leaving, changed: value.includes('changed.md') });
        original.call(window.sessionStorage, 'e2e-saves', JSON.stringify(log));
      }
    };
  }, STORAGE_KEY);
  // 時計を止めて、デバウンス（400ms）の保存が走らないうちに接続を押す。
  await page.clock.install();
  await openApp(page);
  await page.clock.pauseAt(Date.now() + 60_000);

  await page.locator('.input-card__title').fill('changed.md');
  await connect(page);

  // GitHub へ移る前（離れる前）に、直前の編集を含む内容が書かれている。
  const saves = await page.evaluate(
    () =>
      JSON.parse(window.sessionStorage.getItem('e2e-saves') ?? '[]') as {
        leaving: boolean;
        changed: boolean;
      }[],
  );
  expect(saves.some((save) => save.changed && !save.leaving)).toBe(true);

  // 戻ってきたあとも編集は残っている。
  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('.input-card__title')).toHaveValue('changed.md');
});

test('キーボードだけでフォルダを辿ってファイルを選べる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);

  await dialog(page).getByRole('button', { name: 'octo/novel' }).focus();
  await page.keyboard.press('Enter');
  // 画面が変わったら見出しにフォーカスが移る（押したボタンが消えても迷子にならない）。
  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeFocused();

  await entry(page, 'chapters/').focus();
  await page.keyboard.press('Enter');
  await expect(entry(page, 'ch1.md')).toBeVisible();
  await entry(page, 'ch1.md').focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page).getByRole('heading', { name: 'ch1.md を取り込む' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await goToTab(page, '入力');
  await expect(page.locator('.input-card')).toHaveCount(1);
});

test('トークン交換が 429（Firewall のレート制限）なら、待ってから接続し直すよう伝える', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  mock.tokenStatus = 429;
  await start(page, mock);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();

  const alert = dialog(page).getByRole('alert');
  await expect(alert).toContainText('一時的に制限されています');
  await expect(alert).toContainText('少し時間をおいてから、もう一度接続してください');
  expect(mock.tokenCalls).toHaveLength(1);
  // 制限が解けたら、同じ画面から接続し直せる。
  mock.tokenStatus = 200;
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toBeVisible();
});

test('正規でないオリジンで開いたら、接続を始めさせず正規の URL へのリンクを出す', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  // 同じビルドを別名のオリジンで配る（Vercel の Production の別名と同じ状況）。
  // 名前解決に頼らず、別名への要求を配信元へ中継する。
  const alias = 'http://bulk-alias.test';
  await page.route(`${alias}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `http://127.0.0.1:4173${url.pathname}${url.search}`,
    });
    await route.fulfill({ response });
  });
  await page.goto(`${alias}/`);
  await page.waitForSelector('.brand__name');

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeDisabled();
  const notice = dialog(page).locator('.github__origin');
  await expect(notice).toContainText('このアドレスでは GitHub に接続できません');
  await expect(notice).toContainText('移った先には引き継がれません');
  // 自動では移らない（verifier も作業データもオリジンごとの保存先にある）。新しいタブで開く。
  const link = notice.getByRole('link', { name: 'http://127.0.0.1:4173/ を開く' });
  await expect(link).toHaveAttribute('href', 'http://127.0.0.1:4173/');
  await expect(link).toHaveAttribute('target', '_blank');
  expect(new URL(page.url()).origin).toBe(alias);

  // 認可にもトークン交換にも進んでいない。
  expect(mock.authorizeCalls).toEqual([]);
  expect(mock.tokenCalls).toEqual([]);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();
});

test('ファイル名の双方向制御文字は見える形で出し、取り込んだタイトルと出自は変えない', async ({
  page,
}) => {
  // 一覧では `invoicedm.txt` に見える名前（RLO で拡張子を偽装）。
  const spoofed = 'invoice\u202etxt.md';
  const mock = new GitHubMock([
    novelRepository({
      branches: {
        main: [
          { path: `bills/${spoofed}`, content: '請求書の原稿\n' },
          { path: 'bills/plain.md', content: 'ふつうの原稿\n' },
        ],
      },
    }),
  ]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await entry(page, 'bills/').click();

  const list = dialog(page).locator('.github__list');
  await expect(list).toContainText('invoice⟨U+202E⟩txt.md');
  const names = await list.locator('.github__entry-name').allTextContents();
  expect(names.join('\n')).not.toContain('\u202e');

  await dialog(page)
    .getByRole('button', { name: /invoice⟨U\+202E⟩txt\.md/ })
    .click();
  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm.getByRole('heading')).toHaveText('invoice⟨U+202E⟩txt.md を取り込む');
  await expect(confirm).toContainText('bills/invoice⟨U+202E⟩txt.md');
  await confirm.getByRole('button', { name: '入力に追加' }).click();
  await expect(page.locator('.toast')).toContainText(
    'GitHub から invoice⟨U+202E⟩txt.md を追加しました',
  );

  // 編集欄の値（データ）は元の名前のまま。見える形の名前を別に添える。
  const card = page.locator('.input-card').nth(1);
  await expect(card.locator('.input-card__title')).toHaveValue(spoofed);
  await expect(card.locator('.input-card__reveal')).toContainText('invoice⟨U+202E⟩txt.md');
  await expect(card.locator('.input-card__source')).toContainText('bills/invoice⟨U+202E⟩txt.md');
  // ふつうの名前の入力には何も添えない。
  await expect(page.locator('.input-card').nth(0).locator('.input-card__reveal')).toHaveCount(0);

  // 保存データのタイトルと出自のパスも元のまま（表示だけを変えている）。
  await dialog(page).waitFor({ state: 'detached' });
  await expect
    .poll(async () => {
      const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
      const saved = JSON.parse(raw ?? '{}') as {
        inputs?: { title: string; source?: { path: string } }[];
      };
      const input = saved.inputs?.[1];
      return [input?.title, input?.source?.path];
    })
    .toEqual([spoofed, `bills/${spoofed}`]);
});

test.describe('取り込む大きさの上限（5MiB）', () => {
  test('大きさの分かる 5MiB 超えは、一覧で理由を出して選ばせない', async ({ page }) => {
    const mock = new GitHubMock([
      novelRepository({
        branches: { main: [{ path: 'huge.md', content: 'a'.repeat(5 * MiB + 1) }] },
      }),
    ]);
    await start(page, mock);
    await connect(page);
    await openRepository(page);

    await expect(
      dialog(page).locator('.github__list .is-disabled', { hasText: 'huge.md' }),
    ).toContainText('5MiB を超えるため取り込めません');
    expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(0);
  });

  test('大きさの分からない 5MiB 超えは、取得の途中で止め、再試行を出さない', async ({ page }) => {
    const mock = new GitHubMock([
      novelRepository({
        branches: { main: [{ path: 'huge.md', content: 'a'.repeat(5 * MiB + 1) }] },
      }),
    ]);
    mock.omitTreeSizes = true;
    await start(page, mock);
    await connect(page);
    await openRepository(page);

    await entry(page, 'huge.md').click();
    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText('huge.md は 5MiB を超えるため取り込めません。');
    // 何度取っても大きさは変わらないので、再試行ではなく閉じるだけにする。
    await expect(alert.getByRole('button', { name: '再試行' })).toHaveCount(0);
    await expect(alert.getByRole('button', { name: '閉じる' })).toBeVisible();
    await expect(dialog(page).getByRole('region', { name: '取り込む内容の確認' })).toHaveCount(0);
    await expect(page.locator('.input-card')).toHaveCount(1);
  });

  test('大きさの分からない一括で合計が 5MiB を超えたら、途中で止めて入力を変えない', async ({
    page,
  }) => {
    const mock = new GitHubMock([
      novelRepository({
        branches: {
          main: [
            { path: 'big/a.md', content: 'a'.repeat(3 * MiB) },
            { path: 'big/b.md', content: 'b'.repeat(3 * MiB) },
          ],
        },
      }),
    ]);
    mock.omitTreeSizes = true;
    await start(page, mock);
    await connect(page);
    await openRepository(page);

    await dialog(page).getByRole('checkbox', { name: 'big フォルダを選択' }).check();
    await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
    const plan = dialog(page).getByRole('region', { name: '取り込むファイルの確認' });
    await expect(plan).toContainText(
      '取得の途中で合計が 5MiB を超えたら、そこで止めて取り込みません',
    );
    await plan.getByRole('button', { name: '2ファイルを取得' }).click();

    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText('選んだファイルの合計が 5MiB を超えるため');
    await expect(alert.getByRole('button', { name: '再試行' })).toHaveCount(0);
    await expect(
      dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' }),
    ).toHaveCount(0);
    await expect(page.locator('.input-card')).toHaveCount(1);
  });

  test('取り込むと保存容量を超えそうなら、入力に追加する前に確かめる', async ({ page }) => {
    const mock = new GitHubMock([
      novelRepository({
        branches: { main: [{ path: 'large.md', content: 'a'.repeat(4.5 * MiB) }] },
      }),
    ]);
    await start(page, mock);
    await connect(page);
    await openRepository(page);
    await entry(page, 'large.md').click();
    const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
    await confirm.getByRole('button', { name: '入力に追加' }).click();

    const storage = page.getByRole('dialog', { name: 'ブラウザに保存できない可能性があります' });
    await expect(storage).toContainText('large.md');
    // やめたら何も変えず、候補の確認に戻る。
    await storage.getByRole('button', { name: 'キャンセル' }).click();
    await expect(storage).toHaveCount(0);
    await expect(page.locator('.input-card')).toHaveCount(1);
    await expect(confirm).toBeVisible();

    await confirm.getByRole('button', { name: '入力に追加' }).click();
    await storage.getByRole('button', { name: '取り込む' }).click();
    // 大きな本文の描画に時間がかかり、トーストは確かめる前に消えることがあるので、入力で見る。
    await expect(page.locator('.input-card')).toHaveCount(2);
    await expect(page.locator('.input-card').nth(1).locator('.input-card__source')).toContainText(
      'octo/novel · large.md',
    );
  });
});

// ---- 通信が止まったとき（issue #20） ----------------------------------------------
//
// 応答を止めたまま `page.clock` で時間を進め、案内 → 中断 → 次の手の流れを見る。
// 秒数は `src/lib/githubApi.ts` / `src/lib/githubAuth.ts` の定数と同じ。

/** トークン交換の応答を `release` まで止める。止めている間に届いたかを `reached` で待てる。 */
async function holdExchange(page: Page) {
  let open = (): void => {};
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reach = (): void => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const handler = async (route: Route): Promise<void> => {
    reach();
    await released;
    await route.fallback().catch(() => {});
  };
  await page.route('**/api/github/token', handler);
  return {
    reached,
    release: async (): Promise<void> => {
      open();
      await page.unroute('**/api/github/token', handler);
    },
  };
}

function tokenRequests(mock: GitHubMock) {
  return mock.requests.filter((request) => request.url.endsWith('/api/github/token'));
}

test('トークン交換が返らなければ、案内のあと中断し、同じコードで再試行させず認可からやり直す', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await page.clock.install();
  await start(page, mock);
  const exchange = await holdExchange(page);

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await exchange.reached;
  const consent = dialog(page).getByRole('region', { name: 'GitHub との接続' });
  await expect(consent.getByRole('heading', { name: 'GitHub に接続しています' })).toBeVisible();
  await expect(consent).not.toContainText('時間がかかっています');

  // 8 秒で「閉じれば取り消せる」ことを添える（閉じる操作を知っている前提にしない）。
  await page.clock.fastForward(8_000);
  await expect(consent.getByRole('status')).toContainText(
    '時間がかかっています。閉じると接続を取り消します',
  );

  // 25 秒で諦め、「もう一度接続」（認可からやり直す）だけを出す。再試行は出さない。
  await page.clock.fastForward(17_000);
  await expect(consent.getByRole('alert')).toContainText('応答がありませんでした');
  await expect(consent.getByRole('alert')).toContainText('認可の画面からやり直します');
  await expect(dialog(page).getByRole('button', { name: '再試行' })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();

  // 止めていた応答があとから届いても、その結果では接続しない。
  await exchange.release();
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toHaveCount(0);
  expect(mock.apiCalls(/^\/user\/installations$/)).toEqual([]);
  // 同じコードを送り直していない（交換の送信は1回だけ）。
  expect(tokenRequests(mock)).toHaveLength(1);

  // 「GitHubに接続」は認可から始め直す（新しい state）。
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toBeVisible();
  expect(mock.authorizeCalls).toHaveLength(2);
  expect(mock.authorizeCalls[1]?.get('state')).not.toBe(mock.authorizeCalls[0]?.get('state'));
  expect(tokenRequests(mock)).toHaveLength(2);
});

test('一覧が返らなければ、案内のあと中断して再試行を出し、再試行で続けられる', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await page.clock.install();
  await start(page, mock);
  const installations = await hold(page, /\/user\/installations(\?|$)/);

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();
  await expect.poll(() => installations.held.length).toBe(1);
  await expect(dialog(page).getByRole('status').first()).toContainText(
    'リポジトリを読み込んでいます',
  );

  await page.clock.fastForward(8_000);
  await expect(dialog(page)).toContainText(
    '時間がかかっています。閉じると中断できます（作業データはそのまま残ります）。',
  );

  // 1リクエストの上限（30 秒）で中断し、失敗として見せる（読み込み中のまま残さない）。
  await page.clock.fastForward(22_000);
  const alert = dialog(page).getByRole('alert');
  await expect(alert).toContainText('GitHub から 30 秒応答がなかったため中断しました');
  await expect(dialog(page)).not.toContainText('時間がかかっています');
  await expect.poll(() => installations.failed.length).toBe(1);

  await installations.release();
  await alert.getByRole('button', { name: '再試行' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'リポジトリを選ぶ' })).toBeVisible();
});

test('時間がかかっている途中で閉じたら、失敗は出さずに中断し、あとから時間が経っても知らせない', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await page.clock.install();
  await start(page, mock);
  await connect(page);
  const trees = await hold(page, /\/git\/trees\//);

  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();
  await expect.poll(() => trees.held.length).toBe(1);
  await page.clock.fastForward(8_000);
  await expect(dialog(page)).toContainText('時間がかかっています');

  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await expect(dialog(page)).toHaveCount(0);
  // 閉じる＝中断（要求は実際に止まる）。
  await expect.poll(() => trees.failed.length).toBe(1);

  // 上限を過ぎても、閉じた取得の時間切れは知らせない。
  await page.clock.fastForward(60_000);
  await trees.release();
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeVisible();
  await expect(dialog(page)).not.toContainText('応答がなかった');
  await expect(dialog(page)).not.toContainText('時間がかかっています');
});

test('端末がオフラインなら、ネットワーク障害一般と区別して知らせる', async ({ page, context }) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  // `setOffline` は navigator.onLine を false にするが、route で置き換えた要求は応答してしまう。
  // 回線が切れたときと同じく、要求そのものも切断で落とす。
  const offlineTrees = (url: URL): boolean => url.href.includes('/git/trees/');
  const disconnect = (route: Route): Promise<void> => route.abort('internetdisconnected');
  await page.route(offlineTrees, disconnect);
  await context.setOffline(true);
  await entry(page, 'chapters/').click();
  const alert = dialog(page).getByRole('alert');
  await expect(alert).toContainText('端末がオフラインのため');

  await page.unroute(offlineTrees, disconnect);
  await context.setOffline(false);
  await alert.getByRole('button', { name: '再試行' }).click();
  await expect(entry(page, 'ch1.md')).toBeVisible();
});

test('トークンの期限が切れても、取得済みの一括の確認画面を開き直して確定できる', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  // 期限（expires_in 8時間）を待たずに確かめるため、ページの時計を進められるようにしておく。
  await page.clock.install();
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  await dialog(page).getByRole('button', { name: '閉じる' }).click();

  await page.clock.fastForward('09:00:00');
  const calls = mock.apiCalls(/./).length;

  // 開いただけでは期限切れとして切断しない（取得済みの内容と決めた取り込み方法を捨てない）。
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(3);
  expect(mock.apiCalls(/./)).toHaveLength(calls);

  // 次に GitHub へ要求する時点で、期限切れとして接続し直してもらう。
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await entry(page, 'chapters/').click();
  await expect(dialog(page).getByRole('alert')).toContainText('有効期限が切れました');
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();
  expect(mock.apiCalls(/./)).toHaveLength(calls);
});

test('接続を解除したあとで一括取り込みを元に戻すと、入力は戻るが、捨てた確認画面は開き直さない', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);
  await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
  const batch = await fetchSelection(page, 2);
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(3);

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'このタブの接続を解除' }).click();
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeVisible();
  await dialog(page).getByRole('button', { name: '閉じる' }).click();

  await page.locator('.toast').getByRole('button', { name: '元に戻す' }).click();
  await expect(page.locator('.input-card')).toHaveCount(1);
  // 接続を捨てたときに、確認画面へ戻すための控えも捨ててある。
  await expect(dialog(page)).toHaveCount(0);
});

test('接続の準備（PKCE のハッシュ）に失敗したら、接続中のまま残さず理由を出す', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await page.addInitScript(() => {
    SubtleCrypto.prototype.digest = () => Promise.reject(new Error('digest failed'));
  });
  await seed(page);
  await openApp(page);
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await dialog(page).getByRole('button', { name: 'GitHubに接続' }).click();

  const consent = dialog(page).getByRole('region', { name: 'GitHub との接続' });
  await expect(consent.getByRole('alert')).toContainText('接続の準備に失敗しました');
  await expect(consent.getByRole('heading')).toHaveText('接続する前に');
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeEnabled();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();
  expect(new URL(page.url()).origin).not.toBe('https://github.com');
});

test('取得中の表示でも、ファイル名の双方向制御文字を見える形で出す', async ({ page }) => {
  const spoofed = 'invoice\u202etxt.md';
  const mock = new GitHubMock([
    novelRepository({ branches: { main: [{ path: spoofed, content: '請求書の原稿\n' }] } }),
  ]);
  await start(page, mock);
  await connect(page);
  await openRepository(page);

  const blobs = await hold(page, /\/git\/blobs\//);
  await dialog(page)
    .getByRole('button', { name: /invoice⟨U\+202E⟩txt\.md/ })
    .click();
  const status = dialog(page).locator('.github__status').first();
  await expect(status).toContainText('invoice⟨U+202E⟩txt.md を取得しています');
  expect(await status.textContent()).not.toContain('\u202e');
  await blobs.release();
  await expect(dialog(page).getByRole('region', { name: '取り込む内容の確認' })).toBeVisible();
});

test('保存に失敗している間は、1件の取り込みも止めて書き出しへ案内する', async ({ page }) => {
  const mock = new GitHubMock([REPO]);
  await mock.install(page);
  await seed(page);
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name: string, value: string) {
      if (name === key && (window as { failSave?: boolean }).failSave) {
        throw new Error('QuotaExceededError');
      }
      return original.call(this, name, value);
    };
  }, STORAGE_KEY);
  await openApp(page);
  await connect(page);
  await openRepository(page);
  await dialog(page).getByRole('button', { name: '閉じる' }).click();

  await page.evaluate(() => {
    (window as { failSave?: boolean }).failSave = true;
  });
  await page.locator('.input-card__title').fill('changed.md');
  await expect(page.locator('.save-error')).toBeVisible();

  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await entry(page, 'chapters/').click();
  await entry(page, 'ch1.md').click();
  const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
  await expect(confirm.getByRole('alert')).toContainText('いまブラウザへの保存に失敗しています');
  await expect(confirm.getByRole('button', { name: '入力に追加' })).toBeDisabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    confirm.getByRole('button', { name: '作業データを書き出す' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  await expect(page.locator('.input-card')).toHaveCount(1);
});

test.describe('空欄1つだけの入力', () => {
  async function startWithBlank(page: Page, mock: GitHubMock): Promise<void> {
    await mock.install(page);
    await seedWorkspace(page, {
      inputs: [{ id: 'blank', title: 'ch1.md', text: '' }],
      groups: [{ id: 'g1', name: 'A用' }],
      rules: [makeRule('r1', 'アリス', { g1: 'あーちゃん' })],
    });
    await openApp(page);
  }

  test('一括取り込みでも、通常の取り込みと同じく取り込んだファイルで置き換える', async ({
    page,
  }) => {
    const mock = new GitHubMock([REPO]);
    await startWithBlank(page, mock);
    await connect(page);
    await openRepository(page);
    await dialog(page).getByRole('checkbox', { name: 'chapters フォルダを選択' }).check();
    const batch = await fetchSelection(page, 2);
    // 置き換わる空欄との同名は警告しない。
    await expect(batch).not.toContainText('同じファイル名の別入力があります');
    await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
    await expect(page.locator('.input-card')).toHaveCount(2);
    await expect(page.locator('.input-card__title').first()).toHaveValue('ch1.md');
    await expect(page.locator('.input-card__source').first()).toContainText('chapters/ch1.md');
  });

  test('1件の取り込みでも、置き換わる空欄との同名は警告しない', async ({ page }) => {
    const mock = new GitHubMock([REPO]);
    await startWithBlank(page, mock);
    await connect(page);
    await openRepository(page);
    await entry(page, 'chapters/').click();
    await entry(page, 'ch1.md').click();
    const confirm = dialog(page).getByRole('region', { name: '取り込む内容の確認' });
    await expect(confirm.getByRole('button', { name: '入力に追加' })).toBeVisible();
    await expect(confirm).not.toContainText('同じファイル名の入力が別にあります');
    await confirm.getByRole('button', { name: '入力に追加' }).click();
    await expect(page.locator('.input-card')).toHaveCount(1);
  });
});
