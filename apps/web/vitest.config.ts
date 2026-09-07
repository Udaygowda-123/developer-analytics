import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(here, './src'),
      // Point at the shared package's source: the isomorphic entrypoint is
      // plain TypeScript, and resolving to `dist` would mean a stale build
      // could make tests pass against code that no longer exists.
      '@pulse/shared': path.resolve(here, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    css: false,
    coverage: {
      provider: 'v8',
      include: ['src/components/**', 'src/lib/**'],
      exclude: ['src/**/*.test.*'],
      reporter: ['text', 'lcov'],
    },
  },
});
