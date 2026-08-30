import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';
import { describe, expect, it } from 'vitest';
import { rule } from './validate-worker-api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const fixtureRoot = path.join(here, 'fixtures/worker-transport');
const fixtureProject = path.join(fixtureRoot, 'tsconfig.json');

function createEslint({ genericBridgeFileSuffixes = [], analysisBudget }: {
  genericBridgeFileSuffixes?: string[],
  analysisBudget?: number,
} = {}) {
  return new ESLint({
    cwd: projectRoot,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          extraFileExtensions: ['.vue'],
          project: fixtureProject,
          tsconfigRootDir: projectRoot,
        },
      },
      plugins: {
        local: {
          rules: {
            'validate-worker-api': rule,
          },
        },
      },
      rules: {
        'local/validate-worker-api': ['error', { genericBridgeFileSuffixes, analysisBudget }],
      },
    }],
  });
}

function createVueEslint() {
  return new ESLint({
    cwd: projectRoot,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.vue'],
      languageOptions: {
        parser: vueParser,
        parserOptions: {
          parser: tsParser,
          extraFileExtensions: ['.vue'],
          project: fixtureProject,
          tsconfigRootDir: projectRoot,
        },
      },
      plugins: {
        local: { rules: { 'validate-worker-api': rule } },
      },
      rules: {
        'local/validate-worker-api': 'error',
      },
    }],
  });
}

describe('validate-worker-api rule', () => {
  it('classifies unsafe worker API shapes without expanding reviewed-safe structural types', async () => {
    const [result] = await createEslint().lintFiles([
      path.join(fixtureRoot, 'worker-api-semantic-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toHaveLength(19);
    expect(messages.some(message => message.includes('payload[string]') && message.endsWith('unknown.'))).toBe(true);
    expect(messages.some(message => message.includes('callback') && message.includes('function-must-be-proxied'))).toBe(true);
    expect(messages.some(message => message.includes('handle') && message.includes('capability-sensitive'))).toBe(true);
    expect(messages.some(message => message.includes('capability-marker-must-be-top-level'))).toBe(true);
    expect(messages.some(message => message.includes('unknown-capability:unreviewed-clone'))).toBe(true);
    expect(messages.some(message => message.includes('proxy-must-be-top-level'))).toBe(true);
    expect(messages.some(message => message.includes('external-unreviewed'))).toBe(true);
    expect(messages.some(message => message.includes('transfer-required:MessagePort'))).toBe(true);
    expect(messages.some(message => message.includes('transfer-must-be-top-level'))).toBe(true);
    expect(messages.some(message => message.includes('type-parameter-unreviewed:T'))).toBe(true);
    expect(messages.some(message => message.includes('.proxy.arg0.nested.callback'))).toBe(true);
    expect(messages.some(message => message.includes('.proxy.read.return.nested.callback'))).toBe(true);
    expect(messages.filter(message => message.includes('nested.callback') && message.includes('function-must-be-proxied'))).toHaveLength(6);
  }, 20_000);


  it('validates Worker API contracts from TSX and Vue scripts', async () => {
    const [tsxResult] = await createEslint().lintFiles([path.join(fixtureRoot, 'worker-api-tsx-probe.tsx')]);
    const [vueResult] = await createVueEslint().lintFiles([path.join(fixtureRoot, 'worker-api-vue-probe.vue')]);

    for (const result of [tsxResult, vueResult]) {
      expect(result.messages.map(message => message.message)).toEqual([
        expect.stringContaining('function-must-be-proxied'),
      ]);
    }
  }, 20_000);

  it('fails closed when semantic analysis exceeds its configured budget', async () => {
    const [result] = await createEslint({ analysisBudget: 1 }).lintFiles([
      path.join(fixtureRoot, 'analysis-budget-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toEqual([expect.stringContaining('analysis-budget-exceeded')]);
  }, 20_000);

  it('validates exposed named worker contracts and rejects anonymous exposed contracts', async () => {
    const [result] = await createEslint().lintFiles([
      path.join(fixtureRoot, 'worker-api-expose-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toHaveLength(3);
    expect(messages.some(message => message.includes('callback') && message.includes('function-must-be-proxied'))).toBe(true);
    expect(messages.some(message => message.includes('metadata[string]') && message.endsWith('unknown.'))).toBe(true);
    expect(messages.some(message => message.includes('named-worker-api-contract-required'))).toBe(true);
  }, 20_000);

  it('allows only explicitly listed generic forwarding bridges', async () => {
    const allowed = path.join(fixtureRoot, 'allowed-generic-worker-bridge.ts');
    const disallowed = path.join(fixtureRoot, 'disallowed-generic-worker-bridge.ts');
    const eslint = createEslint({
      genericBridgeFileSuffixes: ['/eslint-local-rules/fixtures/worker-transport/allowed-generic-worker-bridge.ts'],
    });
    const results = await eslint.lintFiles([allowed, disallowed]);
    const byFile = new Map(results.map(result => [path.basename(result.filePath), result.messages.map(message => message.message)]));

    expect(byFile.get('allowed-generic-worker-bridge.ts')).toEqual([]);
    expect(byFile.get('disallowed-generic-worker-bridge.ts')).toEqual([
      expect.stringContaining('generic-transport-bridge-not-allowed'),
    ]);
  }, 20_000);
});
