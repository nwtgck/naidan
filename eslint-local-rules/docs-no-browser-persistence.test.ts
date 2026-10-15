import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import vue from 'eslint-plugin-vue';
import docsNoBrowserPersistence from './docs-no-browser-persistence.js';

function restricted({ code, filename }: { code: string; filename: string }) {
  return new Linter().verify(code, [
    {
      files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}'],
      languageOptions: {
        parser: filename.endsWith('.vue') ? vueParser : tsParser,
        parserOptions: { parser: tsParser, sourceType: 'module', ecmaVersion: 'latest' },
      },
      plugins: { vue },
    },
    docsNoBrowserPersistence,
  ], { filename }).filter(message => message.ruleId === 'no-restricted-syntax' || message.ruleId === 'vue/no-restricted-syntax');
}

describe('Docs browser persistence authoring boundary', () => {
  it.each([
    'localStorage.setItem("x", "y")',
    'window.localStorage.setItem("x", "y")',
    'globalThis["localStorage"].setItem("x", "y")',
    'window[`localStorage`].setItem("x", "y")',
    'self.sessionStorage.setItem("x", "y")',
    'const { localStorage: store } = window; store.setItem("x", "y")',
    'const { ["localStorage"]: store } = globalThis; store.setItem("x", "y")',
    '({ ["localStorage"]: store } = window); store.setItem("x", "y")',
    '({ [`localStorage`]: store } = window); store.setItem("x", "y")',
    'const host = window; host.localStorage.setItem("x", "y")',
    'indexedDB.open("x")',
    'caches.open("x")',
    'cookieStore.set({ name: "x", value: "y" })',
    'navigator.storage.getDirectory()',
    'window.navigator.serviceWorker.register("sw.js")',
    'globalThis[`navigator`][`storage`].getDirectory()',
    'globalThis["document"]["cookie"] = "x=y"',
    'self[`document`][`cookie`] = "x=y"',
    'const { storage: store } = navigator; store.getDirectory()',
    'const { ["cookie"]: value } = window.document; void value',
    '({ storage: store } = navigator)',
    '({ [`storage`]: store } = window[`navigator`])',
    'showSaveFilePicker()',
    'handle.createWritable()',
    'handle[`createSyncAccessHandle`]()',
  ])('rejects ordinary persistence access: %s', code => {
    expect(restricted({ code, filename: 'docs/client/example.ts' }).length).toBeGreaterThan(0);
  });

  it.each([
    'window[unknownKey]',
    'globalThis["unrelated"]',
    'self[`other`]',
    'window?.[unknownKey]',
  ])('rejects computed access on global objects even without a persistence key: %s', code => {
    expect(restricted({ code, filename: 'docs/client/example.ts' }).some(message => message.message.includes('computed global access'))).toBe(true);
  });

  it.each([
    '<script setup lang="ts">window.localStorage.getItem("x")</script><template><div /></template>',
    '<script setup lang="ts"></script><template><button @click="localStorage.setItem(\'x\', \'y\')">Save</button></template>',
    '<script setup lang="ts"></script><template><button @click="globalThis[\'localStorage\'].setItem(\'x\', \'y\')">Save</button></template>',
    '<script setup lang="ts"></script><template><p>{{ window[dynamicKey] }}</p></template>',
    '<script setup lang="ts"></script><template><button @click="navigator.storage.getDirectory()">Save</button></template>',
    '<script setup lang="ts"></script><template><p>{{ document.cookie }}</p></template>',
  ])('checks Vue script and template expressions: %s', code => {
    expect(restricted({ code, filename: 'docs/islands/example.vue' }).length).toBeGreaterThan(0);
  });

  it('allows only the annotated source line as an intentional local exception', () => {
    const code = `\
// eslint-disable-next-line no-restricted-syntax -- The typed Docs settings store owns this call.
window.localStorage.getItem('naidan_docs:settings');
window.localStorage.setItem('other', 'value');`;
    expect(restricted({ code, filename: 'docs/client/example.ts' }).map(message => message.line)).toEqual([3]);
  });

  it('leaves unrelated state, HTTP requests and ordinary navigation alone', () => {
    const code = `\
const cache = new Map();
const description = messages.storage;
const next = new URL('/docs/en/', location.href);
void fetch(next.href);
void cache;
void description;`;
    expect(restricted({ code, filename: 'docs/client/example.ts' })).toEqual([]);
    expect(restricted({ code: '<script setup lang="ts"></script><template><p>{{ messages.storage }}</p></template>', filename: 'docs/islands/example.vue' })).toEqual([]);
    expect(restricted({ code: 'showOpenFilePicker(); showDirectoryPicker()', filename: 'docs/client/example.ts' })).toEqual([]);
  });

  it('does not restrict Docs tests or application code', () => {
    const code = 'window.localStorage.setItem("x", "y")';
    expect(restricted({ code, filename: 'docs/tests/settings.test.ts' })).toEqual([]);
    expect(restricted({ code, filename: 'docs/tests/settings.test-support.ts' })).toEqual([]);
    expect(restricted({ code, filename: 'src/client/settings.ts' })).toEqual([]);
  });

  it('also checks executable JavaScript helpers in Docs', () => {
    expect(restricted({ code: 'window.localStorage.setItem("x", "y")', filename: 'docs/client/helper.mjs' }).length).toBeGreaterThan(0);
  });
});
