import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import moduleTestOnlyConfig, { rule } from './require-module-test-only-export.js';
import testOnlyGuardConfig from './require-test-only-guard.js';

const ruleId = 'local-rules-module-test-only/require-module-test-only-export';

function createEslint({ fix }: { fix: boolean }): ESLint {
  return new ESLint({
    overrideConfigFile: true,
    fix,
    overrideConfig: {
      files: ['**/*.ts'],
      languageOptions: {
        parser,
      },
      plugins: {
        'local-rules-module-test-only': {
          rules: {
            'require-module-test-only-export': rule,
          },
        },
      },
      rules: {
        [ruleId]: 'error',
      },
    },
  });
}

async function lint({ code, fix }: {
  code: string,
  fix: boolean,
}) {
  const [result] = await createEslint({ fix }).lintText(code, {
    filePath: 'src/example.ts',
  });
  return result;
}

async function lintWithDefaultConfig({ code, filePath }: {
  code: string,
  filePath: string,
}) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    warnIgnored: false,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
        },
      },
      moduleTestOnlyConfig,
      testOnlyGuardConfig,
    ],
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result;
}

describe('require-module-test-only-export rule', () => {
  it.each([
    'src/example.d.ts',
    'src/example.test.ts',
    'src/example.spec.ts',
    'src/FailedOnlyReporter.ts',
    'src/test-mocks/example.ts',
    'src/test-setup.ts',
    'src/test-tmp/example.ts',
    'src/strings/catalogs/en.ts',
    'src/strings/messages/Example__value/en.ts',
  ])('does not require the module export in excluded file %s', async (filePath) => {
    const result = await lintWithDefaultConfig({
      code: 'export const value = 1;\n',
      filePath,
    });
    expect(result.messages).toHaveLength(0);
  });

  it('keeps non-message strings modules in scope', async () => {
    const result = await lintWithDefaultConfig({
      code: 'export const value = 1;\n',
      filePath: 'src/strings/test-utils.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('missing');
  });

  it('requires the module export in an ordinary source module through the default config', async () => {
    const result = await lintWithDefaultConfig({
      code: 'export const value = 1;\n',
      filePath: 'src/example.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('missing');
  });

  it('accepts the required module export with the guard rule enabled', async () => {
    const result = await lintWithDefaultConfig({
      code: 'export const TEST_ONLY = {};\n',
      filePath: 'src/example.ts',
    });
    expect(result.messages).toHaveLength(0);
  });

  it('accepts an empty top-level TEST_ONLY object export', async () => {
    const result = await lint({ code: 'export const TEST_ONLY = {};\n', fix: false });
    expect(result.messages).toHaveLength(0);
  });

  it('accepts a populated and explicitly typed TEST_ONLY object export without requiring comments', async () => {
    const result = await lint({ code: `\
function reset() {}

export const TEST_ONLY: Readonly<{
  reset: typeof reset,
}> = {
  reset,
};
`, fix: false });
    expect(result.messages).toHaveLength(0);
  });

  it('accepts references to the valid module export from nested scopes', async () => {
    const result = await lint({ code: `\
export const TEST_ONLY = {};

function readTestOnly() {
  return TEST_ONLY;
}
`, fix: false });
    expect(result.messages).toHaveLength(0);
  });

  it('accepts an imported TEST_ONLY alias alongside the module export', async () => {
    const result = await lint({ code: `\
import { TEST_ONLY as runtimeTestOnly } from './runtime';

void runtimeTestOnly;

export const TEST_ONLY = {};
`, fix: false });
    expect(result.messages).toHaveLength(0);
  });

  it('adds a commented TEST_ONLY export at the end of a module', async () => {
    const result = await lint({
      code: 'export const value = 1;\n',
      fix: true,
    });
    expect(result.messages).toHaveLength(0);
    expect(result.output).toBe(`\
export const value = 1;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
`);
  });

  it('adds the module export when TEST_ONLY is imported under an alias', async () => {
    const result = await lint({
      code: `\
import { TEST_ONLY as runtimeTestOnly } from './runtime';
void runtimeTestOnly;
`,
      fix: true,
    });
    expect(result.messages).toHaveLength(0);
    expect(result.output).toContain(`\
void runtimeTestOnly;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
`);
  });

  it('adds the export to an empty file', async () => {
    const result = await lint({ code: '', fix: true });
    expect(result.output).toBe(`\
// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
`);
  });

  it('preserves CRLF line endings while adding the export', async () => {
    const result = await lint({ code: 'export const value = 1;\r\n', fix: true });
    expect(result.output).toBe([
      'export const value = 1;',
      '',
      '// Export internal state and logic used only for testing here. Do not reference these in production logic.',
      '// ESLint-required for TypeScript modules.',
      'export const TEST_ONLY = {};',
      '',
    ].join('\r\n'));
  });

  it('preserves a final comment and adds the export after it', async () => {
    const result = await lint({
      code: `\
export const value = 1;
// Keep this final comment.
`,
      fix: true,
    });
    expect(result.output).toContain(`\
// Keep this final comment.

// Export internal state and logic used only for testing here.`);
  });

  it('is idempotent after autofix', async () => {
    const first = await lint({ code: 'export const value = 1;', fix: true });
    const second = await lint({ code: first.output ?? '', fix: true });
    expect(second.output).toBeUndefined();
    expect(second.messages).toHaveLength(0);
  });

  it.each([
    ['let declaration', 'export let TEST_ONLY = {};'],
    ['declare declaration', 'export declare const TEST_ONLY: {};'],
    ['indirect export', 'const TEST_ONLY = {}; export { TEST_ONLY };'],
    ['factory initializer', 'export const TEST_ONLY = createTestOnly();'],
    ['type assertion', 'export const TEST_ONLY = {} as const;'],
    ['multiple declaration', 'export const value = 1, TEST_ONLY = {};'],
    ['imported binding', "import { TEST_ONLY } from './other';"],
    ['destructured binding', 'const { TEST_ONLY } = source;'],
    ['nested declaration', 'function read() { const TEST_ONLY = {}; return TEST_ONLY; }'],
    ['unresolved reference', 'function read() { return TEST_ONLY; }'],
    ['default exported declaration', 'export default function TEST_ONLY() {}'],
    ['default exported reference', 'export default TEST_ONLY;'],
    ['TypeScript export assignment', 'export = TEST_ONLY;'],
    ['namespace re-export', "export * as TEST_ONLY from './other';"],
  ])('reports %s without autofixing it', async (_name, code) => {
    const result = await lint({ code, fix: true });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe(ruleId);
    expect(result.output).toBeUndefined();
  });

  it('reports duplicate top-level TEST_ONLY declarations without autofixing them', async () => {
    const result = await lint({
      code: `\
export const TEST_ONLY = {};
const TEST_ONLY = {};
`,
      fix: true,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('duplicate');
    expect(result.output).toBeUndefined();
  });

  it('reports a nested TEST_ONLY shadow alongside the valid export', async () => {
    const result = await lint({
      code: `\
export const TEST_ONLY = {};

function read() {
  const TEST_ONLY = {};
  return TEST_ONLY;
}
`,
      fix: true,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('duplicate');
    expect(result.output).toBeUndefined();
  });
});
