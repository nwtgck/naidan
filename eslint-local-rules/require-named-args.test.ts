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

  async function lint(code: string, { filePath = testFilePath }: {
    filePath?: string,
  } = {}) {
    if (filePath === testFilePath) {
      fs.writeFileSync(testFilePath, code);
    }

    const results = filePath === testFilePath
      ? await eslint.lintFiles([testFilePath])
      : await eslint.lintText(code, { filePath });
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

    try {
      const results = await createTypedEslint({ typedTsconfigPath }).lintFiles([typedTestFilePath]);
      return results[0]?.messages ?? [];
    } finally {
      parser.clearCaches();
      fs.rmSync(typedTestFilePath, { force: true });
      fs.rmSync(typedTsconfigPath, { force: true });
    }
  }

  it('exports a config that applies only to production src files', () => {
    expect(ruleConfig.files).toEqual(['src/**/*.ts', 'src/**/*.vue']);
    expect(ruleConfig.ignores).toEqual(['src/**/*.test.ts', 'src/**/*.spec.ts']);
  });

  it('allows the canonical promiseAllKeyed compatibility API to remain positional', async () => {
    await expect(lint(
      `export function promiseAllKeyed(values: object) { return values; }`,
      { filePath: path.resolve(testFileDir, 'compatibility-fixture/src/utils/promise.ts') },
    )).resolves.toHaveLength(0);
  });

  it('does not exempt same-named exports outside the canonical file', async () => {
    await expect(lint(`export function promiseAllKeyed(values: object) { return values; }`)).resolves.toHaveLength(1);
  });

  it('does not exempt non-exported functions named promiseAllKeyed in the canonical file', async () => {
    await expect(lint(
      `function promiseAllKeyed(values: object) { return values; }`,
      { filePath: path.resolve(testFileDir, 'compatibility-fixture/src/utils/promise.ts') },
    )).resolves.toHaveLength(1);
  });

  it('allows canonical static Tailwind compiler macro declarations', async () => {
    const filePath = path.resolve(testFileDir, 'compatibility-fixture/src/utils/virtual-naidan-tailwind.d.ts');
    await expect(lint(`declare function tw(className: string): string;`, { filePath })).resolves.toHaveLength(0);
    await expect(lint(`declare function twClasses(value: unknown): string;`, { filePath })).resolves.toHaveLength(0);
    await expect(lint(`declare function twClassString(...classNames: string[]): string;`, { filePath })).resolves.toHaveLength(0);
    await expect(lint(`declare function customClasses(value: unknown): unknown;`, { filePath })).resolves.toHaveLength(0);
  });

  it('does not exempt ordinary functions that reuse compiler macro names', async () => {
    await expect(lint(`function tw(className: string): string { return className; }`)).resolves.toHaveLength(1);
    await expect(lint(`function twClasses(value: unknown): string { return String(value); }`)).resolves.toHaveLength(1);
  });

  it('allows no-argument functions', async () => {
    await expect(lint(`function read() {}`)).resolves.toHaveLength(0);
  });


  it('allows tagged template function signatures because JavaScript supplies TemplateStringsArray and rest substitutions', async () => {
    await expect(lint(`function html(parts: TemplateStringsArray, ...values: never[]): string { return parts[0] ?? ''; }`)).resolves.toHaveLength(0);
    await expect(lint(`const css = (fragments: TemplateStringsArray, ...exprs: unknown[]): string => fragments.join(String(exprs.length));`)).resolves.toHaveLength(0);
  });

  it('reports TemplateStringsArray signatures that are not tagged template contracts', async () => {
    const messages = await lint(`function bad(parts: TemplateStringsArray, value: string): string { return parts[0] ?? value; }`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toBe('Wrap positional params into one object param, e.g. fn({ id, name }). Disable only for true external/deprecated contracts.');
  });

  it('allows the explicit empty named args convention', async () => {
    await expect(lint(`function read(_args: Record<never, never>) {}`)).resolves.toHaveLength(0);
  });

  it('reports EmptyArgs because empty args contracts should use Record<never, never> directly', async () => {
    const messages = await lint(`type EmptyArgs = Record<never, never>; function read(_args: EmptyArgs) {}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toBe('Use one destructured object param, e.g. fn({ value }: { value: Value }). Disable only for true external/deprecated contracts.');
  });

  it('allows any identifier name for the explicit empty named args type', async () => {
    await expect(lint(`function read(options: Record<never, never>) {}`)).resolves.toHaveLength(0);
    const emptyArgsMessages = await lint(`type EmptyArgs = Record<never, never>; function read(params: EmptyArgs) {}`);
    expect(emptyArgsMessages).toHaveLength(1);
  });

  it('allows inline destructured object parameters', async () => {
    await expect(lint(`function read({ id }: { id: string }) {}`)).resolves.toHaveLength(0);
  });

  it('allows destructured object parameters with default values', async () => {
    await expect(lint(`function read({ id = 'a' }: { id?: string } = {}) {}`)).resolves.toHaveLength(0);
  });

  it.each([
    `type Args = { id: string }; function read({ id }: Args) {}`,
    `interface Args { id: string } const read = ({ id }: Args) => id;`,
    `import type { Args } from './args'; function read({ id }: Args) {}`,
    `type Args = { id?: string }; function read({ id = 'a' }: Args = {}) {}`,
    `type Args = { id: string }; class Reader { constructor({ id }: Args) {} }`,
    `type Args = { id: string }; class Reader { read({ id }: Args) {} }`,
    `type Args = { id: string }; abstract class Reader { abstract read({ id }: Args): void; }`,
    `type Args = { id: string }; declare class Reader { read({ id }: Args): void; }`,
    `type Args = { id: string }; declare class Reader { constructor({ id }: Args); }`,
    `type Args = { id: string }; class Reader { read({ id }: Args): void; read({ id }: { id: string }) {} }`,
    `type Args = { id: string }; const reader = { read({ id }: Args) {} };`,
    `type Args = { id: string }; type Read = ({ id }: Args) => void;`,
    `type Args = { id: string }; interface Reader { read({ id }: Args): void }`,
    `type Args = { id: string }; interface Reader { ({ id }: Args): void }`,
    `type Args = { id: string }; interface Reader { new ({ id }: Args): Reader }`,
    `type Args = { id: string }; type Reader = new ({ id }: Args) => object;`,
    `type Args = { id: string }; const read = ({ ...args }: Args) => args;`,
    `type Args = { id: string }; function read(this: object, { id }: Args) {}`,
    `function read({ id }: Pick<Args, 'id'>) {}`,
    `function read({ id }: Omit<Args, 'name'>) {}`,
    `function read({ id }: Parameters<Read>[0]) {}`,
    `function read({ id }: ReturnType<Read>) {}`,
    `function read({ id }: typeof args) {}`,
    `type Args = { id: string }; declare function read({ id }: Args): void;`,
    `type Args = { id: string }; function read({ id }: Args): void; function read({ id }: { id: string }) {}`,
    `function read<T extends { id: string }>({ id }: T) {}`,
    `function read({ id }: { id: string } & Args) {}`,
    `function read({ id }: { id: string } | Args) {}`,
    `function read({ id }: any) {}`,
    `type Handler = ({ type }: Event) => void;`,
  ])('reports non-inline outer named-args types: %s', async (code) => {
    const messages = await lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('requireInlineNamedArgsType');
    expect(messages[0]?.fix).toBeUndefined();
    expect(messages[0]?.suggestions).toBeUndefined();
  });

  it.each([
    `type Args = { id: string }; function read({ id }: { id: Args['id'] }) {}`,
    `type Value = { id: string }; function read({ value }: { value: Value }) {}`,
    `declare function create({ name }?: { readonly name?: string }): void;`,
    `type Create = new ({ value }: { value: Value }) => Value;`,
    `abstract class Reader { abstract read({ id }: { id: string }): void; }`,
    `declare class Reader { read({ id }: { id: string }): void; constructor({ id }: { id: string }); }`,
    `class Reader { read({ id }: { id: string }): void; read({ id }: { id: string }) {} }`,
    `function read({ id }: ({ id: string })) {}`,
    `function read({ id }: { id: string, kind: 'a' } | { id: string, kind: 'b' }) {}`,
    `function read({ id, name }: { id: string } & { name: string }) {}`,
    `type Read = ({ id }: { id: string }) => void; const read: Read = ({ id }) => {};`,
    `interface Reader { read({ id }: { id: string }): void } const reader: Reader = { read({ id }) {} };`,
  ])('allows visible shapes and contextual implementations: %s', async (code) => {
    await expect(lint(code)).resolves.toHaveLength(0);
  });

  it('allows only verified shape-preserving wrappers around visible shapes', async () => {
    await expect(typedLint(`
import type { WorkerTransfer as Transfer } from '../../src/utils/worker-transport';
function read({ id }: Readonly<{ id: string }>) {}
function transfer({ id }: Transfer<{ id: string }>) {}
function nested({ id }: Transfer<Readonly<{ id: string }>>) {}
`)).resolves.toHaveLength(0);
  });

  it('reports aliases and derived shapes even inside otherwise permitted wrappers', async () => {
    const messages = await typedLint(`
import type { WorkerTransfer } from '../../src/utils/worker-transport';
type Args = { id: string };
function read({ id }: Readonly<Args>) {}
function transfer({ id }: WorkerTransfer<Args>) {}
function pick({ id }: Pick<{ id: string, name: string }, 'id'>) {}
function mapped({ id }: { [Key in 'id']: string }) {}
`);
    expect(messages).toHaveLength(4);
    expect(messages.every(message => message.messageId === 'requireInlineNamedArgsType')).toBe(true);
  });

  it('does not trust wrapper names or arbitrary generic wrappers', async () => {
    const messages = await typedLint(`
type Readonly<T> = T & { hidden: number };
type WorkerTransfer<T> = T & { hidden: number };
type Wrapper<T> = T;
function read({ id }: Readonly<{ id: string }>) {}
function transfer({ id }: WorkerTransfer<{ id: string }>) {}
function wrapped({ id }: Wrapper<{ id: string }>) {}
`);
    expect(messages).toHaveLength(3);
  });

  it('keeps external destructured callback contracts unchanged', async () => {
    await expect(typedLint(`
const channel = new MessageChannel();
channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => { void data; };
const listener: EventListener = ({ type }: Event) => { void type; };
const items: { id: string }[] = [];
type Item = { id: string };
items.map(({ id }: Item) => id);
Promise.resolve({ id: 'a' }).then(({ id }: Item) => id);
const handlers: EventListenerObject = { handleEvent({ type }: Event) { void type; } };
class Listener implements EventListenerObject { handleEvent({ type }: Event) { void type; } }
`)).resolves.toHaveLength(0);
  });


  it('preserves external contracts on abstract methods, overloads, and class expressions', async () => {
    await expect(typedLint(`\
abstract class Listener implements EventListenerObject { abstract handleEvent({ type }: Event): void; }
declare class DeclaredListener implements EventListenerObject { handleEvent({ type }: Event): void; }
class OverloadedListener implements EventListenerObject {
  handleEvent({ type }: Event): void;
  handleEvent({ type }: Event) { void type; }
}
const ExpressionListener = class implements EventListenerObject { handleEvent({ type }: Event) { void type; } };
`)).resolves.toHaveLength(0);
  });

  it('reports Naidan-owned abstract and declared positional methods', async () => {
    const messages = await lint(`\
abstract class Reader { abstract read(id: string): void; }
declare class Writer { write(id: string): void; constructor(id: string); }
`);
    expect(messages).toHaveLength(3);
  });

  it('does not treat constructors as inherited external method contracts', async () => {
    const messages = await typedLint(`\
declare class Listener implements EventListenerObject {
  constructor({ type }: Event);
  handleEvent({ type }: Event): void;
}
`);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('requireInlineNamedArgsType');
  });

  it('does not exempt alias-typed callbacks through shadowed platform constructors', async () => {
    const messages = await typedLint(`\
type Input = { value: string };
class ReadableStream {
  constructor({ start }: { start: ({ value }: { value: string }) => void }) {}
}
new ReadableStream({ start({ value }: Input) { void value; } });
`);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('requireInlineNamedArgsType');
  });

  it('does not exempt alias-typed setters through shadowed Vue computed bindings', async () => {
    const messages = await typedLint(`\
import { computed } from 'vue';
type Input = { value: string };
function create() {
  function computed({ get, set }: { get: () => Input, set: ({ value }: { value: string }) => void }) {}
  computed({ get: () => ({ value: 'a' }), set({ value }: Input) { void value; } });
}
`);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('requireInlineNamedArgsType');
  });

  it('preserves verified stream and Vue callbacks with non-inline payload types', async () => {
    await expect(typedLint(`\
import { computed } from 'vue';
type Input = { value: string };
new WritableStream<Input>({ write({ value }: Input) { void value; } });
new ReadableStream<string>({ start({ desiredSize }: ReadableStreamDefaultController<string>) { void desiredSize; } });
computed({ get: (): Input => ({ value: 'a' }), set({ value }: Input) { void value; } });
`)).resolves.toHaveLength(0);
  });

  it('does not let direct call arguments hide Naidan-owned alias-typed callbacks', async () => {
    const messages = await typedLint(`
type Args = { id: string };
function consume({ callback }: { callback: ({ id }: { id: string }) => void }) {}
consume({ callback: ({ id }: Args) => {} });
declare function register({ id }: { id: string }): void;
// eslint-disable-next-line local-rules-named-args/require-named-args -- A local call boundary in this fixture.
declare function use(callback: typeof register): void;
use(({ id }: Args) => {});
`);
    expect(messages).toHaveLength(2);
    expect(messages.every(message => message.messageId === 'requireInlineNamedArgsType')).toBe(true);
  });

  it('reports alias-typed callbacks on Naidan-owned assignment targets', async () => {
    const messages = await typedLint(`
type Args = { id: string };
let read: ({ id }: { id: string }) => void = () => {};
read = ({ id }: Args) => {};
`);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('requireInlineNamedArgsType');
  });

  it('reports single positional parameters with destructuring guidance', async () => {
    const messages = await lint(`function read(id: string) {}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('local-rules-named-args/require-named-args');
    expect(messages[0]?.message).toContain('Use one destructured object param');
    expect(messages[0]?.message).toContain('Disable only for true external/deprecated contracts');
  });

  it('reports multiple positional parameters with object wrapping guidance', async () => {
    const messages = await lint(`function read(id: string, name: string) {}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('Wrap positional params into one object param');
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

  it('reports Naidan-defined positional callback types with external-type guidance', async () => {
    const messages = await lint(`type Listener = (status: string, progress: number) => void;`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('Naidan callback/signature types should use one object param');
    expect(messages[0]?.message).toContain('Import external callback types instead of redefining them');
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

  it('allows class property arrow callbacks with external contextual signatures', async () => {
    await expect(typedLint(`class Target { private readonly listener: EventListener = (event) => { void event; }; }`)).resolves.toHaveLength(0);
  });

  it('reports class property arrow callbacks with Naidan-owned contextual signatures', async () => {
    const messages = await typedLint(`
// eslint-disable-next-line local-rules-named-args/require-named-args -- test fixture defines a local positional callback contract.
type Listener = (event: Event) => void;
class Target { private readonly listener: Listener = (event) => { void event; }; }
`);

    expect(messages).toHaveLength(1);
  });

  it('reports assignment RHS callbacks with concise contextual-typing guidance when the target has a Naidan-owned signature', async () => {
    const messages = await typedLint(`
// eslint-disable-next-line local-rules-named-args/require-named-args -- test fixture defines a local positional callback contract.
type Listener = (event: Event) => void;
let listener: Listener = () => {};
listener = (event) => { void event; };
`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('assignment target with an external callback type');
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


  it('reports stored Promise callback types with Promise.withResolvers guidance', async () => {
    const messages = await lint(`let resolvePromise: ((value: boolean) => void) | undefined;`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('Promise.withResolvers');
  });

  it('reports DOM-named callback types with external DOM type guidance', async () => {
    const messages = await lint(`let storageHandler: (event: StorageEvent) => void;`);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain("Window['onstorage']");
    expect(messages[0]?.message).toContain('typeof window.requestIdleCallback');
  });

  it('allows interface methods that mirror same-named methods from external base interfaces', async () => {
    await expect(typedLint(`interface LocalEventTarget extends EventTarget { addEventListener(type: string, listener: EventListenerOrEventListenerObject): void; }`)).resolves.toHaveLength(0);
  });

  it('reports interface methods added beside an external base interface', async () => {
    const messages = await typedLint(`interface LocalEventTarget extends EventTarget { localListener(event: Event): void; }`);

    expect(messages).toHaveLength(1);
  }, 30_000);

  it('reports interface methods that mirror same-named methods from Naidan-owned base interfaces', async () => {
    const messages = await typedLint(`
interface LocalBase {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- test fixture defines a local positional method contract.
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
}
interface LocalEventTarget extends LocalBase { addEventListener(type: string, listener: EventListenerOrEventListenerObject): void; }
`);

    expect(messages).toHaveLength(1);
  }, 30_000);


  it('keeps tagged-template destructuring as a language-defined contract', async () => {
    await expect(lint(`function tag({ raw }: TemplateStringsArray, ...values: unknown[]) { return raw.join(String(values)); }`)).resolves.toHaveLength(0);
  });

  it('keeps the named-args rule disabled for test and spec files without ignoring other lint rules', async () => {
    const scoped = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser }, rules: { 'no-debugger': 'error' } },
        ruleConfig,
      ],
    });
    const code = 'function read({ id }: Args) { debugger; return id; }';
    for (const suffix of ['test.ts', 'spec.ts']) {
      const [result] = await scoped.lintText(code, { filePath: path.resolve(testFileDir, `scope.${suffix}`) });
      expect(result?.messages.map(message => message.ruleId)).toEqual(['no-debugger']);
    }
    const [production] = await scoped.lintText(code, { filePath: path.resolve(testFileDir, 'scope.ts') });
    expect(production?.messages.map(message => message.ruleId)).toEqual(['local-rules-named-args/require-named-args', 'no-debugger']);
  });

  it('does not provide autofixes', () => {
    expect(rule.meta).not.toHaveProperty('fixable');
  });
});
