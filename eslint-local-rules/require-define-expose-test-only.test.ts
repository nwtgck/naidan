
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import fs from 'fs';
import { rule } from './require-define-expose-test-only.js';
import * as parser from 'vue-eslint-parser';
import * as tsParser from '@typescript-eslint/parser';

describe('require-define-expose-test-only rule', () => {
  let eslint: ESLint;
  let eslintFix: ESLint;
  const testFileDir = path.resolve(__dirname, '../src/test-tmp');
  const testFileName = `temp-define-expose-lint-${Math.random().toString(36).slice(2)}.vue`;
  const testFilePath = path.resolve(testFileDir, testFileName);

  beforeAll(() => {
    if (!fs.existsSync(testFileDir)) {
      fs.mkdirSync(testFileDir, { recursive: true });
    }

    const baseConfig = {
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.vue'],
        languageOptions: {
          parser: parser,
          parserOptions: {
            parser: tsParser,
            sourceType: 'module',
          },
        },
        plugins: {
          'local-rules-define-expose': {
            rules: {
              'require-define-expose-test-only': rule,
            },
          },
        },
        rules: {
          'local-rules-define-expose/require-define-expose-test-only': 'error',
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

  it('should report error for .vue file missing defineExpose', async () => {
    const code = `<script setup lang="ts">
      const a = 1;
</script>`;
    const result = await lint(code);
    expect(result.messages.some(m => m.ruleId === 'local-rules-define-expose/require-define-expose-test-only' && m.messageId === 'missingDefineExpose')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toContain('defineExpose({');
    expect(fixedResult.output).toContain('__testOnly: {');
  });

  it('should report error for defineExpose missing __testOnly and fix it correctly', async () => {
    const code = `<script setup lang="ts">
      defineExpose({
        a: 1
      });
</script>`;
    const result = await lint(code);
    expect(result.messages.some(m => m.ruleId === 'local-rules-define-expose/require-define-expose-test-only' && m.messageId === 'missingTestOnly')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toMatch(/a: 1,\s+__testOnly: {/);
    expect(fixedResult.output).toContain('// Export internal state and logic used only for testing here.');
  });

  it('should handle trailing commas in defineExpose autofix', async () => {
    const code = `<script setup lang="ts">
      defineExpose({
        a: 1,
      });
</script>`;
    const fixedResult = await fix(code);
    // Should NOT result in a: 1,, __testOnly
    expect(fixedResult.output).toMatch(/a: 1,\s+__testOnly: {/);
    expect(fixedResult.output).not.toMatch(/a: 1,,\s+__testOnly: {/);
  });

  it('should NOT report error if defineExpose with __testOnly already exists', async () => {
    const code = `<script setup lang="ts">
      defineExpose({
        __testOnly: {
          internal: true
        }
      });
</script>`;
    const result = await lint(code);
    expect(result.messages.filter(m => m.ruleId === 'local-rules-define-expose/require-define-expose-test-only')).toHaveLength(0);
  });

  it('should handle empty defineExpose()', async () => {
    const code = `<script setup lang="ts">
      defineExpose();
</script>`;
    const result = await lint(code);
    expect(result.messages.some(m => m.ruleId === 'local-rules-define-expose/require-define-expose-test-only')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toContain('__testOnly: {');
  });

  it('should handle defineExpose({})', async () => {
    const code = `<script setup lang="ts">
      defineExpose({});
</script>`;
    const result = await lint(code);
    expect(result.messages.some(m => m.ruleId === 'local-rules-define-expose/require-define-expose-test-only')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toContain('__testOnly: {');
  });

  it('should handle .vue file with only <template> and no <script>', async () => {
    const code = `<template><div /></template>`;
    const result = await lint(code);
    expect(result.messages.some(m => m.messageId === 'missingDefineExpose')).toBe(true);
    
    const fixedResult = await fix(code);
    expect(fixedResult.output).toContain('<script setup lang="ts">');
    expect(fixedResult.output).toContain('defineExpose');
  });
});
