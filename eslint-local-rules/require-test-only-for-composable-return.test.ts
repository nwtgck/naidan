import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import fs from 'fs';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './require-test-only-for-composable-return.js';

describe('require-test-only-for-composable-return rule', () => {
  let eslint: ESLint;
  let eslintFix: ESLint;
  const testFileName = `temp-test-only-lint-${Math.random().toString(36).slice(2)}.ts`;
  const testFilePath = path.resolve(__dirname, testFileName);
  const testSupportFilePath = path.resolve(
    __dirname,
    `temp-test-only-lint-${Math.random().toString(36).slice(2)}.test.ts`,
  );

  beforeAll(() => {
    const baseConfig = {
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: { parser },
        plugins: {
          'local-rules-test-only': {
            rules: {
              'require-test-only-for-composable-return': rule,
            },
          },
        },
        rules: {
          'local-rules-test-only/require-test-only-for-composable-return': 'error',
        },
      },
    };

    eslint = new ESLint({ ...baseConfig, fix: false });
    eslintFix = new ESLint({ ...baseConfig, fix: true });
  });

  afterAll(() => {
    fs.rmSync(testFilePath, { force: true });
    fs.rmSync(testSupportFilePath, { force: true });
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

  async function lintTestSupportFile({ code }: {
    code: string,
  }) {
    fs.writeFileSync(testSupportFilePath, code);
    const [result] = await eslint.lintFiles([testSupportFilePath]);
    return result;
  }

  it('reports and fixes a useXxx function missing TEST_ONLY', async () => {
    const result = await fix(`
      export function useChat() {
        return {
          chat: 'hello',
        };
      }
    `);

    expect(result.output).toContain('...((__BUILD_MODE_IS_TEST__ && {');
    expect(result.output).toContain('// ESLint-required for useXxx return objects.');
  });

  it('reports and fixes an arrow composable missing TEST_ONLY', async () => {
    const result = await fix(`
      export const useSettings = () => {
        return { theme: 'dark' };
      };
    `);

    expect(result.output).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('accepts the exact guarded spread', async () => {
    const result = await lint(`
      export function useExisting() {
        return {
          data: [],
          ...((__BUILD_MODE_IS_TEST__ && {
            TEST_ONLY: {
              internal: true,
            },
          }) || {}),
        };
      }
    `);

    expect(result.messages).toHaveLength(0);
  });

  it('rejects an unguarded TEST_ONLY property', async () => {
    const result = await lint(`
      export function useExisting() {
        return {
          TEST_ONLY: {
            internal: true,
          },
        };
      }
    `);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('invalidTestOnlyGuard');
  });

  it('ignores useXxx mock factories declared inside test files', async () => {
    const chatPaneStateResult = await lintTestSupportFile({
      code: `
        vi.mock('./useChatPaneState', () => ({
          useChatPaneState: () => {
            return {
              chat: undefined,
              TEST_ONLY: {},
            };
          },
        }));
      `,
    });

    expect(chatPaneStateResult.messages).toHaveLength(0);

    const chatBootstrapResult = await lintTestSupportFile({
      code: `
        vi.mock('./useChatBootstrap', () => ({
          useChatBootstrap: () => {
            return {
              loadChats: async () => undefined,
              openChat: async () => undefined,
              TEST_ONLY: {},
            };
          },
        }));
      `,
    });

    expect(chatBootstrapResult.messages).toHaveLength(0);
  });

  it('still validates TEST_ONLY type declarations inside test files', async () => {
    const result = await lintTestSupportFile({
      code: `
        type MockComposable = {
          TEST_ONLY?: Record<never, never>,
        };
      `,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('optionalTestOnly');
  });

  it('ignores non-composable functions', async () => {
    const result = await lint(`export function getChat() { return { chat: 'hi' }; }`);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores lowercase useful helpers', async () => {
    const result = await lint(`export function usefulHelper() { return { ok: true }; }`);
    expect(result.messages).toHaveLength(0);
  });

  it('fixes an empty object return', async () => {
    const result = await fix(`export function useEmpty() { return {}; }`);
    expect(result.output).toContain('__BUILD_MODE_IS_TEST__');
  });

  it('reports Record<string, never> on TEST_ONLY type annotations', async () => {
    const result = await lint(`type ExampleAdapter = { TEST_ONLY: Record<string, never> };`);
    expect(result.messages[0]?.message).toContain('Record<string, ...>');
  });

  it('reports optional TEST_ONLY type annotations', async () => {
    const result = await lint(`type ExampleAdapter = { TEST_ONLY?: Record<never, never> };`);
    expect(result.messages[0]?.message).toContain('required property');
  });

  it('allows Record<never, never> on TEST_ONLY type annotations', async () => {
    const result = await lint(`type ExampleAdapter = { TEST_ONLY: Record<never, never> };`);
    expect(result.messages).toHaveLength(0);
  });

  it('allows explicit TEST_ONLY object types', async () => {
    const result = await lint(`
      type ExampleAdapter = {
        TEST_ONLY: {
          reset({}: Record<never, never>): void;
          count: number;
        };
      };
    `);
    expect(result.messages).toHaveLength(0);
  });

  it('allows named TEST_ONLY type references', async () => {
    const result = await lint(`
      type TestOnlyApi = { reset({}: Record<never, never>): void };
      type ExampleAdapter = { TEST_ONLY: TestOnlyApi };
    `);
    expect(result.messages).toHaveLength(0);
  });

  it('reports open-ended index signatures', async () => {
    const result = await lint(`type ExampleAdapter = { TEST_ONLY: { [key: string]: unknown } };`);
    expect(result.messages[0]?.message).toContain('index signatures');
  });
});
