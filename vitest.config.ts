import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Integration tests share one database, so files run one after another.
    fileParallelism: false,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/server.ts'],
    },
  },
});
