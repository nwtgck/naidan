// @vitest-environment node
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter, type Rule } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import statementLayout from './statement-layout.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ruleId = 'local-rules-statement-layout/statement-layout';
const linter = new Linter();
const config: Linter.Config[] = [
  {
    files: ['**/*.{js,ts,tsx,vue}'],
    languageOptions: { parser: tsParser, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { indent: ['error', 2], 'no-trailing-spaces': 'error' },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parser: vueParser, parserOptions: { parser: tsParser } },
  },
  statementLayout,
];

function format({ code, filename }: { code: string; filename?: string }) {
  return linter.verifyAndFix(code, config, { filename: filename ?? 'src/example.ts' });
}

function ast({ code }: { code: string }): unknown {
  const parsed = tsParser.parse(code, { sourceType: 'module', ecmaFeatures: { jsx: true } });
  return JSON.parse(JSON.stringify(parsed, (key, value: unknown) => ['loc', 'range', 'tokens', 'comments'].includes(key) ? undefined : value));
}

function expectFixed({ code, expected, preserveAst }: { code: string; expected: string; preserveAst?: boolean }) {
  const result = format({ code });
  expect(result.messages).toEqual([]);
  expect(result.output).toBe(expected);
  if (preserveAst) {
    expect(ast({ code: result.output })).toEqual(ast({ code }));
  }
  const repeated = format({ code: result.output });
  expect(repeated.fixed).toBe(false);
  expect(repeated.messages).toEqual([]);
  expect(repeated.output).toBe(expected);
}

