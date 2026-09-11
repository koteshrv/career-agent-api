import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // Every test shares one real Postgres database and resets it between
    // tests (see resetDatabase in test/helpers.ts) — two test files running
    // concurrently would truncate tables out from under each other.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
