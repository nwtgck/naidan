import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
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
          extraFileExtensions: ['.vue'],
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

// Count semantic work, not wall time. The real typed fixtures below verify the
// endpoint classification; this parser isolates the syntax fast paths.
function countTypeQueries({ code, endpoint }: { code: string, endpoint: boolean }) {
  const counts = { type: 0, format: 0 };
  const typeName = endpoint ? 'Worker' : 'Plain';
  const receiver = {
    isUnionOrIntersection: () => false,
    getSymbol: () => ({ getName: () => typeName }),
  };
  const checker = {
    getTypeAtLocation() {
      counts.type += 1;
      return receiver;
    },
    typeToString() {
      counts.format += 1;
      return typeName;
    },
  };
  const parser = {
    parseForESLint(source: string) {
      const parsed = tsParser.parseForESLint(source, { range: true, loc: true, tokens: true, comment: true });
      return {
        ...parsed,
        services: { ...parsed.services, program: { getTypeChecker: () => checker } },
      };
    },
  };
  const messages = new Linter({ cwd: projectRoot }).verify(code, [{
    languageOptions: { parser },
    plugins: { local: { rules: { transport: rule } } },
    rules: { 'local/transport': 'error' },
  }], { filename: 'src/query-probe.js' });
  expect(messages.some(message => message.fatal)).toBe(false);
  return { counts, messages };
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

  it('does not query types for statically unrelated members or non-message listener calls', () => {
    const { counts, messages } = countTypeQueries({
      endpoint: true,
      code: `
value.name;
value['length'];
value[\`safe\`];
value.addEventListener('error', () => {});
value?.addEventListener?.(\`error\`, () => {});
Reflect.get(value, 'name');
Reflect.set(value, \`length\`, 0);
const { name, [\`length\`]: size, ...rest } = value;
const { 0: first } = value;
const {} = value;
`,
    });
    expect(messages).toEqual([]);
    expect(counts).toEqual({ type: 0, format: 0 });
  });

  it.each([false, true])('formats only confirmed endpoint diagnostics (endpoint=%s)', endpoint => {
    const { counts, messages } = countTypeQueries({
      endpoint,
      code: `
value.postMessage({});
value[key];
Reflect.get(value, 'postMessage');
const { onmessage, addEventListener } = value;
`,
    });
    expect(counts).toEqual({ type: 4, format: endpoint ? 4 : 0 });
    expect(messages.map(message => message.messageId)).toEqual(endpoint ? [
      'directPostMessage', 'dynamicWorkerMember', 'directPostMessage',
      'directMessageListener', 'directMessageListener',
    ] : []);
  });

  it('retains computed, reflected, optional, inherited, union and destructured transport diagnostics', async () => {
    const [result] = await createEslint().lintFiles([path.join(fixtureRoot, 'lint-optimization-probe.ts')]);
    expect(result.fatalErrorCount).toBe(0);
    expect(result.messages.map(message => [message.line, message.column, message.messageId])).toEqual([
      [16, 1, 'directPostMessage'],
      [17, 1, 'directPostMessage'],
      [18, 1, 'directPostMessage'],
      [19, 1, 'directPostMessage'],
      [20, 1, 'directMessageListener'],
      [21, 1, 'directMessageListener'],
      [22, 1, 'directMessageListener'],
      [23, 1, 'directMessageListener'],
      [24, 1, 'directMessageListener'],
      [25, 1, 'directMessageListener'],
      [26, 1, 'directMessageListener'],
      [27, 1, 'directMessageListener'],
      [28, 1, 'dynamicWorkerMember'],
      [29, 1, 'dynamicWorkerMember'],
      [30, 1, 'dynamicWorkerMember'],
      [31, 1, 'directPostMessage'],
      [32, 1, 'directMessageListener'],
      [33, 1, 'directMessageListener'],
      [34, 1, 'dynamicWorkerMember'],
      [35, 1, 'dynamicWorkerMember'],
      [36, 9, 'directPostMessage'],
      [36, 28, 'directMessageListener'],
      [36, 48, 'directMessageListener'],
      [37, 9, 'directPostMessage'],
      [37, 40, 'directMessageListener'],
      [38, 9, 'dynamicWorkerMember'],
      [38, 25, 'dynamicWorkerMember'],
      [40, 1, 'directPostMessage'],
      [41, 1, 'directPostMessage'],
      [42, 1, 'directPostMessage'],
      [43, 1, 'directPostMessage'],
      [44, 1, 'directPostMessage'],
      [45, 1, 'directMessageListener'],
      [46, 1, 'directMessageListener'],
    ]);
    expect(result.messages[3]!.message).toBe('Worker | undefined.postMessage must not be called directly. Use the audited worker transport.');
    expect(result.messages[28]!.message).toBe('Worker & { readonly tag: string; }.postMessage must not be called directly. Use the audited worker transport.');
  });

  it('keeps safe Worker members and unrelated message APIs allowed', async () => {
    const [result] = await createEslint().lintFiles([path.join(fixtureRoot, 'lint-optimization-safe-probe.ts')]);
    expect(result.messages).toEqual([]);
  });
});
