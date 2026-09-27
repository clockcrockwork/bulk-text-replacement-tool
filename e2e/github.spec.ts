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
  const afterCallback = referers.slice(
    referers.findIndex((entry) => entry.url.includes(`code=${E2E_CODE}`)) + 1,
  );
  expect(afterCallback.some((entry) => /\/assets\/.+\.js$/.test(entry.url))).toBe(true);
  for (const { url, referer } of referers) {
    expect(referer ?? '', url).not.toContain('code=');
    expect(referer ?? '', url).not.toContain('state=');
  }
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

  // その場で書き出して失敗に気付き、GitHub へは移らない。
  await expect(dialog(page).getByRole('alert').first()).toContainText('接続を中止しました');
  await expect(dialog(page).getByRole('button', { name: 'GitHubに接続' })).toBeDisabled();
  await expect(page.locator('.save-error')).toBeVisible();
  expect(mock.authorizeCalls).toEqual([]);
  expect(new URL(page.url()).origin).toBe('http://127.0.0.1:4173');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_AUTH_KEY)).toBeNull();
  // 編集は画面に残っている（書き出して逃がせる）。
  await page.getByRole('button', { name: '閉じる' }).click();
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
  await expect(alert).toContainText('1分ほど待ってから、もう一度接続してください');
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
