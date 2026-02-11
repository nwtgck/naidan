
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import fs from 'fs';
import { rule } from './require-test-only-export.js';
import * as parser from '@typescript-eslint/parser';

describe('require-test-only-export rule', () => {
  let eslint: ESLint;
  let eslintFix: ESLint;
  const testFileDir = path.resolve(__dirname, '../src/test-tmp');
  const testFileName = `temp-test-only-lint-${Math.random().toString(36).slice(2)}.ts`;
  const testFilePath = path.resolve(testFileDir, testFileName);

  beforeAll(() => {
    if (!fs.existsSync(testFileDir)) {
      fs.mkdirSync(testFileDir, { recursive: true });
    }

    const baseConfig = {
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser: parser,
        },
        plugins: {
          'local-rules-test-only': {
            rules: {
              'require-test-only-export': rule,
            },
          },
        },
        rules: {
          'local-rules-test-only/require-test-only-export': 'error',
        },
      },
    };

    eslint = new ESLint({ ...baseConfig, fix: false });
    eslintFix = new ESLint({ ...baseConfig, fix: true });
  });

  afterAll(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  async function lint(code: string) {
    fs.writeFileSync(testFilePath, code);
    const results = await eslint.lintFiles([testFilePath]);
    return results[0];
  }

  async function fix(code: string) {
    fs.writeFileSync(testFilePath, code);
    const results = await eslintFix.lintFiles([testFilePath]);
    return results[0];
  }

  it('should report error for useXxx function missing __testOnly', async () => {
    const code = `
      export function useChat() {
        const chat = 'hello';
        return {
          chat
        };
      }
    `;
    const result = await lint(code);
    expect(result.messages.some(m => m.ruleId === 'local-rules-test-only/require-test-only-export')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toContain('__testOnly: {');
    expect(fixedResult.output).toContain('// Export internal state and logic used only for testing here.');
  });

  it('should report error for arrow function useXxx missing __testOnly', async () => {
    const code = `
      export const useSettings = () => {
        return {
          theme: 'dark'
        };
      };
    `;
    const result = await lint(code);
    expect(result.messages.some(m => m.ruleId === 'local-rules-test-only/require-test-only-export')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toContain('__testOnly: {');
  });

  it('should NOT report error if __testOnly already exists', async () => {
    const code = `
      export function useExisting() {
        return {
          data: [],
          __testOnly: {
            internal: true
          }
        };
      }
    `;
    const result = await lint(code);
    expect(result.messages.filter(m => m.ruleId === 'local-rules-test-only/require-test-only-export')).toHaveLength(0);
  });

  it('should NOT report error for non-use functions', async () => {
    const code = `
      export function getChat() {
        return { chat: 'hi' };
      }
    `;
    const result = await lint(code);
    expect(result.messages.filter(m => m.ruleId === 'local-rules-test-only/require-test-only-export')).toHaveLength(0);
  });

  it('should NOT report error for use functions with lowercase next letter', async () => {
    const code = `
      export function usefulHelper() {
        return { ok: true };
      }
    `;
    const result = await lint(code);
    expect(result.messages.filter(m => m.ruleId === 'local-rules-test-only/require-test-only-export')).toHaveLength(0);
  });

  it('should handle empty object returns', async () => {
    const code = `
      export function useEmpty() {
        return {};
      }
    `;
    const result = await lint(code);
    expect(result.messages.some(m => m.ruleId === 'local-rules-test-only/require-test-only-export')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toContain('__testOnly: {');
  });

  it('should handle trailing commas correctly in autofix', async () => {
    const code = `
      export function useTrailing() {
        return {
          a: 1,
        };
      }
    `;
    const result = await fix(code);
    // Check for correct comma placement: a: 1, \n __testOnly
    // It should NOT be: a: 1 \n __testOnly ... ,,
    expect(result.output).toMatch(/a: 1,\s+__testOnly: {/);
    expect(result.output).not.toMatch(/a: 1\s+__testOnly: {/);
  });

  it('should handle single-line object returns', async () => {
    const code = `
      export function useSingleLine() {
        return { a: 1, b: 2 };
      }
    `;
    const result = await fix(code);
    // Should convert to multi-line or at least add __testOnly correctly
    expect(result.output).toContain('b: 2,');
    expect(result.output).toContain('__testOnly: {');
  });

  it('should handle single-line object without trailing comma', async () => {
    const code = `export function useMini() { return { x: 1 } }`;
    const result = await fix(code);
    expect(result.output).toContain('x: 1,');
    expect(result.output).toContain('__testOnly: {');
  });
});
