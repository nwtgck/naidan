// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import { rule } from './require-native-config-imports.js';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-native-config-lint-'));
  function write({ filename, code }: { filename: string; code: string }): void {
    const target = path.join(root, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code);
  }
  write({ filename: 'vite.config.ts', code: "import './build/helper.ts';" });
  write({ filename: 'build/helper.ts', code: 'export const value = 1;' });
  write({ filename: 'build/leaf.ts', code: 'export const leaf = 1;' });
  write({ filename: 'build/directory/index.ts', code: 'export const leaf = 1;' });
  write({ filename: 'data.json', code: '{"value":1}' });
  write({ filename: 'package.json', code: '{"type":"module"}' });
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
      languageOptions: { parser, parserOptions: { sourceType: 'module', ecmaVersion: 'latest' } },
      plugins: { native: { rules: { imports: rule } } },
      rules: { 'native/imports': ['error', { entryFile: path.join(root, 'vite.config.ts') }] },
    },
  });
  return {
    root,
    write,
    async lint({ filename, code }: { filename: string; code: string }) {
      const [result] = await eslint.lintText(code, { filePath: path.join(root, filename) });
      if (!result) {
        throw new Error('Expected a lint result');
      }
      expect(result.messages.some(message => message.fatal)).toBe(false);
      return result.messages.map(message => message.messageId);
    },
    [Symbol.dispose]() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('native Vite configuration imports', () => {
  it.each([
    "import './build/helper';",
    "export { value } from './build/helper';",
    "export * from './build/helper';",
    "const module = import('./build/helper');",
    'const module = import(`./build/helper`);',
    "type Module = import('./build/helper');",
    "import type { Value } from './build/helper';",
    "import './build/directory';",
  ])('rejects implicit file resolution in the config entry: %s', async code => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'vite.config.ts', code })).toEqual(['extension']);
  });

  it('requires the exact existing filename instead of TypeScript .js substitution', async () => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import './build/helper.js';" })).toEqual(['missing']);
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import './build/missing.ts';" })).toEqual(['missing']);
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import './build/bad%ZZ.ts';" })).toEqual(['missing']);
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import './build/helper.ts'; import './build/directory/index.ts';" })).toEqual([]);
    fixture.write({ filename: 'build/actual.js', code: 'export const actual = 1;' });
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import './build/actual.js';" })).toEqual([]);
  });

  it('allows package imports, Node builtins, file URLs, and URL query suffixes', async () => {
    using fixture = project();
    const fileUrl = new URL('build/helper.ts', 'file://' + fixture.root + '/').href;
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import fs from 'node:fs'; import z from 'zod'; import './build/helper.ts?fresh#v1'; import '" + fileUrl + "';" })).toEqual([]);
  });

  it('checks indirect re-export and literal dynamic dependencies, including cycles', async () => {
    using fixture = project();
    fixture.write({ filename: 'build/helper.ts', code: "export * from './leaf.ts';" });
    fixture.write({ filename: 'build/leaf.ts', code: "void import('./cycle.ts');" });
    fixture.write({ filename: 'build/cycle.ts', code: "import './helper.ts';" });
    expect(await fixture.lint({ filename: 'build/cycle.ts', code: "import './helper';" })).toEqual(['extension']);
  });

  it('does not impose native syntax on unrelated application and build modules', async () => {
    using fixture = project();
    for (const filename of ['src/feature.ts', 'build/unrelated.ts']) {
      expect(await fixture.lint({ filename, code: "import './extensionless'; console.log(__dirname);" })).toEqual([]);
    }
  });

  it('rejects runtime application aliases but permits erased type aliases', async () => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import { value } from '@/app';" })).toEqual(['alias']);
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import type { Value } from '@/app';" })).toEqual([]);
  });

  it.each([
    "import type { Thing } from './build/types.ts';",
    "import { type Thing } from './build/types.ts';",
    "export type { Thing } from './build/types.ts';",
    "export { type Thing } from './build/types.ts';",
    "type Thing = import('./build/types.ts').Thing;",
  ])('does not expand the runtime graph through erased type-only edges: %s', async code => {
    using fixture = project();
    fixture.write({ filename: 'vite.config.ts', code });
    fixture.write({ filename: 'build/types.ts', code: 'export type Thing = string;' });
    expect(await fixture.lint({ filename: 'build/types.ts', code: "import './implicit'; console.log(__dirname);" })).toEqual([]);
  });

  it('keeps mixed value/type imports in the runtime graph', async () => {
    using fixture = project();
    fixture.write({ filename: 'vite.config.ts', code: "import { value, type Thing } from './build/helper.ts';" });
    expect(await fixture.lint({ filename: 'build/helper.ts', code: "import './leaf';" })).toEqual(['extension']);
  });

  it('refreshes graph membership after files and the entry change', async () => {
    using fixture = project();
    fixture.write({ filename: 'vite.config.ts', code: "import './build/new.ts';" });
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import './build/new.ts';" })).toEqual(['missing']);
    fixture.write({ filename: 'build/new.ts', code: "import './leaf';" });
    expect(await fixture.lint({ filename: 'build/new.ts', code: "import './leaf';" })).toEqual(['extension']);
    fixture.write({ filename: 'vite.config.ts', code: "import './build/helper.ts';" });
    expect(await fixture.lint({ filename: 'build/new.ts', code: "import './leaf';" })).toEqual([]);
  });

  it('uses current virtual config input without leaking its graph to later lint calls', async () => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import './build/leaf.ts';" })).toEqual([]);
    expect(await fixture.lint({ filename: 'build/helper.ts', code: "import './leaf';" })).toEqual(['extension']);
    expect(await fixture.lint({ filename: 'build/leaf.ts', code: "import './helper';" })).toEqual([]);
  });

  it.each([
    "import data from './data.json';",
    "export { default } from './data.json';",
    "void import('./data.json');",
    "void import('./data.json', { assert: { type: 'json' } });",
    "import data from 'package/data.json';",
    "import data from './data.json' assert { type: 'json' };",
    "import data from './data.json' /* with { */ assert { type: 'json' };",
  ])('requires JSON import attributes: %s', async code => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'vite.config.ts', code })).toEqual(['json']);
  });

  it.each([
    "import data from './data.json' with { type: 'json' };",
    "export { default } from './data.json' with { type: 'json' };",
    "void import('./data.json', { with: { type: 'json' } });",
    "import data from 'package/data.json' with { type: 'json' };",
    "type Data = import('./data.json');",
  ])('accepts native JSON syntax and erased type queries: %s', async code => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'vite.config.ts', code })).toEqual([]);
  });

  it('rejects named JSON bindings while allowing default and namespace imports', async () => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import { value } from './data.json' with { type: 'json' };" })).toEqual(['jsonNamed']);
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import * as data from './data.json' with { type: 'json' };" })).toEqual([]);
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import { default as data } from './data.json' with { type: 'json' };" })).toEqual([]);
    expect(await fixture.lint({ filename: 'vite.config.ts', code: "import { 'default' as data } from './data.json' with { type: 'json' };" })).toEqual([]);
  });

  it('rejects free CommonJS globals in actual references, including shorthand properties', async () => {
    using fixture = project();
    expect(await fixture.lint({ filename: 'build/helper.ts', code: 'console.log(__dirname, __filename); const value = { __dirname };' })).toEqual(['dirname', 'dirname', 'dirname']);
  });

  it('allows local bindings, property names, and import.meta file locations', async () => {
    using fixture = project();
    const code = `\
const __dirname = import.meta.dirname;
function location(__filename: string) { return { __filename, __dirname }; }
const object = { __filename: 'name' };
console.log(object.__filename, location(import.meta.filename));
`;
    expect(await fixture.lint({ filename: 'build/helper.ts', code })).toEqual([]);
  });

  it('allows Node-provided globals in explicitly CommonJS dependencies', async () => {
    using fixture = project();
    fixture.write({ filename: 'vite.config.ts', code: "import './build/helper.cjs';" });
    fixture.write({ filename: 'build/helper.cjs', code: 'module.exports = __dirname;' });
    expect(await fixture.lint({ filename: 'build/helper.cjs', code: 'module.exports = __dirname;' })).toEqual([]);
  });
});
