import { describe, expect, it } from 'vitest';
import { ESLint, Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import { rule as resourceRule } from './test-resource-management.js';
import { rule as importsRule } from './no-test-support-imports.js';
import { isTestFile, isTestSupportFile } from './test-resource-ast.js';
import { fileURLToPath } from 'node:url';

const ruleId = 'local-rules-test-resource/test-resource-management';

function createEslint() {
  return new ESLint({ overrideConfigFile: fileURLToPath(new URL('../eslint.config.js', import.meta.url)) });
}

describe('test-resource policy integration', () => {
  it.each(['scripts/example.ts', 'eslint-local-rules/example.test.ts', 'src/runtime.ts', 'pwa/runtime.ts', 'src/View.vue', 'scripts/View.vue', 'src/runtime.mts', 'src/runtime.cts', 'src/runtime.tsx', 'src/runtime.mjs', 'src/runtime.cjs'])('checks owned file %s even when type-aware lint excludes it', async filePath => {
    const config = await createEslint().calculateConfigForFile(filePath);
    expect(config?.rules?.[ruleId]?.[0]).toBe(2);
  });

  it('does not enable unrelated type-aware rules or reject their inline directives', async () => {
    const results = await createEslint().lintText('// eslint-disable-next-line local-rules-named-args/require-named-args\nfunction f(value) { return value; }\n', { filePath: 'scripts/example.ts' });
    expect(results[0]?.messages).toEqual([]);
  });

  it('enforces the declaration restriction through the actual main config', async () => {
    const results = await createEslint().lintText('using value = create();', { filePath: 'scripts/example.ts' });
    expect(results[0]?.messages.map(message => message.messageId)).toContain('usingOnlyInTest');
  });

  it('treats suffixes as physical filenames, not substrings or query-decorated IDs', () => {
    expect(isTestFile({ filename: 'C:\\repo\\example.test.ts' })).toBe(true);
    expect(isTestSupportFile({ filename: 'C:\\repo\\example.test-support.ts' })).toBe(true);
    for (const filename of ['example.test-support.ts.vue', 'example.test-support.tsx', 'example.test-support.ts?raw', 'example.test-support.ts/runtime.ts']) {
      expect(isTestSupportFile({ filename })).toBe(false);
      expect(isTestFile({ filename })).toBe(false);
    }
  });

  it.each(['src/View.vue', 'src/runtime.ts', 'src/helper.test-support.ts'])('does not grant using permission through a virtual test filename: %s', filename => {
    const messages = new Linter().verify('ignored', [{
      files: [filename],
      plugins: {
        extract: {
          processors: {
            script: {
              preprocess: () => [{ filename: 'virtual.test.ts', text: 'using resource = make(); Symbol.dispose; import helper from "./helper.test-support";' }],
              postprocess: messages => messages.flat(),
            },
          },
        },
      },
      processor: 'extract/script',
    }, {
      files: ['**/*.ts'],
      languageOptions: { parser: tsParser },
      plugins: { policy: { rules: { resource: resourceRule, imports: importsRule } } },
      rules: { 'policy/resource': 'error', 'policy/imports': 'error' },
    }], { filename, filterCodeBlock: () => true });
    expect(messages.some(message => message.fatal)).toBe(false);
    expect(messages.map(message => message.messageId)).toContain('usingOnlyInTest');
    if (!filename.endsWith('.test-support.ts')) {
      expect(messages.map(message => message.messageId)).toContain('protocolOnlyInTest');
      expect(messages.map(message => message.messageId)).toContain('forbidden');
    }
  });

});
