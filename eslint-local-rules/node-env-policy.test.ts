// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';
import path from 'node:path';
import policy from './node-env-policy.js';
import { repoRoot } from './external-command-ast.js';

function lint({ code, filename = 'scripts/example.ts' }: { code: string, filename?: string }) {
  const messages = new Linter({ cwd: repoRoot }).verify(code, [{
    ...policy,
    files: ['**'],
    languageOptions: {
      parser: filename.endsWith('.vue') ? vueParser : tsParser,
      sourceType: 'module',
      parserOptions: { parser: tsParser, project: false },
    },
  }], { filename: path.resolve(repoRoot, filename) });
  expect(messages.filter(message => message.fatal)).toEqual([]);
  expect(messages.every(message => message.fix === undefined && message.suggestions === undefined)).toBe(true);
  return messages.map(message => message.messageId);
}

const normal = 'export const READ_ENV_FOO = () => process.env.FOO;';

describe('node environment registry declaration', () => {
  it.each([
    normal,
    '\n// Comment\nexport const READ_ENV_FOO =\n  () => process.env.FOO;\n',
    'export const READ_ENV_X0_B_2 = (() => (process.env.X0_B_2));',
    `${normal}\nexport const READ_ENV_BAR = () => process.env.BAR;`,
  ])('allows only a lazy, identity-preserving reader: %s', code => {
    expect(lint({ code, filename: 'build/node-env.ts' })).toEqual([]);
  });

  it.each([
    'export const READ_ENV_FOO = process.env.FOO;',
    'export const READ_ENV_FOO = () => process.env.BAR;',
    "export const READ_ENV_FOO = () => process.env.FOO ?? 'default';",
    "export const READ_ENV_FOO = () => process.env['FOO'];",
    "export const READ_ENV_FOO = () => process['env'].FOO;",
    'export const READ_ENV_FOO = () => process?.env.FOO;',
    'export const READ_ENV_FOO = () => process.env?.FOO;',
    'export const READ_ENV_FOO = async () => process.env.FOO;',
    'export const READ_ENV_FOO = (fallback) => process.env.FOO;',
    'export const READ_ENV_FOO = () => { return process.env.FOO; };',
    'export const READ_ENV_FOO = () => (process.env.FOO as string);',
    'export const READ_ENV_FOO = () => process.env.FOO!;',
    'export const READ_ENV_FOO = (): string | undefined => process.env.FOO;',
    'export const READ_ENV_FOO: () => string = () => process.env.FOO;',
    'export const READ_ENV_FOO = <T>() => process.env.FOO;',
    'export const READ_ENV_FOO = () => String(process.env.FOO);',
    'export let READ_ENV_FOO = () => process.env.FOO;',
    'const READ_ENV_FOO = () => process.env.FOO;',
    'export const GET_ENV_FOO = () => process.env.FOO;',
    'export const FOO = () => process.env.FOO;',
    'export const READ_ENV_foo = () => process.env.foo;',
    'export const READ_ENV_FOO__BAR = () => process.env.FOO__BAR;',
    'export const READ_ENV_FOO = () => globalThis.process.env.FOO;',
    'export function READ_ENV_FOO() { return process.env.FOO; }',
    'export const READ_ENV_SNAPSHOT = () => ({ ...process.env });',
    'export const READ_ENV_ALL = () => process.env;',
    'export const READ_ENV_FOO = () => process.env.FOO, READ_ENV_BAR = () => process.env.BAR;',
    "export const READ_ENV_FOO = () => process.env.FOO = 'x';",
    'export const READ_ENV_FOO = () => delete process.env.FOO;',
    "import process from 'node:process';\n" + normal,
    'export const TEST_ONLY = {};',
    'export type Env = NodeJS.ProcessEnv;',
    'export default () => process.env.FOO;',
    `${normal}\nconsole.log('side effect');`,
    `${normal}\nconst snapshot = process.env;`,
    `${normal}\nexport { READ_ENV_FOO as leak };`,
    `${normal}\nprocess.env.FOO++;`,
  ])('rejects changed registry semantics: %s', code => {
    expect(lint({ code, filename: 'build/node-env.ts' })).toContain('registryShape');
  });

  it.each(['build/elsewhere/node-env.ts', 'src/node-env.ts', 'scripts/node-env.ts', 'docs/build/node-env.ts', 'build/node-env.ts?raw'])('does not trust a matching basename or query: %s', filename => {
    expect(lint({ code: normal, filename })).toContain('directEnvironment');
  });
});

