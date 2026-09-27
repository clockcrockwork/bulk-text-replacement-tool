import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
  test: {
    environment: 'node',
    // .test.tsx を足しても黙って無視されないようにしておく。
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 計測対象はロジック層だけ。UI の網は E2E（e2e/）が持つ。
      include: ['src/lib/**/*.ts', 'src/state/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/lib/browser.ts'],
      // 現状（statements 97% / branches 87%）から目立って下がったら落とす。
      // 数字を追うためではなく、テストを書かずにロジックを足すのを防ぐための歯止め。
      thresholds: { statements: 96, branches: 87, functions: 98, lines: 98 },
    },
  },
});
