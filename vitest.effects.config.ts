import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/effects/**/*.test.ts', 'eslint-local-rules/effects.test.ts'],
    exclude: ['tools/effects/fixtures/**'],
    maxWorkers: 2,
  },
});
