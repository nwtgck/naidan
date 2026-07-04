import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import fs from 'fs';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import ruleConfig, { rule } from './require-promise-all-keyed.js';

type LintMessage = {
  message: string,
  ruleId: string | null,
};

describe('require-promise-all-keyed rule', () => {
  const testFileDir = path.resolve(__dirname, '../src/test-tmp');
  const testRootDirectoryName = `temp-require-promise-all-keyed-${Math.random().toString(36).slice(2)}`;
  const testRootDirectory = path.resolve(testFileDir, testRootDirectoryName);
  const tsconfigPath = path.resolve(testRootDirectory, 'tsconfig.json');
  const messagesByFile = new Map<string, LintMessage[]>();

  const fixtures = {
    'valid.ts': `
declare function save(): Promise<void>;
declare function writeLog(): Promise<undefined>;
declare function waitForever(): Promise<never>;
declare const dynamicTasks: Promise<number>[];
declare const fixedVoidTasks: readonly [Promise<void>, Promise<undefined>];
declare const variableLengthTasks: readonly [Promise<number>, ...Promise<number>[]];

async function runValidCases(ids: string[]) {
  await Promise.all([save(), writeLog()]);
  await Promise.all([waitForever()]);
  await Promise.all(fixedVoidTasks);
  await Promise.all(dynamicTasks);
  await Promise.all(ids.map(async id => id.length));
  await Promise.all([Promise.resolve(1), ...dynamicTasks]);
  await Promise.all(variableLengthTasks);
}
`,
    'shadowed.ts': `
const Promise = {
  async all(values: number[]) {
    return values;
  },
};

async function runShadowedCase() {
  return await Promise.all([1, 2]);
}
`,
    'invalid.ts': `
declare function save(): Promise<void>;
declare function loadUser(): Promise<{ id: string }>;
declare function loadPermissions(): Promise<string[]>;
declare const maybeValue: Promise<void | string>;
declare const anyValue: Promise<any>;
declare const unknownValue: Promise<unknown>;
declare const fixedTasks: readonly [Promise<number>, Promise<string>];

async function fixedValues() {
  return await Promise.all([loadUser(), loadPermissions()]);
}

async function mixedValues() {
  await Promise.all([save(), loadUser()]);
}

async function unionValue() {
  await Promise.all([maybeValue]);
}

async function unsafeValues() {
  await Promise.all([anyValue, unknownValue]);
}

async function constAssertion() {
  await Promise.all([Promise.resolve(1), Promise.resolve(2)] as const);
}

async function satisfiesExpression() {
  await Promise.all(
    [Promise.resolve(1), Promise.resolve(2)] satisfies Promise<number>[],
  );
}

function returnedWithoutAwait() {
  return Promise.all([Promise.resolve(1), Promise.resolve(2)]);
}

function discardedResult() {
  void Promise.all([Promise.resolve(1), Promise.resolve(2)]);
}

async function fixedTupleVariable() {
  await Promise.all(fixedTasks);
}

async function fixedTupleSpread() {
  await Promise.all([...fixedTasks]);
}

async function computedProperty() {
  await Promise['all']([Promise.resolve(1), Promise.resolve(2)]);
}
`,
    'compatibility/src/utils/promise.ts': `
export function promiseAllKeyed(values: object) {
  void values;
  return Promise.all([Promise.resolve(1), Promise.resolve(2)]);
}
`,
    'noncanonical.ts': `
export function promiseAllKeyed(values: object) {
  void values;
  return Promise.all([Promise.resolve(1), Promise.resolve(2)]);
}
`,
    'nested/src/utils/promise.ts': `
export function promiseAllKeyed(values: object) {
  void values;
  const nested = () => Promise.all([Promise.resolve(1), Promise.resolve(2)]);
  return nested();
}
`,
  };

  beforeAll(async () => {
    fs.mkdirSync(testRootDirectory, { recursive: true });

    const fixturePaths: string[] = [];
    for (const [relativeFilePath, code] of Object.entries(fixtures)) {
      const fixturePath = path.resolve(testRootDirectory, relativeFilePath);
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      fs.writeFileSync(fixturePath, code);
      fixturePaths.push(fixturePath);
    }

    fs.writeFileSync(tsconfigPath, JSON.stringify({
      extends: path.resolve(__dirname, '../tsconfig.app.json'),
      exclude: [],
      include: ['**/*.ts'],
    }));

    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
          parserOptions: {
            ecmaVersion: 'latest',
            project: [tsconfigPath],
            sourceType: 'module',
            tsconfigRootDir: path.resolve(__dirname, '..'),
          },
        },
        plugins: {
          'local-rules-promise-all-keyed': {
            rules: {
              'require-promise-all-keyed': rule,
            },
          },
        },
        rules: {
          'local-rules-promise-all-keyed/require-promise-all-keyed': 'error',
        },
      },
    });

    const results = await eslint.lintFiles(fixturePaths);
    for (const result of results) {
      const relativeFilePath = path.relative(testRootDirectory, result.filePath).replaceAll(path.sep, '/');
      messagesByFile.set(relativeFilePath, result.messages);
    }
  }, 30_000);

  afterAll(() => {
    fs.rmSync(testRootDirectory, { force: true, recursive: true });
  });

  function messagesFor(relativeFilePath: keyof typeof fixtures): LintMessage[] {
    return messagesByFile.get(relativeFilePath) ?? [];
  }

  it('exports a config that applies only to production source files', () => {
    expect(ruleConfig.files).toEqual(['src/**/*.ts', 'src/**/*.vue']);
    expect(ruleConfig.ignores).toEqual(['src/**/*.test.ts', 'src/**/*.spec.ts']);
  });

  it('allows void-only fixed inputs, dynamic collections, and shadowed Promise objects', () => {
    expect(messagesFor('valid.ts')).toHaveLength(0);
    expect(messagesFor('shadowed.ts')).toHaveLength(0);
  });

  it('reports every fixed value-producing Promise.all form', () => {
    const messages = messagesFor('invalid.ts');

    expect(messages).toHaveLength(11);
    expect(messages.every(message => (
      message.ruleId === 'local-rules-promise-all-keyed/require-promise-all-keyed'
    ))).toBe(true);
    expect(messages.every(message => message.message.includes('promiseAllKeyed'))).toBe(true);
    expect(messages.every(message => message.message.includes('@/utils/promise'))).toBe(true);
  });

  it('allows Promise.all only in the canonical compatibility function body', () => {
    expect(messagesFor('compatibility/src/utils/promise.ts')).toHaveLength(0);
  });

  it('does not exempt same-named exports outside the canonical file', () => {
    expect(messagesFor('noncanonical.ts')).toHaveLength(1);
  });

  it('does not exempt nested functions in the canonical compatibility file', () => {
    expect(messagesFor('nested/src/utils/promise.ts')).toHaveLength(1);
  });
});
