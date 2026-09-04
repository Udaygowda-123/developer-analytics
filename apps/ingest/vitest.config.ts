import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    // mongodb-memory-server downloads and boots a real mongod on first use.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // Integration tests share one in-memory Mongo per file; running files in
    // parallel would spawn several mongod processes and thrash a laptop.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/alerts/emails/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
