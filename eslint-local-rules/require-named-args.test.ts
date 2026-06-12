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
  const typedTestFilePrefix = `temp-require-named-args-${Math.random().toString(36).slice(2)}`;
  let typedLintCounter = 0;

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
    for (const filePath of [testFilePath]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    for (const fileName of fs.readdirSync(testFileDir)) {
      if (fileName.startsWith(typedTestFilePrefix) && (fileName.endsWith('.typed-fixture.ts') || fileName.endsWith('.typed-tsconfig.json'))) {
        fs.unlinkSync(path.resolve(testFileDir, fileName));
      }
    }
  });

  async function lint(code: string) {
    fs.writeFileSync(testFilePath, code);
    const results = await eslint.lintFiles([testFilePath]);
    return results[0]?.messages ?? [];
  }

  function createTypedEslint({ typedTsconfigPath }: { typedTsconfigPath: string }) {
    return new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
          parserOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            project: [typedTsconfigPath],
            tsconfigRootDir: path.resolve(__dirname, '..'),
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
  }

  async function typedLint(code: string) {
    const index = typedLintCounter++;
    const typedTestFileName = `${typedTestFilePrefix}-${index}.typed-fixture.ts`;
    const typedTestFilePath = path.resolve(testFileDir, typedTestFileName);
    const typedTsconfigPath = path.resolve(testFileDir, `${typedTestFilePrefix}-${index}.typed-tsconfig.json`);
    fs.writeFileSync(typedTestFilePath, code);
    fs.writeFileSync(typedTsconfigPath, JSON.stringify({
      extends: '../../tsconfig.app.json',
      include: [typedTestFileName],
      exclude: [],
    }));
    const results = await createTypedEslint({ typedTsconfigPath }).lintFiles([typedTestFilePath]);
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

  it('reports single positional parameters with concise guidance', async () => {
    const messages = await lint(`function read(id: string) {}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('local-rules-named-args/require-named-args');
    expect(messages[0]?.message).toContain('Use named args');
    expect(messages[0]?.message).toContain('Disable only for true external/deprecated contracts');
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


  it('allows Web Streams ReadableStream underlying source callbacks', async () => {
    await expect(lint(`new ReadableStream({ start(controller) {}, async pull(controller) {}, cancel(reason) {} });`)).resolves.toHaveLength(0);
  });

  it('allows Web Streams WritableStream underlying sink callbacks', async () => {
    await expect(lint(`new WritableStream({ start(controller) {}, async write(chunk) {}, close() {}, abort(reason) {} });`)).resolves.toHaveLength(0);
  });

  it('allows Web Streams TransformStream transformer callbacks', async () => {
    await expect(lint(`new TransformStream({ start(controller) {}, transform(chunk, controller) {}, flush(controller) {} });`)).resolves.toHaveLength(0);
  });

  it('does not allow stream-like object method names outside Web Stream constructors', async () => {
    const messages = await lint(`const stream = { start(controller: Controller) {}, write(chunk: Chunk) {} };`);

    expect(messages).toHaveLength(2);
  });

  it('allows Vue computed setters imported from vue', async () => {
    await expect(lint(`import { computed } from 'vue'; const value = computed({ get: () => 'a', set: (next: string) => { void next; } });`)).resolves.toHaveLength(0);
  });

  it('allows aliased Vue computed setters imported from vue', async () => {
    await expect(lint(`import { computed as vueComputed } from 'vue'; const value = vueComputed({ get: () => 'a', set(next: string) { void next; } });`)).resolves.toHaveLength(0);
  });

  it('does not allow computed-shaped setters when computed is not imported from vue', async () => {
    const messages = await lint(`const value = computed({ get: () => 'a', set: (next: string) => { void next; } });`);

    expect(messages).toHaveLength(1);
  });


  it('allows object literal methods with external contextual signatures', async () => {
    await expect(typedLint(`
const listener: EventListenerObject = { handleEvent(event) { void event; } };
interface Options { listener: EventListenerObject }
const options: Options = {
  listener: {
    handleEvent(event) { void event; },
  },
};
void listener;
void options;
`)).resolves.toHaveLength(0);
  });

  it('reports object literal methods with Naidan-owned contextual signatures', async () => {
    const messages = await typedLint(`
interface LocalListener {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- test fixture defines a local positional callback contract.
  handleEvent(event: Event): void
}
interface LocalOptions { listener: LocalListener }
const listener: LocalListener = { handleEvent(event) { void event; } };
const options: LocalOptions = {
  listener: {
    handleEvent(event) { void event; },
  },
};
void listener;
void options;
`);

    expect(messages).toHaveLength(2);
  });

  it('allows class methods that implement external interface signatures', async () => {
    await expect(typedLint(`class Listener implements EventListenerObject { handleEvent(event) { void event; } }`)).resolves.toHaveLength(0);
  });

  it('reports class methods that implement Naidan-owned interface signatures', async () => {
    const messages = await typedLint(`
interface LocalListener {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- test fixture defines a local positional callback contract.
  handleEvent(event: Event): void
}
class Listener implements LocalListener { handleEvent(event) { void event; } }
`);

    expect(messages).toHaveLength(1);
  });

  it('allows arrow callbacks with external contextual signatures', async () => {
    await expect(typedLint(`const listener: EventListener = (event) => { void event; };`)).resolves.toHaveLength(0);
  });

  it('allows assignment RHS callbacks when the assignment target has an external contextual signature', async () => {
    await expect(typedLint(`window.onresize = (event) => { void event; };`)).resolves.toHaveLength(0);
    await expect(typedLint(`const channel = new BroadcastChannel('test'); channel.onmessage = (event) => { void event; };`)).resolves.toHaveLength(0);
  });

  it('reports assignment RHS callbacks with concise contextual-typing guidance when the target has a Naidan-owned signature', async () => {
    const messages = await typedLint(`
// eslint-disable-next-line local-rules-named-args/require-named-args -- test fixture defines a local positional callback contract.
type Listener = (event: Event) => void;
let listener: Listener = () => {};
listener = (event) => { void event; };
`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('assignment target an external callback type');
    expect(messages[0]?.message).toContain('Disable only for true external/deprecated contracts');
  });

  it('reports object property assignment callbacks when the property has a Naidan-owned contextual signature', async () => {
    const messages = await typedLint(`
interface LocalTarget {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- test fixture defines a local positional callback contract.
  onmessage: (event: Event) => void
}
const target = {} as LocalTarget;
target.onmessage = (event) => { void event; };
`);

    expect(messages).toHaveLength(1);
  });

  it('reports assignment RHS callbacks when no external contextual signature is present', async () => {
    const messages = await typedLint(`let listener: unknown; listener = (event: Event) => { void event; };`);

    expect(messages).toHaveLength(1);
  });

  it('reports local callback type aliases even when their parameter type is external', async () => {
    const messages = await typedLint(`type Listener = (event: Event) => void;`);

    expect(messages).toHaveLength(1);
  });

  it('allows Vue directive hooks when their contextual signature comes from Vue', async () => {
    await expect(typedLint(`import type { ObjectDirective } from 'vue'; const vFocus: ObjectDirective<HTMLElement> = { mounted(el) { el.focus(); } };`)).resolves.toHaveLength(0);
  });

  it('allows Vitest reporter object methods when their contextual signature comes from Vitest', async () => {
    await expect(typedLint(`import type { Reporter } from 'vitest/reporters'; const reporter: Reporter = { onTestRunEnd(testModules, errors) { void testModules; void errors; } };`)).resolves.toHaveLength(0);
  }, 30_000);

  it('allows Vitest reporter class methods when they implement Vitest reporter signatures', async () => {
    await expect(typedLint(`import type { Reporter } from 'vitest/reporters'; class FailedOnlyReporter implements Reporter { onTestRunEnd(testModules, errors) { void testModules; void errors; } }`)).resolves.toHaveLength(0);
  }, 30_000);


  it('does not provide autofixes', () => {
    expect(rule.meta).not.toHaveProperty('fixable');
  });
});
