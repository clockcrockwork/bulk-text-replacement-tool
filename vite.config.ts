import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
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
    },
  },
});
