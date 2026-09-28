import { defineConfig, devices } from '@playwright/test';

/** ビルド成果物を配信するポート。webServer と baseURL で共有する。 */
const PORT = 4173;
/**
 * 待ち受けアドレスを IPv4 で固定する。
 * `vite preview` の既定ホストは `localhost` で、デュアルスタックの CI ランナーでは
 * `::1` 側にだけ束縛されることがある。その場合 Playwright の `127.0.0.1` へのポーリングが
 * 永久に繋がらず、webServer の起動待ちがタイムアウトする。
 */
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;

/** 狭い画面専用のテスト。デスクトップの projects からは除外する。 */
const MOBILE_SPECS = /e2e[\\/]mobile[\\/]/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // CI で .only の付け忘れを落とす。
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // html レポートは CI だけ。ローカルでも出すと、毎回の実行で playwright-report/ が
  // 作り直され、見ないファイルが作業ツリーに積み上がる（必要なら --reporter=html）。
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: ORIGIN,
    trace: 'on-first-retry',
  },
  projects: [
    // スマホ利用と Safari を保証対象にしているので、WebKit も回帰に含める。
    // （Playwright の WebKit は Safari そのものではないので、最終確認は実機で別途行う）
    { name: 'chromium', testIgnore: MOBILE_SPECS, use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', testIgnore: MOBILE_SPECS, use: { ...devices['Desktop Safari'] } },
    // 狭い画面ではルール表がカード表示に変わるため、レイアウト前提の違うテストを分けている。
    { name: 'mobile-safari', testMatch: MOBILE_SPECS, use: { ...devices['iPhone 15'] } },
  ],
  // 開発サーバーではなく本番ビルドを検証する（実際に配信する成果物と同じものを見る）。
  webServer: {
    command: `npm run build && npm run preview -- --host ${HOST} --port ${PORT} --strictPort`,
    url: ORIGIN,
    // 既存サーバーを使い回すと build ごとスキップされ、古い dist を検証して
    // 緑になることがある。常に建て直す（ポートが塞がっていれば明示的に失敗する）。
    reuseExistingServer: false,
    timeout: 180_000,
    // 既定は 'ignore' で、起動に失敗しても build / preview の出力が丸ごと消える。
    // webServer が上がらない類の失敗を診断できるようにしておく。
    stdout: 'pipe',
    stderr: 'pipe',
    // GitHub 連携の公開設定。E2E では GitHub をモックするので、実在しない値でよい。
    // これが無いビルドでは「GitHubから追加」が無効になり、その流れを検証できない。
    env: {
      VITE_GITHUB_APP_CLIENT_ID: 'Iv23-e2e-client',
      VITE_GITHUB_APP_SLUG: 'bulk-replace-e2e',
      // 正規のオリジンを配信元に固定する。別のホスト名で開いたときの振る舞いは
      // github.spec.ts が、同じビルドを別名のオリジンへ中継して確かめる。
      VITE_GITHUB_APP_ORIGIN: ORIGIN,
    },
  },
});
