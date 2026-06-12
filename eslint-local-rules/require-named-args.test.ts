import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import fs from 'fs';
import * as parser from '@typescript-eslint/parser';
import { rule } from './require-named-args.js';
import ruleConfig from './require-named-args.js';

describe('require-named-args rule', () => {
  let eslint: ESLint;
  const testFileDir = path.resolve(__dirname, '../src/test-tmp');
  const testFileName = `temp-require-named-args-${Math.random().toString(36).slice(2)}.fixture.ts`;
  const testFilePath = path.resolve(testFileDir, testFileName);

  beforeAll(() => {
    if (!fs.existsSync(testFileDir)) {
      fs.mkdirSync(testFileDir, { recursive: true });
    }

    eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
          parserOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
          },
        },
        plugins: {
          'local-rules-named-args': {
            rules: {
              'require-named-args': rule,
            },
          },
        },
        rules: {
          'local-rules-named-args/require-named-args': 'error',
        },
      },
    });
  });

  afterAll(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  async function lint(code: string) {
    fs.writeFileSync(testFilePath, code);
    const results = await eslint.lintFiles([testFilePath]);
    return results[0]?.messages ?? [];
  }

  it('exports a config that applies only to production src files', () => {
    expect(ruleConfig.files).toEqual(['src/**/*.ts', 'src/**/*.vue']);
    expect(ruleConfig.ignores).toEqual(['src/**/*.test.ts', 'src/**/*.spec.ts']);
  });

  it('allows no-argument functions', async () => {
    await expect(lint(`function read() {}`)).resolves.toHaveLength(0);
  });

  it('allows the explicit empty named args convention', async () => {
    await expect(lint(`function read(_args: Record<never, never>) {}`)).resolves.toHaveLength(0);
  });

  it('allows the shared EmptyArgs alias for the empty named args convention', async () => {
    await expect(lint(`type EmptyArgs = Record<never, never>; function read(_args: EmptyArgs) {}`)).resolves.toHaveLength(0);
  });

  it('allows any identifier name for the explicit empty named args type', async () => {
    await expect(lint(`function read(options: Record<never, never>) {}`)).resolves.toHaveLength(0);
    await expect(lint(`type EmptyArgs = Record<never, never>; function read(params: EmptyArgs) {}`)).resolves.toHaveLength(0);
  });

  it('allows inline destructured object parameters', async () => {
    await expect(lint(`function read({ id }: { id: string }) {}`)).resolves.toHaveLength(0);
  });

  it('allows destructured object parameters with default values', async () => {
    await expect(lint(`function read({ id = 'a' }: { id?: string } = {}) {}`)).resolves.toHaveLength(0);
  });

  it('allows alias-typed destructured object parameters', async () => {
    await expect(lint(`type Args = { id: string }; function read({ id }: Args) {}`)).resolves.toHaveLength(0);
  });

  it('reports single positional parameters', async () => {
    const messages = await lint(`function read(id: string) {}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('local-rules-named-args/require-named-args');
  });

  it('reports multiple positional parameters', async () => {
    const messages = await lint(`function read(id: string, name: string) {}`);

    expect(messages).toHaveLength(1);
  });

  it('reports identifier parameters with inline object types', async () => {
    const messages = await lint(`function read(params: { id: string }) {}`);

    expect(messages).toHaveLength(1);
  });

  it('reports identifier parameters with alias types', async () => {
    const messages = await lint(`type Args = { id: string }; function read(params: Args) {}`);

    expect(messages).toHaveLength(1);
  });

  it('reports constructors that use positional parameters', async () => {
    const messages = await lint(`class Reader { constructor(id: string) {} }`);

    expect(messages).toHaveLength(1);
  });

  it('reports class methods that use positional parameters', async () => {
    const messages = await lint(`class Reader { read(id: string) {} }`);

    expect(messages).toHaveLength(1);
  });

  it('reports interface methods that use positional parameters', async () => {
    const messages = await lint(`interface Reader { read(id: string): void }`);

    expect(messages).toHaveLength(1);
  });

  it('reports Naidan-defined positional callback types', async () => {
    const messages = await lint(`type Listener = (status: string, progress: number) => void;`);

    expect(messages).toHaveLength(1);
  });

  it('reports single positional callback type parameters', async () => {
    const messages = await lint(`type Listener = (event: Event) => void;`);

    expect(messages).toHaveLength(1);
  });

  it('allows destructured callback type parameters', async () => {
    await expect(lint(`type Listener = ({ event }: { event: Event }) => void;`)).resolves.toHaveLength(0);
  });

  it('allows TypeScript type predicates to remain positional', async () => {
    await expect(lint(`function isReader(value: unknown): value is { id: string } { return true; }`)).resolves.toHaveLength(0);
  });

  it('does not report direct anonymous call arguments because their contract may be library-owned', async () => {
    await expect(lint(`items.map((item: string) => item);`)).resolves.toHaveLength(0);
  });

  it('does not report Vue defineEmits call signatures', async () => {
    await expect(lint(`const emit = defineEmits<{ (e: 'close'): void; (e: 'update', value: string): void; }>();`)).resolves.toHaveLength(0);
  });


  it('reports alias-typed constructor parameters', async () => {
    const messages = await lint(`type Args = { id: string }; class Reader { constructor(params: Args) {} }`);

    expect(messages).toHaveLength(1);
  });

  it('reports object method shorthand positional parameters', async () => {
    const messages = await lint(`const reader = { read(id: string) {} };`);

    expect(messages).toHaveLength(1);
  });

  it('reports interface property callback types with alias parameters', async () => {
    const messages = await lint(`type Args = { event: Event }; interface Reader { onRead?: (params: Args) => void }`);

    expect(messages).toHaveLength(1);
  });

  it('allows type predicate callback types to remain positional', async () => {
    await expect(lint(`type Guard = (value: unknown) => value is { id: string };`)).resolves.toHaveLength(0);
  });

  it('ignores TypeScript this parameters when checking function signatures', async () => {
    await expect(lint(`async function* stream(this: Reader): AsyncGenerator<string> { yield 'a'; }`)).resolves.toHaveLength(0);
    await expect(lint(`async function* stream(this: Reader, { id }: { id: string }): AsyncGenerator<string> { yield id; }`)).resolves.toHaveLength(0);
  });

  it('does not provide autofixes', () => {
    expect(rule.meta).not.toHaveProperty('fixable');
  });
});
