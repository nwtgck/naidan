import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import fs from 'fs';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './no-test-only-access-in-production.js';
import { isTestSupportFilename } from './test-only-guard.js';

describe('no-test-only-access-in-production rule', () => {
  let eslint: ESLint;
  const productionFileDir = path.resolve(__dirname, '../src/lint-rule-tmp');
  const testSupportFileDir = path.resolve(__dirname, '../src/test-tmp');
  const productionFilePath = path.resolve(productionFileDir, `production-${Math.random().toString(36).slice(2)}.ts`);
  const testFilePath = path.resolve(testSupportFileDir, `consumer-${Math.random().toString(36).slice(2)}.ts`);

  beforeAll(() => {
    fs.mkdirSync(productionFileDir, { recursive: true });
    fs.mkdirSync(testSupportFileDir, { recursive: true });
    eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: { parser },
        plugins: {
          'local-rules-no-test-only-access': {
            rules: {
              'no-test-only-access-in-production': rule,
            },
          },
        },
        rules: {
          'local-rules-no-test-only-access/no-test-only-access-in-production': 'error',
        },
      },
    });
  });

  afterAll(() => {
    fs.rmSync(productionFilePath, { force: true });
    fs.rmSync(testFilePath, { force: true });
  });

  async function lint({ code, filePath }: { code: string; filePath: string }) {
    fs.writeFileSync(filePath, code);
    const [result] = await eslint.lintFiles([filePath]);
    return result;
  }

  it('allows TEST_ONLY access in test files', async () => {
    const result = await lint({
      code: `import { TEST_ONLY } from './runtime'; value.TEST_ONLY.reset(); TEST_ONLY.reset();`,
      filePath: testFilePath,
    });

    expect(result.messages).toHaveLength(0);
  });

  it('allows nested TEST_ONLY access inside a guarded payload', async () => {
    const result = await lint({
      code: `
        const value = {
          ...((__BUILD_MODE_IS_TEST__ && {
            TEST_ONLY: {
              nested: child.TEST_ONLY.value,
            },
          }) || {}),
        };
      `,
      filePath: productionFilePath,
    });

    expect(result.messages).toHaveLength(0);
  });

  it('allows nested TEST_ONLY access below another spread inside a guarded payload', async () => {
    const result = await lint({
      code: `
        const value = {
          ...((__BUILD_MODE_IS_TEST__ && {
            TEST_ONLY: {
              nested: {
                ...child.TEST_ONLY,
              },
            },
          }) || {}),
        };
      `,
      filePath: productionFilePath,
    });

    expect(result.messages).toHaveLength(0);
  });

  it('rejects dot, optional-chain, and static computed member access', async () => {
    const result = await lint({
      code: `
        value.TEST_ONLY.reset();
        value?.TEST_ONLY.reset();
        value['TEST_ONLY'].reset();
        value[\`TEST_ONLY\`].reset();
      `,
      filePath: productionFilePath,
    });

    expect(result.messages).toHaveLength(4);
  });

  it('rejects direct use of guarded module-level test-only exports', async () => {
    const result = await lint({
      code: `
        export const TEST_ONLY = (__BUILD_MODE_IS_TEST__ && {
          reset() {},
        }) || undefined;
        TEST_ONLY.reset();
      `,
      filePath: productionFilePath,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages.every((message) => message.messageId === 'forbiddenAccess')).toBe(true);
  });

  it('allows TEST_ONLY names in type-only positions', async () => {
    const result = await lint({
      code: `
        type TestApi = {
          TEST_ONLY: {
            reset: () => void,
          },
        };
      `,
      filePath: productionFilePath,
    });

    expect(result.messages).toHaveLength(0);
  });

  it('rejects destructuring', async () => {
    const result = await lint({
      code: `const { TEST_ONLY } = value;`,
      filePath: productionFilePath,
    });

    expect(result.messages).toHaveLength(1);
  });

  it('rejects TEST_ONLY imports and re-exports', async () => {
    const result = await lint({
      code: `
        import { TEST_ONLY } from './runtime';
        export { TEST_ONLY };
      `,
      filePath: productionFilePath,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((message) => message.messageId === 'forbiddenImport')).toBe(true);
  });

  it('uses narrow test-support path exemptions', () => {
    expect(isTestSupportFilename('/repo/src/example.test.ts')).toBe(true);
    expect(isTestSupportFilename('/repo/src/example.test-helpers.ts')).toBe(true);
    expect(isTestSupportFilename('/repo/src/test-setup.ts')).toBe(true);
    expect(isTestSupportFilename('/repo/src/test-mocks/provider.ts')).toBe(true);
    expect(isTestSupportFilename('/repo/src/components/test-utils.ts')).toBe(true);
    expect(isTestSupportFilename('/repo/src/test-utils/provider.ts')).toBe(true);
    expect(isTestSupportFilename('/repo/src/test-tmp/generated.ts')).toBe(true);

    expect(isTestSupportFilename('/repo/src/fixtures/runtime.ts')).toBe(false);
    expect(isTestSupportFilename('/repo/src/mocks/runtime.ts')).toBe(false);
    expect(isTestSupportFilename('/repo/src/__tests__/support.ts')).toBe(false);
  });
});