describe('Node environment access and mutation', () => {
  it.each([
    'process.env.FOO;',
    'process.env;',
    "process.env.FOO = 'x';",
    'delete process.env.FOO;',
    'process.env.FOO++;',
    'process.env.FOO ??= "x";',
    'process.env = {};',
    'const env = process.env;',
    'const copy = { ...process.env };',
    'Object.assign(process.env, { FOO: "x" });',
    'Object.defineProperty(process.env, "FOO", { value: "x" });',
    'Reflect.set(process.env, "FOO", "x");',
    "process['env'].FOO;",
    'process?.env?.FOO;',
    '(process as any).env.FOO;',
    'process!.env.FOO;',
    'globalThis.process.env.FOO;',
    'global.process.env.FOO;',
    "window['process'].env.FOO;",
    "self.process.env.FOO;",
    "const key = 'en' + 'v'; process[key].FOO;",
    'const p = process; p.env.FOO;',
    'const p = process; const q = p; q.env.FOO;',
    'let p = {}; p = process; p.env.FOO;',
    'let p = globalThis; p = process; p.env.FOO;',
    'let p; ({ process: p } = globalThis); p.env.FOO;',
    'const p = condition ? globalThis : process; p.env.FOO;',
    "Object.getOwnPropertyDescriptor(globalThis, 'process').value.env.FOO;",
    "Reflect.getOwnPropertyDescriptor(globalThis, 'process').value.env.FOO;",
    'function f({ env } = process) { return env; }',
    'let p; p = globalThis.process; p.env.FOO;',
    'const process = globalThis.process; process.env.FOO;',
    'const { process: p } = globalThis; p.env.FOO;',
    'const { process: { env } } = globalThis;',
    'const { env } = process;',
    'const { env: e = {} } = process;',
    'let e; ({env: e} = process);',
    'const holder = { p: process }; holder.p.env.FOO;',
    'const holder = { p: process }; const { p } = holder; p.env.FOO;',
    'const p = condition ? process : {}; p.env.FOO;',
    'const p = condition ? {} : process; p.env.FOO;',
    'const p = process || {}; p.env.FOO;',
    'const p = (0, process); p.env.FOO;',
    "import p from 'node:process'; p.env.FOO;",
    "import * as p from 'process'; p.env.FOO;",
    "import * as p from 'node:process'; p.default.env.FOO;",
    "import { default as p } from 'node:process'; p.env.FOO;",
    "import { env } from 'node:process';",
    "import { env as e } from 'process'; e.FOO = 'x';",
    "function f(p: NodeJS.Process) { return p.env.FOO; }",
    "type P = NodeJS.Process; function f(p: P) { delete p.env.FOO; }",
    "import type p from 'node:process'; function f(value: typeof p) { return value.env.FOO; }",
    "function f(p: typeof process) { return p.env.FOO; }",
    'function f({ env }: NodeJS.Process) { return env; }',
    'const f = ({ env }: NodeJS.Process) => env;',
    'const f = function ({ env }: NodeJS.Process) { return env; };',
    'process.loadEnvFile();',
    "import { loadEnvFile as load } from 'node:process'; load();",
    'const { loadEnvFile } = process;',
  ])('rejects direct/aliased reads and writes: %s', code => {
    expect(lint({ code })).toContain('directEnvironment');
  });

  it.each([
    'process[key];',
    'const p = process; p[key] = {};',
    'const { [key]: value } = process;',
    'const k = compute(); process[k];',
    'function f(p: NodeJS.Process) { return p[key]; }',
  ])('fails closed for an unknown process property: %s', code => {
    expect(lint({ code })).toContain('dynamicProcessKey');
  });

  it.each([
    "Reflect.get(process, 'env').FOO;",
    "Reflect.get.call(null, process, 'env');",
    "Reflect.get.apply(null, [process, 'env']);",
    "const get = Reflect.get; get.call(null, process, 'env');",
    "Reflect.get.bind(null, process, 'env');",
    "Object.defineProperty.call(null, process, 'env', { value: {} });",
    "process.__defineGetter__('env', () => ({}));",
    "process.__lookupGetter__('env');",
    'const { ...p } = process;',
    'const { argv, ...p } = process;',
    "Object.defineProperty(process, 'env', { value: {} });",
    "Reflect.set(process, 'env', {});",
    "Reflect.deleteProperty(process, 'env');",
    "Object.getOwnPropertyDescriptor(process, 'env');",
    'Object.getOwnPropertyDescriptors(process);',
    'Object.values(process);',
    'Object.entries(process);',
    'Object.assign(process, arbitrary);',
    'Object.defineProperties(process, arbitrary);',
    'Object.setPrototypeOf(process, arbitrary);',
    'JSON.stringify(process);',
    "const get = Reflect.get; get(process, 'env');",
    "const { get } = Reflect; get(process, 'env');",
    "vi.spyOn(process, 'env', 'get');",
    "import { vi as v } from 'vitest'; v.spyOn(process, 'env', 'get');",
  ])('rejects reflective environment entry: %s', code => {
    expect(lint({ code, filename: 'build/example.test.ts' })).toContain('processReflection');
  });

  it.each([
    "import p = require('node:process'); p.env.FOO;",
    "require('node:process').env;",
    "module.require('process').env;",
    "process.mainModule.require('node:process').env;",
    "globalThis.require('process').env;",
    "globalThis.module.require('node:process').env;",
    "const { env } = require('process');",
    "(await import('node:process')).env;",
    "import('process').then(p => p.env);",
    "process.getBuiltinModule('node:process').env;",
    "const get = process.getBuiltinModule; get('process');",
    "process.getBuiltinModule.call(null, 'process');",
    "process.getBuiltinModule.apply(null, ['process']);",
    "import { getBuiltinModule } from 'node:process'; getBuiltinModule('process');",
    "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('process');",
    "vi.importActual('node:process');",
    "export * from 'node:process';",
    "export * as p from 'node:process';",
    "export { env } from 'node:process';",
    "export { default as p } from 'node:process';",
    'export default process;',
    "import p from 'node:process'; export {p};",
  ])('rejects opaque module loading and process re-exports: %s', code => {
    expect(lint({ code })).toContain('processModule');
  });

  it.each(['build/example.test.ts', 'build/example.ts', 'src/view.ts', 'scripts/example.ts', 'scripts/example.js', 'pwa/service-worker.ts', 'docs/view.ts'])('has no test/build/runtime exemption: %s', filename => {
    expect(lint({ code: 'process.env.FOO = "x";', filename })).toContain('directEnvironment');
  });
});

