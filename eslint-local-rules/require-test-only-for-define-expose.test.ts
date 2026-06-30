import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import fs from 'fs';
import path from 'path';
import * as tsParser from '@typescript-eslint/parser';
import * as parser from 'vue-eslint-parser';
import { rule } from './require-test-only-for-define-expose.js';

describe('require-test-only-for-define-expose rule', () => {
  let eslint: ESLint;
  let eslintFix: ESLint;
  const testFileDir = path.resolve(__dirname, '../src/test-tmp');
  const testFileName = `temp-define-expose-lint-${Math.random().toString(36).slice(2)}.vue`;
  const testFilePath = path.resolve(testFileDir, testFileName);

  beforeAll(() => {
    fs.mkdirSync(testFileDir, { recursive: true });

    const baseConfig = {
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.vue'],
        languageOptions: {
          parser,
          parserOptions: {
            parser: tsParser,
            sourceType: 'module',
          },
        },
        plugins: {
          'local-rules-define-expose': {
            rules: {
              'require-test-only-for-define-expose': rule,
            },
          },
        },
        rules: {
          'local-rules-define-expose/require-test-only-for-define-expose': 'error',
        },
      },
    };

    eslint = new ESLint({ ...baseConfig, fix: false });
    eslintFix = new ESLint({ ...baseConfig, fix: true });
  });

  afterAll(() => {
    fs.rmSync(testFilePath, { force: true });
  });

  async function lint(code: string) {
    fs.writeFileSync(testFilePath, code);
    const [result] = await eslint.lintFiles([testFilePath]);
    return result;
  }

  async function fix(code: string) {
    fs.writeFileSync(testFilePath, code);
    const [result] = await eslintFix.lintFiles([testFilePath]);
    return result;
  }

  it('reports and fixes a missing defineExpose', async () => {
    const result = await fix(`<script setup lang="ts">
const value = 1;
</script>`);

    expect(result.output).toContain('defineExpose({');
    expect(result.output).toContain('...((__BUILD_MODE_IS_TEST__ && {');
    expect(result.output).toContain('TEST_ONLY: {');
  });

  it('reports and fixes a defineExpose missing TEST_ONLY', async () => {
    const result = await fix(`<script setup lang="ts">
defineExpose({
  value: 1,
});
</script>`);

    expect(result.output).toMatch(/value: 1,\s+\.\.\.\(\(__BUILD_MODE_IS_TEST__/);
    expect(result.output).toContain('// ESLint-required for defineExpose.');
  });

  it('accepts the exact guarded spread', async () => {
    const result = await lint(`<script setup lang="ts">
defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      internal: true,
    },
  }) || {}),
});
</script>`);

    expect(result.messages).toHaveLength(0);
  });

  it('rejects an unguarded TEST_ONLY property', async () => {
    const result = await lint(`<script setup lang="ts">
defineExpose({
  TEST_ONLY: {
    internal: true,
  },
});
</script>`);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('invalidTestOnlyGuard');
    expect(result.messages[0]?.message).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('fixes an empty defineExpose object', async () => {
    const result = await fix(`<script setup lang="ts">
defineExpose({});
</script>`);

    expect(result.output).toContain('...((__BUILD_MODE_IS_TEST__ && {');
  });

  it('reports defineExpose without an object argument', async () => {
    const result = await lint(`<script setup lang="ts">
defineExpose();
</script>`);

    expect(result.messages.some((message) => message.messageId === 'missingTestOnly')).toBe(true);
  });

  it('adds script setup to a template-only component', async () => {
    const result = await fix('<template><div /></template>');

    expect(result.output).toContain('<script setup lang="ts">');
    expect(result.output).toContain('__BUILD_MODE_IS_TEST__');
  });
});
