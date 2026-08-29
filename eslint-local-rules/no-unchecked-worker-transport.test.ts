import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';
import { describe, expect, it } from 'vitest';
import { rule } from './no-unchecked-worker-transport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const fixtureRoot = path.join(here, 'fixtures/worker-transport');

function createEslint(options: {
  legacyComlinkFileSuffixes?: string[],
  legacyRawTransportFileSuffixes?: string[],
} = {}) {
  return new ESLint({
    cwd: projectRoot,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          project: path.join(fixtureRoot, 'tsconfig.json'),
          tsconfigRootDir: projectRoot,
        },
      },
      plugins: {
        local: {
          rules: {
            'no-unchecked-worker-transport': rule,
          },
        },
      },
      rules: {
        'local/no-unchecked-worker-transport': ['error', options],
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
          project: path.join(fixtureRoot, 'tsconfig.json'),
          tsconfigRootDir: projectRoot,
        },
      },
      plugins: {
        local: { rules: { 'no-unchecked-worker-transport': rule } },
      },
      rules: {
        'local/no-unchecked-worker-transport': 'error',
      },
    }],
  });
}

describe('no-unchecked-worker-transport rule', () => {
  it('blocks Worker/MessagePort transport and raw Comlink without blocking window or BroadcastChannel', async () => {
    const [result] = await createEslint().lintFiles([
      path.join(fixtureRoot, 'lint-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toHaveLength(18);
    expect(messages.filter(message => message.includes('comlink'))).toHaveLength(1);
    expect(messages.filter(message => message.startsWith('Worker.postMessage'))).toHaveLength(4);
    expect(messages.filter(message => message.includes('MessagePort.postMessage'))).toHaveLength(1);
    expect(messages.filter(message => message.includes('DedicatedWorkerGlobalScope.postMessage'))).toHaveLength(1);
    expect(messages.filter(message => message.includes('DerivedWorker.postMessage'))).toHaveLength(1);
    expect(messages.filter(message => message.includes('message listener'))).toHaveLength(8);
  });


  it('covers TSX and Vue worker transport entry points', async () => {
    const [tsxResult] = await createEslint().lintFiles([path.join(fixtureRoot, 'lint-probe-tsx.tsx')]);
    const [vueResult] = await createVueEslint().lintFiles([path.join(fixtureRoot, 'lint-probe.vue')]);

    const expectedMessages = [
      expect.stringContaining('comlink'),
      expect.stringContaining('Worker.postMessage'),
    ];
    expect(tsxResult.messages.map(message => message.message)).toEqual(expectedMessages);
    expect(vueResult.messages.map(message => message.message)).toEqual(expectedMessages);
  }, 20_000);


  it('blocks re-export, dynamic import, require, and Comlink subpath loading', async () => {
    const [result] = await createEslint().lintFiles([
      path.join(fixtureRoot, 'comlink-module-bypass-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toHaveLength(4);
    expect(messages.every(message => message.includes('comlink'))).toBe(true);
  });

  it('supports exact temporary legacy exceptions without weakening other files', async () => {
    const fixture = path.join(fixtureRoot, 'lint-probe.ts');
    const [result] = await createEslint({
      legacyComlinkFileSuffixes: ['/eslint-local-rules/fixtures/worker-transport/lint-probe.ts'],
      legacyRawTransportFileSuffixes: ['/eslint-local-rules/fixtures/worker-transport/lint-probe.ts'],
    }).lintFiles([fixture]);

    expect(result.messages).toEqual([]);
  });
});
