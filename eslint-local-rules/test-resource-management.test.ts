import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import { rule } from './test-resource-management.js';

function lint({ code, filename }: { code: string, filename: string }) {
  return new Linter().verify(code, [{
    files: ['**/*.{ts,tsx,js,vue}'],
    languageOptions: {
      parser: filename.endsWith('.vue') ? vueParser : tsParser,
      parserOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { local: { rules: { resource: rule } } },
    rules: { 'local/resource': 'error' },
  }], { filename });
}

const runtimeAccesses = [
  'Symbol[chooseKey()];',
  'const { [chooseKey()]: value } = Symbol;',
  'Reflect.get(Symbol, chooseKey());',
  'let S = Symbol; S.dispose;',
  'var S = globalThis.Symbol; S.asyncDispose;',
  'const get = Reflect.get; get(Symbol, "dispose");',
  'const { get: read } = Reflect; read(Symbol, "asyncDispose");',
  'const { getOwnPropertyDescriptor: read } = Object; read(Symbol, "dispose");',
  'Symbol.dispose;',
  'Symbol.asyncDispose;',
  'Symbol["dispose"];',
  'Symbol[`async${"Dispose"}`];',
  'const key = "dis"; Symbol[key + "pose"];',
  'const S = Symbol; S.dispose;',
  'const S = globalThis.Symbol; S.asyncDispose;',
  'const root = window; const { Symbol: S } = root; S.dispose;',
  'const { dispose: close } = Symbol;',
  'let close; ({ asyncDispose: close } = Symbol);',
  '(Symbol as SymbolConstructor)!.dispose;',
  'Reflect.get(Symbol, "dispose");',
  'const O = Object; O.getOwnPropertyDescriptor(Symbol, "asyncDispose");',
  'type Key = typeof Symbol.dispose;',
  'type Key = (typeof Symbol)["asyncDispose"];',
  'new DisposableStack();',
  'new globalThis.AsyncDisposableStack();',
  'const C = SuppressedError; new C(first, second);',
];

const forbiddenPolyfills = [
  'import "core-js";',
  'import "core-js/stable";',
  'import "core-js/actual/index.js";',
  'import "core-js-pure/full";',
  'import fallback = require("core-js/proposals/explicit-resource-management");',
  'const fallback = "core-js/actual/symbol/dispose"; import(fallback);',
  'Symbol[chooseKey()] = Symbol();',
  'Reflect.set(Symbol, chooseKey(), Symbol());',
  'Object.defineProperties(Symbol, { [chooseKey()]: { value: Symbol() } });',
  'Object.assign(globalThis, { Symbol: replacement });',
  'Object.defineProperties(globalThis, { SuppressedError: { value: replacement } });',
  'let S = Symbol; S.dispose = Symbol();',
  'const define = Object.defineProperty; define(Symbol, "dispose", { value: Symbol() });',
  'const { set: write } = Reflect; write(Symbol, "dispose", Symbol());',
  'const lookup = Symbol.for; lookup("Symbol.dispose");',
  'import("core-js/proposals/explicit-resource-management");',
  'require("core-js/actual/symbol/dispose");',
  'globalThis.Symbol = replacement;',
  'const root = globalThis; root.Symbol = replacement;',
  'Object.defineProperty(globalThis, "Symbol", { value: replacement });',
  'Reflect.set(globalThis, "Symbol", replacement);',
  'globalThis.DisposableStack = class {};',
  'vi.stubGlobal("Symbol", { dispose: Symbol() });',
  'vi.stubGlobal("AsyncDisposableStack", class {});',
  'Symbol.dispose ??= Symbol();',
  'Symbol["asyncDispose"] = Symbol();',
  'const S = Symbol; S.dispose = Symbol();',
  'Reflect.set(Symbol, "dispose", Symbol());',
  'Object.defineProperty(Symbol, "asyncDispose", { value: Symbol() });',
  'Object.defineProperties(Symbol, { dispose: { value: Symbol() } });',
  'Object.assign(Symbol, { asyncDispose: Symbol() });',
  'Object.assign(Symbol, descriptors);',
  'delete Symbol.dispose;',
  'Symbol.for("Symbol.dispose");',
  'Symbol("Symbol.asyncDispose");',
  'import "core-js/proposals/explicit-resource-management";',
  'Object.defineProperty(globalThis, "DisposableStack", { value: class {} });',
];

describe('test-resource-management', () => {
  it.each(runtimeAccesses)('rejects runtime access: %s', code => {
    const messages = lint({ code, filename: 'src/runtime.ts' });
    expect(messages.some(message => message.fatal)).toBe(false);
    expect(messages.map(message => message.messageId)).toContain('protocolOnlyInTest');
  });

  it.each(['src/example.test.ts', 'src/example.test-support.ts'])('permits protocols only in %s', filename => {
    for (const code of runtimeAccesses) expect(lint({ code, filename })).toEqual([]);
  });

  it.each(['src/runtime.ts', 'src/runtime.js', 'src/example.test.tsx', 'src/example.test-support.ts', 'src/test-support/helper.ts', 'src/example.test-helpers.ts'])('rejects using declarations in %s', filename => {
    for (const code of ['using resource = make();', 'async function run() { await using resource = make(); }']) {
      expect(lint({ code, filename }).map(message => message.messageId)).toContain('usingOnlyInTest');
    }
  });

  it('permits both declaration forms in actual tests', () => {
    expect(lint({ code: 'using resource = make(); async function run() { await using other = make(); }', filename: 'src/resource.test.ts' })).toEqual([]);
  });

  it.each(['src/test-support/helper.ts', 'src/example.test-helpers.ts', 'src/example.test-support.tsx', 'src/example.test-support.ts.vue'])('does not grant protocol permission to lookalike names: %s', filename => {
    const code = filename.endsWith('.vue') ? '<script setup lang="ts">Symbol.dispose;</script>' : 'Symbol.dispose;';
    expect(lint({ code, filename }).map(message => message.messageId)).toContain('protocolOnlyInTest');
  });

  it.each(forbiddenPolyfills)('rejects polyfills even in tests and support: %s', code => {
    for (const filename of ['src/resource.test.ts', 'src/resource.test-support.ts']) {
      const messages = lint({ code, filename });
      expect(messages.some(message => message.fatal)).toBe(false);
      expect(messages.map(message => message.messageId)).toContain('noPolyfill');
    }
  });

  it('respects template-local and script-setup shadows', () => {
    for (const code of [
      '<template><button @click="(Symbol) => Symbol.dispose" /></template>',
      '<template><div v-for="Symbol in items">{{ Symbol.dispose }}</div></template>',
      '<script setup lang="ts">const Symbol = { dispose: 1 };</script><template>{{ Symbol.dispose }}</template>',
    ]) expect(lint({ code, filename: 'src/View.vue' })).toEqual([]);
  });

  it.each([
    'resource.dispose(); resource.asyncDispose(); resource.close();',
    'import "core-js/actual/array/to-sorted";',
    'Symbol.iterator; Symbol.asyncIterator; Symbol.for("application-key");',
    'globalThis.Symbol.iterator; globalThis.Symbol.asyncIterator;',
    'const S = globalThis.Symbol; S.for("application-key"); S.iterator;',
    'const { Symbol: S } = globalThis; S.asyncIterator;',
    'function run(Symbol: { dispose: number }) { return Symbol.dispose; }',
    'const Symbol = { dispose: 1 }; Symbol.dispose;',
    'const Object = { defineProperty() {} }; Object.defineProperty(Symbol, "dispose", {});',
    'const box = { DisposableStack: 1 }; box.DisposableStack;',
    'class DisposableStack {} new DisposableStack();',
    'Object.defineProperty(Symbol, "applicationSymbol", { value: Symbol() });',
  ])('does not reject ordinary implementations: %s', code => {
    expect(lint({ code, filename: 'src/runtime.ts' })).toEqual([]);
  });

  it.each([
    '<script setup lang="ts">using resource = make();</script>',
    '<script lang="ts">async function run() { await using resource = make(); }</script>',
    '<template><button @click="() => { using resource = make(); }" /></template>',
    '<template><button @click="async () => { await using resource = make(); }" /></template>',
  ])('rejects using throughout Vue: %s', code => {
    const messages = lint({ code, filename: 'src/View.vue' });
    expect(messages.some(message => message.fatal)).toBe(false);
    expect(messages.map(message => message.messageId)).toContain('usingOnlyInTest');
  });

  it.each([
    '<script setup lang="ts">Symbol.dispose;</script>',
    '<template>{{ Symbol.asyncDispose }}</template>',
    '<template><button @click="() => { const S = Symbol; return S.dispose; }" /></template>',
    '<script setup lang="ts">const S = Symbol;</script><template>{{ S.dispose }}</template>',
    '<template><button @click="Reflect.get(Symbol, \'dispose\')" /></template>',
  ])('rejects disposal protocols throughout Vue: %s', code => {
    const messages = lint({ code, filename: 'src/View.vue' });
    expect(messages.some(message => message.fatal)).toBe(false);
    expect(messages.map(message => message.messageId)).toContain('protocolOnlyInTest');
  });
});