describe('statement layout', () => {
  it('builds the whitespace protection index only on the first report in each lint pass', () => {
    let indexes = 0;
    const wrapped = statementLayout.plugins['local-rules-statement-layout'].rules['no-trailing-spaces'];
    const measured: Rule.RuleModule = {
      ...wrapped,
      create(context) {
        const sourceCode = Object.create(context.sourceCode, {
          getTokens: {
            value(node: Rule.Node) {
              if (node === context.sourceCode.ast) {
                indexes += 1;
              }
              return context.sourceCode.getTokens(node);
            },
          },
        });
        return wrapped.create(Object.create(context, { sourceCode: { value: sourceCode } }));
      },
    };
    const measuredConfig: Linter.Config[] = [{
      plugins: { measured: { rules: { whitespace: measured } } },
      rules: { 'measured/whitespace': 'error' },
    }];
    const verify = (code: string) => linter.verify(code, measuredConfig);
    expect(verify('const value = 1;\n')).toEqual([]);
    expect(indexes).toBe(0);
    const invalid = 'const first = 1;  \nconst second = 2;  \n';
    expect(verify(invalid)).toHaveLength(2);
    expect(indexes).toBe(1);
    expect(verify(invalid)).toHaveLength(2);
    expect(indexes).toBe(2);
    const fixed = linter.verifyAndFix(invalid, measuredConfig);
    expect(fixed.output).toBe('const first = 1;\nconst second = 2;\n');
    expect(fixed.messages).toEqual([]);
    // One index for the invalid pass, none for the clean verification pass.
    expect(indexes).toBe(3);
  });

  it.each([
    ['calls', 'first(); second(); third();', 'first();\nsecond();\nthird();'],
    ['declarations', 'const a = 1; let b = 2; var c = 3;', 'const a = 1;\nlet b = 2;\nvar c = 3;'],
    ['imports', 'import a from "a"; import b from "b";', 'import a from "a";\nimport b from "b";'],
    ['exports', 'export const a = 1; export default a;', 'export const a = 1;\nexport default a;'],
    ['type declarations', 'type A = string; interface B {}', 'type A = string;\ninterface B {}'],
    ['function declarations', 'function a() {} function b() {}', 'function a() {}\nfunction b() {}'],
    ['class declarations', 'class A {} class B {}', 'class A {}\nclass B {}'],
    ['multiline ends', 'first(\n  1); second();', 'first(\n  1);\nsecond();'],
    ['empty semicolons', 'first();;; second();', 'first();;;\nsecond();'],
    ['trailing empty semicolons', 'first();;;', 'first();;;'],
    ['ASI after function declarations', 'function a() {} const b = 1;', 'function a() {}\nconst b = 1;'],
  ])('separates %s at AST statement boundaries', (_name, code, expected) => {
    expectFixed({ code, expected, preserveAst: true });
  });

  it('separates all statements in a short guard', () => {
    expectFixed({
      code: 'if (cancelled) { cleanup(); return; }',
      expected: `\
if (cancelled) {
  cleanup();
  return;
}`,
    });
  });

  it('expands short functions and callbacks', () => {
    expectFixed({
      code: 'const next = () => { count++; return count; }; consume(() => { first(); second(); });',
      expected: `\
const next = () => {
  count++;
  return count;
};
consume(() => {
  first();
  second();
});`,
    });
  });

  it.each([
    ['if', 'if (ready) work();', 'if (ready) {\n  work();\n}'],
    ['else', 'if (ready) work(); else stop();', 'if (ready) {\n  work();\n} else {\n  stop();\n}'],
    ['while', 'while (ready) i++;', 'while (ready) {\n  i++;\n}'],
    ['do while', 'do i++; while (ready);', 'do {\n  i++;\n} while (ready);'],
    ['for', 'for (let i = 0; i < 3; i++) work();', 'for (let i = 0; i < 3; i++) {\n  work();\n}'],
    ['for in', 'for (const key in data) work(key);', 'for (const key in data) {\n  work(key);\n}'],
    ['for of', 'for (const item of data) work(item);', 'for (const item of data) {\n  work(item);\n}'],
    ['empty body', 'while (ready);', 'while (ready){\n  ;\n}'],
  ])('requires a block for %s', (_name, code, expected) => {
    expectFixed({ code, expected });
  });

  it('retains else-if chains', () => {
    expectFixed({
      code: 'if (a) first(); else if (b) second(); else third();',
      expected: `\
if (a) {
  first();
} else if (b) {
  second();
} else {
  third();
}`,
    });
  });

  it('preserves dangling-else binding and control-flow execution', () => {
    const code = `\
function run(a, b) {
  const log = [];
  if (a) if (b) log.push('both'); else log.push('only-a');
  for (let i = 0; i < 3; i++) if (i % 2) log.push(i); else continue;
  let i = 0;
  do i++; while (i < 2);
  while (i < 4) i++;
  return { log, i };
}
[run(false, false), run(true, false), run(true, true)];`;
    const result = format({ code });
    expect(result.messages).toEqual([]);
    expect(JSON.stringify(vm.runInNewContext(result.output))).toBe(JSON.stringify(vm.runInNewContext(code)));
    expect(format({ code: result.output }).fixed).toBe(false);
  });

  it('allows consecutive empty case labels naturally', () => {
    const code = `\
switch (value) {
case 'a': case 'b': case 'c':
  work();
  break;
default:
  stop();
}`;
    expectFixed({ code, expected: code, preserveAst: true });
  });

  it('does not impose a separate case-heading layout', () => {
    const code = `\
switch (value) {
case 'a': case 'b': work();
}`;
    expectFixed({ code, expected: code, preserveAst: true });
  });

  it('separates actual statements within a case body', () => {
    expectFixed({
      code: `\
switch (value) {
case 'a': case 'b': work(); break;
default: stop(); throw failure;
}`,
      expected: `\
switch (value) {
case 'a': case 'b': work();
  break;
default: stop();
  throw failure;
}`,
      preserveAst: true,
    });
  });

  it('separates statements across case bodies without splitting empty label groups', () => {
    expectFixed({
      code: `\
switch (value) {
case 'a': first(); case 'b': case 'c': second();
}`,
      expected: `\
switch (value) {
case 'a': first();
case 'b': case 'c': second();
}`,
      preserveAst: true,
    });
  });

  it.each([
    'for (let i = 0; i < 3; i++) {}',
    'for (;;) {}',
    'type Shape = { width: number; height: number };',
    'interface Shape { width: number; height: number }',
    'const next = () => value;',
    'const text = "a;b;c";',
    'const pattern = /a;b;c/;',
    'const text = `a;b;c`;',
    'function empty() {}',
    'if (ready) {} else {}',
    'const pair = [first(), second()];',
    'const pair = (first(), second());',
    ';;',
  ])('preserves syntax outside statement boundaries: %s', code => {
    expectFixed({ code, expected: code, preserveAst: true });
  });

  it('preserves existing blank lines and intentional expression wrapping', () => {
    const code = `\
const result = calculate(
  first,
  second,
);


consume(result);
`;
    expectFixed({ code, expected: code, preserveAst: true });
  });

  it('formats standalone blocks and namespace bodies', () => {
    expectFixed({
      code: '{ first(); second(); } namespace X { export const a = 1; export const b = 2; }',
      expected: `\
{
  first();
  second();
}
namespace X {
  export const a = 1;
  export const b = 2;
}`,
    });
  });

  it('formats static blocks and retains the surrounding class', () => {
    expectFixed({
      code: 'class X { static { first(); second(); } }',
      expected: `\
class X {
  static {
    first();
    second();
  }
}`,
    });
  });

  it('preserves comments and annotation positions between statements', () => {
    expectFixed({
      code: 'first(); /* @__PURE__ */ second();',
      expected: 'first(); /* @__PURE__ */\nsecond();',
      preserveAst: true,
    });
  });

  it('retains ordinary trailing comments with the preceding statement', () => {
    expectFixed({
      code: 'cleanup(); /* cleanup explanation */ return;',
      expected: 'cleanup(); /* cleanup explanation */\nreturn;',
      preserveAst: true,
    });
  });

  it('retains a comment at the beginning of a standalone block', () => {
    expectFixed({
      code: '{ /* explanation */ first(); second(); }',
      expected: `\
{
  /* explanation */ first();
  second();
}`,
      preserveAst: true,
    });
  });

  it('leaves Annex B function bodies for manual block introduction', () => {
    for (const code of ['if (ready) function f() {}', 'if (ready) label: function f() {}']) {
      const result = linter.verifyAndFix(code, [
        { languageOptions: { parser: tsParser, sourceType: 'script' } }, statementLayout,
      ]);
      expect(result.output).toBe(code);
      expect(result.fixed).toBe(false);
      expect(result.messages[0].ruleId).toBe(ruleId);
    }
  });

  it('converges on deeply nested control bodies across the ESLint fix-pass limit', () => {
    const code = 'if (ready) '.repeat(12) + 'work();';
    let output = code;
    let messages: Linter.LintMessage[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = format({ code: output });
      output = result.output;
      messages = result.messages;
      if (!result.fixed) {
        break;
      }
    }
    expect(messages).toEqual([]);
    expect(format({ code: output }).fixed).toBe(false);
  });

  it.each([
    '// @ts-expect-error\nif (ready) unknown();',
    '// @ts-ignore\nfirst(); second();',
    '/* c8 ignore next 1 */\nif (ready) { ignored(); }',
    '/* node:coverage ignore next 2 */\nif (ready) {\n  first(); second();\n}',
    '// eslint-disable-next-line unknown-rule\nfirst(); second();',
    'first(); /** @type {string} */ const second = 2;',
    'function run() { /** @type {string} */ const value = 2; return value; }',
    'if (ready) /* @__PURE__ */ work();',
    'if (ready)\n  /** @deprecated */\n  work();',
  ])('reports protected syntax without changing it: %s', code => {
    const result = format({ code });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(code);
    expect(result.messages.some(message => message.ruleId === ruleId)).toBe(true);
  });

  it('preserves TypeScript JSDoc attachment', () => {
    const code = 'function run() { /** @type {string} */ const value = 2; return value; }';
    const result = format({ code, filename: 'src/example.js' });
    function documentation({ source }: { source: string }) {
      const root = ts.createSourceFile('example.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const attached: { kind: string; text: string[] }[] = [];
      function visit(node: ts.Node) {
        const comments = ts.getJSDocCommentsAndTags(node);
        if (comments.length) {
          attached.push({ kind: ts.SyntaxKind[node.kind], text: comments.map(comment => comment.getText(root)) });
        }
        ts.forEachChild(node, visit);
      }
      visit(root);
      return attached;
    }
    expect(documentation({ source: result.output })).toEqual(documentation({ source: code }));
  });

  it('preserves CRLF without rewriting literal contents', () => {
    expectFixed({
      code: 'const text = `left\nright`;\r\nif (ready) consume(text); second();',
      expected: 'const text = `left\nright`;\r\nif (ready) {\r\n  consume(text);\r\n}\r\nsecond();',
    });
  });

  it('uses a trailing CRLF when a single code line has no earlier structural newline', () => {
    expectFixed({
      code: 'if (ready) work();\r\n',
      expected: 'if (ready) {\r\n  work();\r\n}\r\n',
    });
  });

  it.each(['\u2028', '\u2029'])('preserves literal Unicode separators %j when adding a block', separator => {
    const code = `const ready = true;\nif (ready) consume("left${separator}right");`;
    const result = format({ code });
    expect(result.messages).toEqual([]);
    expect(result.output).toContain(`"left${separator}right"`);
    expect(result.output).not.toContain('"left\nright"');
    expect(format({ code: result.output }).fixed).toBe(false);
  });

  it.each(['\u2028', '\u2029'])('preserves string content before a Unicode line separator %j', separator => {
    const code = `const text = "left  ${separator}right"; consume(text);`;
    const result = format({ code });
    expect(result.messages).toEqual([]);
    expect(result.output).toContain(`"left  ${separator}right"`);
    expect(ast({ code: result.output })).toEqual(ast({ code }));
    expect(format({ code: result.output }).fixed).toBe(false);
  });

  it.each([
    'const node = <pre>first  \n    second  \nend</pre>;',
    'const node = <div>left\u200B\nright</div>;',
    'function View(){return <div>\n first  \n    second  \n third\n</div>;}',
  ])('preserves JSX text and its raw whitespace: %s', code => {
    const result = format({ code, filename: 'src/example.tsx' });
    expect(result.messages).toEqual([]);
    expect(ast({ code: result.output })).toEqual(ast({ code }));
    expect(format({ code: result.output, filename: 'src/example.tsx' }).fixed).toBe(false);
  });

  it('preserves whitespace that belongs to comments', () => {
    const code = 'first(); /* explanation  \n  still explanation  \n*/ second();';
    const result = format({ code });
    expect(result.messages).toEqual([]);
    expect(result.output).toContain('/* explanation  \n  still explanation  \n*/');
    expect(format({ code: result.output }).fixed).toBe(false);
  });

  it.each([
    '/* leading  \n  keep  \n*/ first();',
    'first(); /* trailing  \n  keep  \n*/',
  ])('preserves comments outside the Program token range: %s', code => {
    expectFixed({ code, expected: code, preserveAst: true });
  });

  it('keeps companion rules out of Vue templates and styles', () => {
    const code = `\
<template>
  <pre>meaningful text__TRAILING__
  </pre>
</template>
<script setup lang="ts">
first(); second();
</script>
<style>
.x { color:red; }__TRAILING__
</style>`.replaceAll('__TRAILING__', '  ');
    const result = format({ code, filename: 'src/example.vue' });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe(code.replace('first(); second();', 'first();\nsecond();'));
    expect(format({ code: result.output, filename: 'src/example.vue' }).fixed).toBe(false);
  });

  it('modifies only the scripts of a Vue file', () => {
    const code = `\
<template><button @click="first(); second()">a;b</button></template>
<script lang="ts">
export const a = 1; export const b = 2;
</script>
<script setup lang="ts">
if (ready) work();
</script>
<style>.x { color:red;display:block }</style>`;
    const result = format({ code, filename: 'src/example.vue' });
    expect(result.messages).toEqual([]);
    expect(result.output).toContain('<template><button @click="first(); second()">a;b</button></template>');
    expect(result.output).toContain('<style>.x { color:red;display:block }</style>');
    expect(result.output).toContain('export const a = 1;\nexport const b = 2;');
    expect(result.output).toContain('if (ready) {\n  work();\n}');
    expect(format({ code: result.output, filename: 'src/example.vue' }).fixed).toBe(false);
  });

  it('does not modify gaps between adjacent Vue script blocks', () => {
    const code = '<script lang="ts">export const a = 1;</script><script setup lang="ts">const b = 2;</script>';
    const result = format({ code, filename: 'src/example.vue' });
    expect(result.messages).toEqual([]);
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(code);
  });

  it('reports violations without --fix and uses error severity', () => {
    const messages = linter.verify('first(); second();', config, { filename: 'src/example.ts' });
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe(ruleId);
    expect(messages[0].severity).toBe(2);
  });

  it('registers the rule for owned JavaScript, TypeScript, Vue, Docs, scripts, and rule tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    for (const filename of [
      'src/utils/example.ts', 'src/components/Example.vue', 'docs/components/Example.vue',
      'scripts/example.ts', 'eslint-local-rules/statement-layout.test.ts', 'eslint.config.js',
    ]) {
      const actual = await eslint.calculateConfigForFile(filename);
      expect(actual.rules[ruleId][0]).toBe(2);
      expect(actual.rules['brace-style'][0]).toBe(0);
      expect(actual.rules['indent'][0]).toBe(0);
      expect(actual.rules['no-trailing-spaces'][0]).toBe(0);
      expect(actual.rules['local-rules-statement-layout/indent']).toEqual([1, 2]);
      expect(actual.rules['local-rules-statement-layout/no-trailing-spaces'][0]).toBe(2);
    }
    const css = await eslint.calculateConfigForFile('src/style.css');
    expect(css.rules[ruleId]).toBeUndefined();
  });
});