describe('unrelated env objects and supported test stubs', () => {
  it.each([
    'process.argv; process.exitCode = 0; process.cwd(); process.platform;',
    'const { argv, exitCode: code } = process;',
    "import { argv } from 'node:process'; console.log(argv);",
    "import p from 'node:process'; p.stdout.write('x');",
    "export { argv } from 'node:process';",
    'type P = typeof process; type E = typeof process.env;',
    "import type { env } from 'node:process';",
    "const process = { env: new Map() }; process.env.get('USER');",
    "processes.map(process => process.env.get('USER'));",
    "this.kernel.getProcesses().map((process) => ({ user: process.env.get('USER'), argv0: process.env.get('0') }));",
    "function f(process: WeshProcess) { process.env.set('X', 'x'); }",
    "const env: NodeJS.ProcessEnv = {}; env.FOO = 'x'; delete env.FOO;",
    'const env = { ...environment, GIT_DIR: directory }; delete env.GIT_INDEX_FILE;',
    'Object.assign(runtime.env, { allowRemoteModels: false });',
    'import.meta.env.DEV;',
    "const process = other; process.env.get('USER');",
    "const Reflect = { get() {} }; Reflect.get(process, 'env');",
    "function f(process: Other) { Reflect.get(process, 'env'); }",
    "vi.spyOn(process, 'cwd');",
    "const p = globalThis.process; vi.stubGlobal('process', { ...p, release: { name: 'browser-test' } }); vi.stubGlobal('process', p);",
  ])('does not confuse another object with the Node environment: %s', code => {
    expect(lint({ code, filename: 'src/example.test.ts' })).toEqual([]);
  });

  it.each(['build/example.test.ts', 'src/example.test-support.ts'])('permits stubs and restoration only in test files: %s', filename => {
    expect(lint({ code: "import { vi } from 'vitest'; vi.stubEnv('TZ', 'UTC'); vi.unstubAllEnvs();", filename })).toEqual([]);
  });

  it.each([
    "vi.stubEnv('X', 'x');",
    'vi.unstubAllEnvs();',
    "import { vi as v } from 'vitest'; v.stubEnv('X', 'x');",
    "import * as v from 'vitest'; v.vi.stubEnv('X', 'x');",
    "const v = vi; v.stubEnv('X', 'x');",
    "const { stubEnv } = vi; stubEnv('X', 'x');",
    "const { unstubAllEnvs: restore } = vi; restore();",
  ])('forbids stubbing from production source: %s', code => {
    expect(lint({ code, filename: 'src/view.ts' })).toContain('testStubOnly');
  });
});

