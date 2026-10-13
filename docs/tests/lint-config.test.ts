import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('../..', import.meta.url));

describe('Docs lint ownership', () => {
  it('keeps source, translations, tests and the dev bridge under the normal typed lint rules', async () => {
    const eslint = new ESLint({ cwd });
    for (const file of ['docs/pages/index.vue', 'docs/pages/run/standalone.vue', 'docs/site/demos/ReplicaChrome.vue', 'docs/strings/index/ja.ts', 'docs/build/html.ts', 'docs/tests/root-entry.test.ts', 'build/docs-dev-bridge.ts']) {
      expect(await eslint.isPathIgnored(file), file).toBe(false);
      const config = await eslint.calculateConfigForFile(file);
      expect(config.languageOptions.parserOptions.project, file).toEqual(['./docs/tsconfig.json']);
      expect(config.rules['local-rules-object-layout/object-layout'], file).toBeDefined();
      if (!file.endsWith('.test.ts')) expect(config.rules['local-rules-named-args/require-named-args'], file).toBeDefined();
    }
    for (const file of ['docs/dist/en/index.html', 'docs/.cache/renderer.js']) {
      expect(await eslint.isPathIgnored(file), file).toBe(true);
    }
  });
});
