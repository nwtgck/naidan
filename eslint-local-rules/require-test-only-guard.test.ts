import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import fs from 'fs';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './require-test-only-guard.js';

describe('require-test-only-guard rule', () => {
  let eslint: ESLint;
  const testFileDir = path.resolve(__dirname, '../src/lint-rule-tmp');
  const testFilePath = path.resolve(testFileDir, `temp-test-only-guard-${Math.random().toString(36).slice(2)}.ts`);

  beforeAll(() => {
    fs.mkdirSync(testFileDir, { recursive: true });
    eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: { parser },
        plugins: {
          'local-rules-test-only-guard': {
            rules: {
              'require-test-only-guard': rule,
            },
          },
        },
        rules: {
          'local-rules-test-only-guard/require-test-only-guard': 'error',
        },
      },
    });
  });

  afterAll(() => {
    fs.rmSync(testFilePath, { force: true });
  });

  async function lint(code: string) {
    fs.writeFileSync(testFilePath, code);
    const [result] = await eslint.lintFiles([testFilePath]);
    return result;
  }

  it('accepts guarded object properties', async () => {
    const result = await lint(`
      const value = {
        ...((__BUILD_MODE_IS_TEST__ && {
          TEST_ONLY: {
            reset,
          },
        }) || {}),
      };
    `);

    expect(result.messages).toHaveLength(0);
  });

  it('rejects quoted and computed TEST_ONLY keys in the guarded shape', async () => {
    const quotedResult = await lint(`
      const value = {
        ...((__BUILD_MODE_IS_TEST__ && {
          'TEST_ONLY': { reset },
        }) || {}),
      };
    `);
    const computedResult = await lint(`
      const value = {
        ...((__BUILD_MODE_IS_TEST__ && {
          ['TEST_ONLY']: { reset },
        }) || {}),
      };
    `);

    expect(quotedResult.messages).toHaveLength(1);
    expect(quotedResult.messages[0]?.messageId).toBe('invalidObjectProperty');
    expect(computedResult.messages).toHaveLength(1);
    expect(computedResult.messages[0]?.messageId).toBe('invalidObjectProperty');
  });

  it('rejects a runtime class named TEST_ONLY', async () => {
    const result = await lint(`export class TEST_ONLY {}`);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('invalidExport');
  });

  it('rejects a runtime enum named TEST_ONLY', async () => {
    const result = await lint(`
      export enum TEST_ONLY {
        Enabled = 'enabled',
      }
    `);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('invalidExport');
  });

  it('rejects an unguarded object property', async () => {
    const result = await lint(`const value = { TEST_ONLY: { reset } };`);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('invalidObjectProperty');
    expect(result.messages[0]?.message).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('rejects a ternary guard', async () => {
    const result = await lint(`
      const value = {
        ...(__BUILD_MODE_IS_TEST__ ? { TEST_ONLY: { reset } } : {}),
      };
    `);

    expect(result.messages).toHaveLength(1);
  });

  it('rejects an indirect TEST_ONLY payload', async () => {
    const result = await lint(`
      const testOnly = { reset };
      const value = {
        ...((__BUILD_MODE_IS_TEST__ && {
          TEST_ONLY: testOnly,
        }) || {}),
      };
    `);

    expect(result.messages).toHaveLength(1);
  });

  it('rejects additional fields inside the guarded object', async () => {
    const result = await lint(`
      const value = {
        ...((__BUILD_MODE_IS_TEST__ && {
          TEST_ONLY: { reset },
          productionValue: true,
        }) || {}),
      };
    `);

    expect(result.messages).toHaveLength(1);
  });

  it('rejects an import.meta.env.DEV guard', async () => {
    const result = await lint(`
      const value = {
        ...((import.meta.env.DEV && {
          TEST_ONLY: { reset },
        }) || {}),
      };
    `);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('rejects a guard without the empty-object fallback', async () => {
    const result = await lint(`
      const value = {
        ...(__BUILD_MODE_IS_TEST__ && {
          TEST_ONLY: { reset },
        }),
      };
    `);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('rejects a non-empty fallback', async () => {
    const result = await lint(`
      const value = {
        ...((__BUILD_MODE_IS_TEST__ && {
          TEST_ONLY: { reset },
        }) || { fallback: true }),
      };
    `);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('rejects an aliased build-mode guard', async () => {
    const result = await lint(`
      const isTest = __BUILD_MODE_IS_TEST__;
      const value = {
        ...((isTest && {
          TEST_ONLY: { reset },
        }) || {}),
      };
    `);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('rejects a function named TEST_ONLY', async () => {
    const result = await lint(`
      export function TEST_ONLY(): void {
        reset();
      }
    `);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('invalidExport');
    expect(result.messages[0]?.message).toContain('direct top-level object export');
  });

  it('accepts a direct top-level TEST_ONLY object export', async () => {
    const result = await lint(`export const TEST_ONLY = { reset };`);

    expect(result.messages).toHaveLength(0);
  });

  it('rejects a non-object TEST_ONLY export', async () => {
    const result = await lint(`export const TEST_ONLY = createTestOnly();`);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('invalidExport');
    expect(result.messages[0]?.message).toContain('direct top-level object export');
  });
});
