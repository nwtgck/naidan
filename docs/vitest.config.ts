import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { docsCompilerPlugins } from './build/compiler';

// Compile the actual Docs modules without initializing app/model build tooling.
const docsRoot = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  define: { __BUILD_MODE_IS_TEST__: 'true' },
  plugins: docsCompilerPlugins({ root: docsRoot, allowTestArticleTranslations: true }),
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['docs/**/*.test.ts'],
    maxWorkers: 1,
    // Docs build fixtures need headroom while CI jobs share CPU resources.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
