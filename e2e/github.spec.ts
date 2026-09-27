import { createHash } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
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
  await expect(chapters).toHaveAttribute('aria-checked', 'mixed');

  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();
  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch).toContainText('chapters/ch1.md');
  await expect(batch).not.toContainText('chapters/ch2.txt');
  await batch.getByRole('button', { name: '1ファイルを取り込む' }).click();

  await expect(page.locator('.input-card')).toHaveCount(2);
  await expect(page.locator('.input-card__source').nth(0)).toContainText('chapters/ch1.md');
  expect(mock.apiCalls(/\/git\/blobs\//)).toHaveLength(1);
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
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(page.locator('.input-card')).toHaveCount(1);

  mock.failPaths = [];
  await dialog(page).getByRole('button', { name: '再試行' }).click();
  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch).toContainText('2ファイルを取り込む');
  await expect(page.locator('.input-card')).toHaveCount(1);

  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();
  await expect(page.locator('.input-card')).toHaveCount(3);
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
  await dialog(page).getByRole('button', { name: '選択したファイルを確認' }).click();

  const batch = dialog(page).getByRole('region', { name: '複数ファイルの取り込み確認' });
  await expect(batch.locator('.github__batch-warning')).toHaveCount(2);
  await batch.getByRole('button', { name: '2ファイルを取り込む' }).click();

  await expect(page.locator('.input-card')).toHaveCount(3);
  await expect(page.locator('.input-card__source')).toHaveText([/a\/ch1\.md/, /b\/ch1\.md/]);
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
  await start(page, mock);
  await connect(page);
  mock.rateLimitedResponses = 1;
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub API の利用上限に達しました');
  await dialog(page).getByRole('button', { name: '再試行' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'ファイルを選ぶ' })).toBeVisible();
});

test('secondary rate limit も本文から見分けて知らせる（retry-after は読めない）', async ({
  page,
}) => {
  const mock = new GitHubMock([REPO]);
  await start(page, mock);
  await connect(page);
  mock.secondaryRateLimitedResponses = 1;
  await dialog(page).getByRole('button', { name: 'octo/novel' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('GitHub API の利用上限に達しました');
  await expect(dialog(page).getByRole('alert')).not.toContainText('権限');
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
