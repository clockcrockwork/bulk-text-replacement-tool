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

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // CI で .only の付け忘れを落とす。
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // 開発サーバーではなく本番ビルドを検証する（実際に配信する成果物と同じものを見る）。
  webServer: {
    command: `npm run build && npm run preview -- --host ${HOST} --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
