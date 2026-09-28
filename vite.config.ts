import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** vercel.json で、アプリの配信物（`/api/` 以外）に付けるヘッダの対象。 */
const APP_HEADERS_SOURCE = '/((?!api/).*)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * vercel.json がアプリの配信物に付けるヘッダを読む。
 *
 * `vite preview`（E2E の配信元）でも同じヘッダを返すために使う。値を2か所に書くと、
 * 本番だけ別のヘッダで動き、E2E では OAuth の戻りや描画を壊すヘッダに気付けない。
 * 共有するのは値だけで、`source` のパス条件は再現しない（preview は全応答に付ける）。
 * preview には `/api/` が無いので食い違いは出ないが、除外が効くことは Vercel 上で確かめる。
 * 形が想定と違えば設定の読み込みで落とす（黙ってヘッダ無しで検証しない）。
 */
function readAppHeaders(): Record<string, string> {
  const config: unknown = JSON.parse(
    readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'),
  );
  const rules: readonly unknown[] =
    isRecord(config) && Array.isArray(config.headers) ? config.headers : [];
  const rule = rules.find((item) => isRecord(item) && item.source === APP_HEADERS_SOURCE);
  const entries = isRecord(rule) ? rule.headers : null;
  if (!Array.isArray(entries)) {
    throw new Error(`vercel.json に ${APP_HEADERS_SOURCE} のヘッダがありません`);
  }
  const list: readonly unknown[] = entries;
  const headers: Record<string, string> = {};
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
      throw new Error('vercel.json のヘッダは key と value の文字列で書いてください');
    }
    headers[entry.key] = entry.value;
  }
  return headers;
}

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // 本番には出さない。本体 269KB に対して map は 1.2MB あり、配信物の大半が
    // 読み手のいないファイルになる。公開リポジトリなのでソース自体は誰でも読めるが、
    // 配布物に含める理由が無い。
    sourcemap: false,
  },
  preview: {
    headers: readAppHeaders(),
  },
  test: {
    environment: 'node',
    // .test.tsx を足しても黙って無視されないようにしておく。
    // api/ は Vercel Function（トークン交換）。ブラウザ側と同じくユニットテストで押さえる。
    // scripts/lib/ は CI の検査（Action の SHA 固定）。境界条件がそのまま仕様なので同じく押さえる。
    include: ['src/**/*.test.{ts,tsx}', 'api/**/*.test.ts', 'scripts/lib/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 計測対象はロジック層だけ。UI の網は E2E（e2e/）が持つ。
      include: ['src/lib/**/*.ts', 'src/state/**/*.ts', 'api/_lib/**/*.js', 'scripts/lib/**/*.js'],
      exclude: ['src/**/*.test.ts', 'src/lib/browser.ts'],
      // 現状（statements 97% / branches 87%）から目立って下がったら落とす。
      // 数字を追うためではなく、テストを書かずにロジックを足すのを防ぐための歯止め。
      thresholds: { statements: 96, branches: 87, functions: 98, lines: 98 },
    },
  },
});