describe('registry import boundary', () => {
  const source = "import { READ_ENV_PATH } from './node-env'; READ_ENV_PATH();";
  it('permits named imports only in approved callers', () => {
    expect(lint({ code: source, filename: 'build/app-source-environment.ts' })).toEqual([]);
  });

  it.each(['src/runtime.ts', 'src/runtime.test.ts', 'build/other.ts', 'scripts/cli.ts', 'docs/build/runtime.ts'])('does not allow an arbitrary importer: %s', filename => {
    expect(lint({ code: `import { READ_ENV_PATH } from '${path.join(repoRoot, 'build/node-env.ts')}';`, filename })).toContain('registryImport');
  });

  it.each(['./node-env.ts', './node-env.js', './sub/../node-env', './node-env.ts?raw', '@/../build/node-env', '~/../build/node-env', new URL('../build/node-env.ts', import.meta.url).href])('resolves alternate module spelling: %s', module => {
    expect(lint({ code: source.replace('./node-env', module), filename: 'build/other.ts' })).toContain('registryImport');
  });

  it.each([
    "import * as env from './node-env';",
    "import env from './node-env';",
    "import './node-env';",
    "import { READ_ENV_PATH as read } from './node-env';",
    "export * from './node-env';",
    "export { READ_ENV_PATH } from './node-env';",
    "import('./node-env');",
    "require('./node-env');",
    "import env = require('./node-env');",
  ])('rejects opaque registry imports even from an approved caller: %s', code => {
    expect(lint({ code, filename: 'build/app-source-environment.ts' })).toContain('registryImport');
  });

  it('does not mistake an unrelated node-env file for the registry', () => {
    expect(lint({ code: "import { value } from './node-env';", filename: 'src/runtime.ts' })).toEqual([]);
  });
});

describe('Vue expression boundaries', () => {
  it.each([
    '<template>{{ process.env.X }}</template>',
    '<script setup lang="ts">const p = globalThis.process;</script><template>{{ p.env.X }}</template>',
    '<script setup lang="ts">process.env.X = "x";</script><template />',
    '<template><button @click="process.env.X = $event">x</button></template>',
  ])('checks scripts and template expressions: %s', code => {
    expect(lint({ code, filename: 'src/View.vue' })).toContain('directEnvironment');
  });

  it('permits scoped virtual processes in a template', () => {
    expect(lint({ code: '<template><div v-for="process in processes">{{ process.env.get("USER") }}</div></template>', filename: 'src/View.vue' })).toEqual([]);
  });
});


describe('destructuring preflight preserves the diagnostic walk', () => {
  it.each([
    ["const { default: { env: value } } = process;", 'directEnvironment'],
    ["const { default: { default: { loadEnvFile: load } } } = process;", 'directEnvironment'],
    ["const { default: { ...rest } } = process;", 'processReflection'],
    ["const { default: { [key]: value } } = process;", 'dynamicProcessKey'],
    ["const key = 'en' + 'v'; const { [key]: value } = process;", 'directEnvironment'],
    ["({ env: value = {} } = process);", 'directEnvironment'],
    ["const f = function ({ default: { env: value } } = process) {};", 'directEnvironment'],
    ["const f = ({ default: { ...rest } } = process) => {};", 'processReflection'],
    ["const { process: { env: value } } = globalThis;", 'directEnvironment'],
    ["import * as v from 'vitest'; const { vi: { stubEnv: stub } } = v;", 'testStubOnly'],
    ["const { stubEnv: stub } = vi;", 'testStubOnly'],
  ])('retains %s', (code, messageId) => {
    expect(lint({ code })).toContain(messageId);
  });

  it.each([
    'const { pid, cwd } = process;',
    'const { default: { pid } } = process;',
    'const { arbitrary: { ...rest } } = process;',
    'const { env } = { env: {} };',
    'const f = ({ pid }: NodeJS.Process) => pid;',
  ])('does not invent a violation for %s', code => {
    expect(lint({ code })).toEqual([]);
  });
});
