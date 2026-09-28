import { createHash } from 'node:crypto';
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
  return dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
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
  await expect(consent).toContainText('再読み込みやタブを閉じたあとは、もう一度接続が必要');
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

  // アドレスバーから code / state が消え、一時情報も残らない。
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();

  // API には固定した版とトークンを付けて行く。
  const call = mock.apiCalls(/^\/user\/installations$/)[0];
  expect(call?.headers.authorization).toBe(`Bearer ${E2E_TOKEN}`);
  // GitHub の CORS が許可していないヘッダは付けない（付けると本番の preflight で止まる）。
  expect(call?.headers['x-github-api-version']).toBeUndefined();
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

test('大きな選択は、取得の前にブラウザへ保存できない可能性を警告する', async ({ page }) => {
  const repository = novelRepository({
    branches: {
      main: [
        { path: 'big/huge.md', content: 'あ'.repeat(800_000) },
        { path: 'big/small.md', content: '小さい\n' },
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
  await expect(plan).toContainText('保存に失敗する可能性があります');
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(0);
});

test('数えている間はチェックを変えられず、取得の途中で閉じれば残りの取得を中断する', async ({
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
  await page.getByRole('button', { name: 'GitHubから追加' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeVisible();
  await expect(chapters).toBeChecked();
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
  await expect(plan).toContainText('ほか 20件');

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

test('更新先が選択欄に並べきれないほどあっても、入力の番号で指定して更新できる', async ({
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
  await expect(batch).toContainText('ほかに5件あります');

  const number = batch.getByRole('textbox', { name: 'chapters/ch1.md の更新先の入力の番号' });
  await number.fill('999');
  await batch.getByRole('button', { name: 'この番号を更新' }).click();
  await expect(batch.getByRole('alert')).toContainText(
    '999 はこのファイルから取り込んだ入力の番号ではありません',
  );
  await expect(decision).toHaveValue('');

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
