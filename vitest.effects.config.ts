import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/effects/**/*.test.ts'],
    maxWorkers: 2,
  },
});
