import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Compile the actual Docs modules without initializing app/model build tooling.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  define: { __BUILD_MODE_IS_TEST__: 'true' },
  plugins: [vue({ features: { componentIdGenerator: 'filepath' } })],
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['docs/**/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
