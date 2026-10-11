import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import { rule } from './no-test-support-imports.js';

function lint({ code, filename }: { code: string, filename: string }) {
  return new Linter().verify(code, [{
    files: ['**/*.{ts,tsx,js,vue}'],
    languageOptions: { parser: filename.endsWith('.vue') ? vueParser : tsParser, parserOptions: { parser: tsParser, sourceType: 'module', ecmaVersion: 'latest' } },
    plugins: { local: { rules: { imports: rule } } },
    rules: { 'local/imports': 'error' },
  }], { filename });
}

const forbidden = [
  'import "@/test-tmp/runtime";',
  'import "@/lint-rule-tmp/runtime";',
  'import "../eslint-local-rules/fixtures/negative";',
  'import { helper } from "./helper.test-support";',
  'import type { Helper } from "./helper.test-support";',
  'export { helper } from "./helper.test-support.ts";',
  'export * from "@/utils/helper.test-support";',
  'import("./helper.test-support.ts?raw");',
  'const suffix = ".test-support"; import(`./helper${suffix}`);',
  'const a = "helper"; import("./" + a + a + ".test-support");',
  'require("./helper.test-support");',
  'const load = require; load("./helper.test-support");',
  'importScripts("./helper.test-support.ts");',
  'require.resolve("./helper.test-support");',
  'audioWorklet.addModule("./helper.test-support.ts");',
  'import helper = require("./helper.test-support");',
  'type T = import("./helper.test-support").Helper;',
  'new Worker("./helper.test-support.ts");',
  'new SharedWorker(new URL("./helper.test-support.ts", import.meta.url));',
  'new URL("./helper.test-support.ts", import.meta.url);',
  'import.meta.glob("./*.test-support.ts");',
  'import.meta.glob(["./*.ts", "./*.test-support.ts"]);',
  'import "./test-utils";',
  'import "./test-support/index";',
  'import "./test-mocks/worker";',
  'import "./helper.test-helpers";',
  'import "./helper.test.ts";',
  'import "./helper.spec.ts";',
];

describe('no-test-support-imports', () => {
  it.each(forbidden)('blocks a production dependency: %s', code => {
    const messages = lint({ code, filename: 'src/runtime.ts' });
    expect(messages.some(message => message.fatal)).toBe(false);
    expect(messages.map(message => message.messageId)).toContain('forbidden');
  });

  it.each(['src/helper.test.ts', 'src/helper.test-support.ts'])('allows test-only dependency chains in %s', filename => {
    for (const code of forbidden) expect(lint({ code, filename })).toEqual([]);
  });

  it.each(['src/test-support/helper.ts', 'src/helper.test-helpers.ts', 'src/helper.test-support.tsx'])('does not exempt lookalike support importers: %s', filename => {
    expect(lint({ code: forbidden[0]!, filename }).map(message => message.messageId)).toContain('forbidden');
  });

  it.each([
    '<script setup lang="ts">import x from "./helper.test-support";</script>',
    '<template><button @click="import(\'./helper.test-support\')" /></template>',
  ])('blocks Vue dependencies: %s', code => {
    expect(lint({ code, filename: 'src/View.vue' }).map(message => message.messageId)).toContain('forbidden');
  });

  it.each([
    'import { x } from "./resource";',
    'import "./contest-support";',
    'import "./test-supporting";',
    'import "./application";',
    'function f(require: (value: string) => void) { require("./helper.test-support"); }',
    'const require = localLoader; require("./helper.test-support");',
  ])('preserves unrelated imports and lexical shadowing: %s', code => {
    expect(lint({ code, filename: 'src/runtime.ts' })).toEqual([]);
  });
});
