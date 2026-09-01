import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { transformToSystemJs } from './plugin/systemjs-transform.js';

const require = createRequire(import.meta.url);
const { System } = require('systemjs/dist/system-node.cjs') as {
  System: {
    import(url: string): Promise<Record<string, unknown>>;
    delete(url: string): boolean;
  };
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

async function compileModulesAndImport({
  entry,
  modules,
}: {
  entry: string;
  modules: Readonly<Record<string, string>>;
}): Promise<Record<string, unknown>> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-naidan-systemjs-'));
  temporaryDirectories.push(directory);

  for (const [fileName, source] of Object.entries(modules)) {
    const output = transformToSystemJs({ code: source, fileName });
    expect(output.code).toContain('System.register(');
    const outputPath = path.join(directory, fileName);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, output.code, 'utf8');
  }

  return System.import(pathToFileURL(path.join(directory, entry)).href);
}

describe('SWC SystemJS semantics', () => {
  it('uses compact code generation without enabling compression or identifier mangling', async () => {
    const output = transformToSystemJs({
      code: `const longUnusedName = 123; function longLocalFunctionName(longParameterName) { const longLocalName = longParameterName + 1; return longLocalName; } export const result = longLocalFunctionName(1);`,
      fileName: 'printer-contract.js',
    });

    expect(output.code).toContain('longUnusedName');
    expect(output.code).toContain('longLocalFunctionName');
    expect(output.code).toContain('longParameterName');
    expect(output.code).toContain('longLocalName');
  });

  it('includes the output chunk file name in parse diagnostics', () => {
    expect(() => transformToSystemJs({
      code: `export const = ;`,
      fileName: 'chunks/diagnostic-contract.js',
    })).toThrow(/chunks\/diagnostic-contract\.js/u);
  });

  it('preserves imported re-export live bindings', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'source.js': `export let value = 1; export function bump() { value++; }`,
        'reexport.js': `import { value } from './source.js'; export { value as current };`,
        'entry.js': `import { current } from './reexport.js'; import { bump } from './source.js'; export function run() { const before = current; bump(); return [before, current]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([1, 2]);
  });

  it('preserves BigInt post-increment on an exported binding', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'entry.js': `export let value = 1n; export function run() { const old = value++; return [old.toString(), value.toString()]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual(['1', '2']);
  });

  it('preserves ordinary destructuring assignments', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'entry.js': `let left; let right; [left, right] = [1, 2]; export function run() { return [left, right]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([1, 2]);
  });

  it('updates an exported binding through for-of', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export let value = 0; export function run() { for (value of [1, 2, 3]) {} }`,
        'entry.js': `import { value, run } from './state.js'; export function observe() { const before = value; run(); return [before, value]; }`,
      },
    });
    expect((module.observe as () => unknown)()).toEqual([0, 3]);
  });

  it('keeps default class evaluation inside module execution order', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'class.js': `const value = 7; export default class Example { static value = value; }`,
        'entry.js': `import Example from './class.js'; export const result = Example.value;`,
      },
    });
    expect(module.result).toBe(7);
  });

  it('preserves dynamic import', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'lazy.js': `export const value = 'lazy-ready';`,
        'entry.js': `export async function run() { const lazy = await import('./lazy.js'); return lazy.value; }`,
      },
    });
    await expect((module.run as () => Promise<unknown>)()).resolves.toBe('lazy-ready');
  });

  it('provides import.meta.url through the SystemJS context', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'entry.js': `export const url = import.meta.url;`,
      },
    });
    expect(String(module.url)).toMatch(/\/entry\.js$/u);
  });

  it('preserves a circular dependency with a late read', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'a.js': `import { readAFromB } from './b.js'; export const a = 'A'; export function readCycle() { return readAFromB(); }`,
        'b.js': `import { a } from './a.js'; export function readAFromB() { return 'B:' + a; }`,
        'entry.js': `import { readCycle } from './a.js'; export const result = readCycle();`,
      },
    });
    expect(module.result).toBe('B:A');
  });

  it('preserves direct re-export live bindings', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'source.js': `export let value = 1; export function bump() { value++; }`,
        'reexport.js': `export { value as current } from './source.js';`,
        'entry.js': `import { current } from './reexport.js'; import { bump } from './source.js'; export function run() { const before = current; bump(); return [before, current]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([1, 2]);
  });

  it('preserves export-star live bindings', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'source.js': `export let value = 1; export function bump() { value++; }`,
        'reexport.js': `export * from './source.js';`,
        'entry.js': `import { value, bump } from './reexport.js'; export function run() { const before = value; bump(); return [before, value]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([1, 2]);
  });

  it('updates an exported binding through compound assignment', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export let value = 1; export function add() { value += 2; }`,
        'entry.js': `import { value, add } from './state.js'; export function run() { const before = value; add(); return [before, value]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([1, 3]);
  });

  it('updates exported bindings through destructuring assignment', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export let left = 0; export let right = 0; export function assign() { [left, right] = [3, 4]; }`,
        'entry.js': `import { left, right, assign } from './state.js'; export function run() { const before = [left, right]; assign(); return [before, [left, right]]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([[0, 0], [3, 4]]);
  });

  it('updates an exported binding through for-in', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export let key = ''; export function run() { for (key in { first: 1, second: 2 }) {} }`,
        'entry.js': `import { key, run } from './state.js'; export function observe() { const before = key; run(); return [before, key]; }`,
      },
    });
    expect((module.observe as () => unknown)()).toEqual(['', 'second']);
  });

  it('updates an exported binding through prefix increment', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export let value = 1; export function run() { return ++value; }`,
        'entry.js': `import { value, run } from './state.js'; export function observe() { const returned = run(); return [returned, value]; }`,
      },
    });
    expect((module.observe as () => unknown)()).toEqual([2, 2]);
  });

  it('preserves top-level await', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'entry.js': `export const value = await Promise.resolve(7);`,
      },
    });
    expect(module.value).toBe(7);
  });

  it('provides import.meta.resolve through the SystemJS context', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'dependency.js': `export const value = true;`,
        'entry.js': `export const resolved = await import.meta.resolve('./dependency.js');`,
      },
    });
    expect(String(module.resolved)).toMatch(/\/dependency\.js$/u);
  });

  it('preserves namespace imports', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'source.js': `export const left = 2; export const right = 3;`,
        'entry.js': `import * as values from './source.js'; export const result = values.left + values.right;`,
      },
    });
    expect(module.result).toBe(5);
  });

  it('preserves side-effect import execution order', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export const events = []; export function mark(value) { events.push(value); }`,
        'side-effect.js': `import { mark } from './state.js'; mark('side-effect');`,
        'entry.js': `import './side-effect.js'; import { events } from './state.js'; export const result = [...events];`,
      },
    });
    expect(module.result).toEqual(['side-effect']);
  });

  it('preserves a default re-export alias', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'source.js': `export default 7;`,
        'reexport.js': `export { default as value } from './source.js';`,
        'entry.js': `import { value } from './reexport.js'; export const result = value;`,
      },
    });
    expect(module.result).toBe(7);
  });

  it('preserves namespace re-exports', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'source.js': `export const value = 9;`,
        'reexport.js': `export * as source from './source.js';`,
        'entry.js': `import { source } from './reexport.js'; export const result = source.value;`,
      },
    });
    expect(module.result).toBe(9);
  });

  it('preserves module top-level this as undefined', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'entry.js': `export const result = this === undefined;`,
      },
    });
    expect(module.result).toBe(true);
  });

  it('preserves module strict mode for ordinary function calls', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'entry.js': `export const result = (function ordinary() { return this; })() === undefined;`,
      },
    });
    expect(module.result).toBe(true);
  });

  it('updates an exported binding through direct assignment', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export let value = 1; export function setValue() { value = 5; }`,
        'entry.js': `import { value, setValue } from './state.js'; export function run() { const before = value; setValue(); return [before, value]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([1, 5]);
  });

  it('updates an exported binding through logical assignment', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'state.js': `export let value = 0; export function ensureValue() { value ||= 7; }`,
        'entry.js': `import { value, ensureValue } from './state.js'; export function run() { const before = value; ensureValue(); return [before, value]; }`,
      },
    });
    expect((module.run as () => unknown)()).toEqual([0, 7]);
  });

  it('preserves dynamic import rejection for a missing module', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'entry.js': `export async function run() { return import('./missing.js'); }`,
      },
    });
    await expect((module.run as () => Promise<unknown>)()).rejects.toBeDefined();
  });

  it('propagates imported module evaluation errors through dynamic import', async () => {
    const module = await compileModulesAndImport({
      entry: 'entry.js',
      modules: {
        'lazy.js': `throw new Error('lazy-boom'); export const unreachable = true;`,
        'entry.js': `export async function run() { return import('./lazy.js'); }`,
      },
    });
    await expect((module.run as () => Promise<unknown>)()).rejects.toThrow('lazy-boom');
  });

});
