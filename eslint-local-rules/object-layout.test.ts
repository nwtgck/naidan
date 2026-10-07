import { ESLint, Linter, type Rule } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import * as ts from 'typescript';
import * as vueParser from 'vue-eslint-parser';
import { describe, expect, it } from 'vitest';
import ruleConfig, { rule } from './object-layout.js';
import { rule as moduleTestOnlyRule } from './require-test-only-for-module-export.js';
import { rule as composableRule } from './require-test-only-for-composable-return.js';
import { rule as exposeRule } from './require-test-only-for-define-expose.js';
import { rule as guardRule } from './require-test-only-guard.js';
import { rule as templateLiteralRule } from './prefer-multiline-template-literals.js';

const ruleId = 'local-rules-object-layout/object-layout';
const linter = new Linter();

function createConfig({ indent, vue, otherRules }: {
  indent: boolean;
  vue: boolean;
  otherRules: Linter.RulesRecord;
}): Linter.Config {
  return {
    files: ['**/*.ts', '**/*.tsx', '**/*.vue'],
    languageOptions: {
      parser: vue ? vueParser : parser,
      parserOptions: {
        ...(vue ? { parser } : {}),
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: {
      ...ruleConfig.plugins,
      'fixture-composable': { rules: { composable: composableRule as Rule.RuleModule } },
      'fixture-expose': { rules: { expose: exposeRule as Rule.RuleModule } },
      'fixture-guard': { rules: { guard: guardRule as Rule.RuleModule } },
      'fixture-template': { rules: { template: templateLiteralRule as Rule.RuleModule } },
      'fixture-module-test-only': { rules: { module: moduleTestOnlyRule as Rule.RuleModule } },
    },
    rules: {
      [ruleId]: 'error',
      ...(indent ? { indent: ['error', 2] as const } : {}),
      ...otherRules,
    },
  };
}

const scriptConfig = createConfig({ indent: true, vue: false, otherRules: {} });

// Compare structure, not just expected output. Preserve raw literal contents,
// property order, optional chains, parentheses' effects, and comment bytes.
function withoutPositions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutPositions);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['loc', 'range', 'parent', 'tokens', 'comments'].includes(key))
      .map(([key, entry]) => [key, withoutPositions(entry)]));
  }
  return value;
}

// ESTree exposes comment text but not TypeScript's JSDoc attachment. Check
// that too: moving an intact @deprecated/@internal comment can still change
// which declaration or property the compiler/language service annotates.
function documentationBindings({ code }: { code: string }) {
  const source = ts.createSourceFile('fixture.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bindings: { kind: ts.SyntaxKind; comments: string[] }[] = [];
  function visit(node: ts.Node) {
    bindings.push({ kind: node.kind, comments: ts.getJSDocCommentsAndTags(node).map(comment => comment.getText(source)) });
    ts.forEachChild(node, visit);
  }
  visit(source);
  return bindings;
}

function expectSameProgram({ before, after }: { before: string; after: string }) {
  const options = { loc: true, range: true, tokens: true, comment: true, jsx: true };
  const first = parser.parse(before, options);
  const second = parser.parse(after, options);
  expect(withoutPositions(second)).toEqual(withoutPositions(first));
  expect(second.comments?.map(comment => after.slice(...comment.range))).toEqual(
    first.comments?.map(comment => before.slice(...comment.range)),
  );
  expect(documentationBindings({ code: after })).toEqual(documentationBindings({ code: before }));
}

function expectFixed({ input, output, settings }: {
  input: string;
  output: string;
  settings: Linter.Config;
}) {
  const filename = 'fixture.tsx';
  const first = linter.verifyAndFix(input, settings, { filename });
  expect(first.messages).toEqual([]);
  expect(first.output).toBe(output);
  expectSameProgram({ before: input, after: first.output });
  const again = linter.verifyAndFix(first.output, settings, { filename });
  expect(again.messages).toEqual([]);
  expect(again.fixed).toBe(false);
  expect(again.output).toBe(first.output);
}

const cases = [
  {
    name: "spaces inside braces and around colons and separators",
    input: "const x = {key1:value1,key2:value2}",
    output: "const x = { key1: value1, key2: value2 }",
  },
  {
    name: "one property and extra whitespace",
    input: "const x = {   foo   :   value    }",
    output: "const x = { foo: value }",
  },
  {
    name: "inline trailing comma",
    input: "const x = { foo: 1, }",
    output: "const x = { foo: 1 }",
  },
  {
    name: "inline shorthand and spread",
    input: "const x = {foo,bar,...other,}",
    output: "const x = { foo, bar, ...other }",
  },
  {
    name: "computed, quoted, numeric and unicode keys",
    input: "const x = {[key]:value,\"a,b}\":1,42:2,名前:\"🙂\"}",
    output: "const x = { [key]: value, \"a,b}\": 1, 42: 2, 名前: \"🙂\" }",
  },
  {
    name: "computed key ternary and parenthesized value",
    input: "const x = {[(a ? b : c)]:((value))}",
    output: "const x = { [(a ? b : c)]: ((value)) }",
  },
  {
    name: "nested inline objects remain inline",
    input: "const x = {foo:{a:1,b:2},bar:3}",
    output: "const x = { foo: { a: 1, b: 2 }, bar: 3 }",
  },
  {
    name: "opening-only line break",
    input: `\
const x = {
  foo: 1, bar: 2 }`,
    output: `\
const x = {
  foo: 1,
  bar: 2,
}`,
  },
  {
    name: "separator-only line break",
    input: `\
const x = {key1:value1,
 key2:value2,key3:value3}`,
    output: `\
const x = {
  key1: value1,
  key2: value2,
  key3: value3,
}`,
  },
  {
    name: "closing-only line break without a trailing comma",
    input: `\
const x = { foo: 1, bar: 2
}`,
    output: `\
const x = {
  foo: 1,
  bar: 2,
}`,
  },
  {
    name: "closing-only line break with a trailing comma",
    input: `\
const x = { foo: 1, bar: 2,
}`,
    output: `\
const x = {
  foo: 1,
  bar: 2,
}`,
  },
  {
    name: "all properties originally share an inner line",
    input: `\
const x = {
  a: 1, b: 2
}`,
    output: `\
const x = {
  a: 1,
  b: 2,
}`,
  },
  {
    name: "one property stays multiline",
    input: `\
const x = {
 foo: 1 }`,
    output: `\
const x = {
  foo: 1,
}`,
  },
  {
    name: "child multiline layout expands its parent",
    input: `\
const x = { foo: {
  a: 1,
  b: 2,
} }`,
    output: `\
const x = {
  foo: {
    a: 1,
    b: 2,
  },
}`,
  },
  {
    name: "multiline parent keeps inline children inline",
    input: `\
const x = {
foo: {a:1,b:2}, bar: {c:3}
}`,
    output: `\
const x = {
  foo: { a: 1, b: 2 },
  bar: { c: 3 },
}`,
  },
  {
    name: "multiline array value",
    input: `\
const x = { values: [
  1,
  2,
] }`,
    output: `\
const x = {
  values: [
    1,
    2,
  ],
}`,
  },
  {
    name: "multiline arrow function value",
    input: `\
const x = { run: () => {
  doSomething()
} }`,
    output: `\
const x = {
  run: () => {
    doSomething()
  },
}`,
  },
  {
    name: "method bodies are not expanded by object layout",
    input: `\
const x = { run() {
  doSomething()
}, stop() { doSomethingElse() } }`,
    output: `\
const x = {
  run() {
    doSomething()
  },
  stop() { doSomethingElse() },
}`,
  },
  {
    name: "getter setter and async generic method",
    input: `\
const x = {get value() { return 1; },
set value(v: number) { use(v); },async run<T>(v: T) { return v; }}`,
    output: `\
const x = {
  get value() { return 1; },
  set value(v: number) { use(v); },
  async run<T>(v: T) { return v; },
}`,
  },
  {
    name: "single-line methods remain single-line",
    input: "const x = {run(){doSomething()},get value(){return 1}}",
    output: "const x = { run(){doSomething()}, get value(){return 1} }",
  },
  {
    name: "line break after the colon",
    input: `\
const x = { foo:
  someValue }`,
    output: `\
const x = {
  foo: someValue,
}`,
  },
  {
    name: "line break before the colon",
    input: `\
const x = { foo
 :someValue }`,
    output: `\
const x = {
  foo: someValue,
}`,
  },
  {
    name: "multiline call expression",
    input: `\
const x = { result: fn(
  a,
  b,
) }`,
    output: `\
const x = {
  result: fn(
    a,
    b,
  ),
}`,
  },
  {
    name: "multiline spread and shorthand",
    input: `\
const x = {foo,
...other,bar}`,
    output: `\
const x = {
  foo,
  ...other,
  bar,
}`,
  },
  {
    name: "last value parentheses are retained before the comma",
    input: `\
const x = {a: ((value))
}`,
    output: `\
const x = {
  a: ((value)),
}`,
  },
  {
    name: "last spread parentheses are retained before the comma",
    input: `\
const x = {...((other))
}`,
    output: `\
const x = {
  ...((other)),
}`,
  },
  {
    name: "satisfies and const assertion outside the object",
    input: `\
const x = {foo:1,
bar:2} as const satisfies Options;`,
    output: `\
const x = {
  foo: 1,
  bar: 2,
} as const satisfies Options;`,
  },
  {
    name: "object inside a return expression",
    input: `\
function f() {
  return {foo:1,
  bar:2};
}`,
    output: `\
function f() {
  return {
    foo: 1,
    bar: 2,
  };
}`,
  },
  {
    name: "object inside a parenthesized arrow return",
    input: `\
const f = () => ({a:1,
b:2});`,
    output: `\
const f = () => ({
  a: 1,
  b: 2,
});`,
  },
  {
    name: "automatic semicolon insertion inside a method stays intact",
    input: `\
const x = {run() {
return
value
},a:1}`,
    output: `\
const x = {
  run() {
    return
    value
  },
  a: 1,
}`,
  },
  {
    name: "template literal contents are byte-preserved",
    input: `\
const x = { prompt: \`first line
second line\` }`,
    output: `\
const x = {
  prompt: \`first line
second line\`,
}`,
  },
  {
    name: "escaped physical newline in a quoted string is preserved",
    input: `\
const x = { text: 'first\\
second',other:1 }`,
    output: `\
const x = {
  text: 'first\\
second',
  other: 1,
}`,
  },
  {
    name: "tagged template contents are byte-preserved",
    input: `\
const x = { text: String.raw\`  first, {
     second: }
\`,other:1 }`,
    output: `\
const x = {
  text: String.raw\`  first, {
     second: }
\`,
  other: 1,
}`,
  },
  {
    name: "regex and string delimiters are not object punctuation",
    input: "const x = {pattern:/[,{}:]/u,text:\"a,b:{c}\"}",
    output: "const x = { pattern: /[,{}:]/u, text: \"a,b:{c}\" }",
  },
  {
    name: "template interpolation contains an independently formatted object",
    input: "const x = {text:`before ${fn({a:1,b:2})} after`}",
    output: "const x = { text: `before ${fn({ a: 1, b: 2 })} after` }",
  },
  {
    name: "trailing line comment stays with its property",
    input: `\
const x = { foo: 1, // explanation
bar: 2 }`,
    output: `\
const x = {
  foo: 1, // explanation
  bar: 2,
}`,
  },
  {
    name: "last comma is inserted before a trailing line comment",
    input: `\
const x = {
  foo: 1 // reason
}`,
    output: `\
const x = {
  foo: 1, // reason
}`,
  },
  {
    name: "opening line comment gets its own line",
    input: `\
const x = { // configuration
foo: 1, bar: 2 }`,
    output: `\
const x = {
  // configuration
  foo: 1,
  bar: 2,
}`,
  },
  {
    name: "leading property comment stays before that property",
    input: `\
const x = { foo: 1,
// special case
bar: 2 }`,
    output: `\
const x = {
  foo: 1,
  // special case
  bar: 2,
}`,
  },
  {
    name: "inline block comment stays inline",
    input: "const x = {foo:/* cached */value,bar:2}",
    output: "const x = { foo: /* cached */ value, bar: 2 }",
  },
  {
    name: "colon-side comments retain their contents",
    input: "const x = {foo /* key */ : /* value */ value}",
    output: "const x = { foo /* key */: /* value */ value }",
  },
  {
    name: "line comments between colon and value are not joined",
    input: `\
const x = {foo: // reason
value,bar:2}`,
    output: `\
const x = {
  foo: // reason
  value,
  bar: 2,
}`,
  },
  {
    name: "block comment internal indentation is not rewritten",
    input: `\
const x = { foo: /* this value is
important */ value, bar: 2 }`,
    output: `\
const x = {
  foo: /* this value is
important */ value,
  bar: 2,
}`,
  },
  {
    name: "comma following a block comment moves before it",
    input: `\
const x = {a:1 /* note */,
b:2}`,
    output: `\
const x = {
  a: 1, /* note */
  b: 2,
}`,
  },
  {
    name: "trailing comma following a block comment moves before it",
    input: `\
const x = {
a:1 /* note */,
}`,
    output: `\
const x = {
  a: 1, /* note */
}`,
  },
  {
    name: "inline trailing comma removal retains a block comment",
    input: "const x = {a:1,/* final */}",
    output: "const x = { a: 1 /* final */ }",
  },
  {
    name: "standalone trailing comment remains standalone",
    input: `\
const x = {a:1
// final note
}`,
    output: `\
const x = {
  a: 1,
  // final note
}`,
  },
  {
    name: "same-line separator comment stays with the preceding property",
    input: `\
const x = {
a:1,/* explanation */b:2
}`,
    output: `\
const x = {
  a: 1, /* explanation */
  b: 2,
}`,
  },
  {
    name: "comment attached to parentheses stays inside the value",
    input: `\
const x = {a:(value /* internal */)
}`,
    output: `\
const x = {
  a: (value /* internal */),
}`,
  },
  {
    name: "pure annotation stays before its expression",
    input: `\
const x = {a:/*#__PURE__*/makeValue()
}`,
    output: `\
const x = {
  a: /*#__PURE__*/ makeValue(),
}`,
  },
  {
    name: "a leading comma is normalized without changing properties",
    input: `\
const x = {a:1
,b:2}`,
    output: `\
const x = {
  a: 1,
  b: 2,
}`,
  },
  {
    name: "a final comma on its own line is normalized",
    input: `\
const x = {a:1
,
}`,
    output: `\
const x = {
  a: 1,
}`,
  },
  {
    name: "empty inline object",
    input: "const x = {    }",
    output: "const x = {}",
  },
  {
    name: "empty multiline object",
    input: `\
const x = {

}`,
    output: "const x = {}",
  },
  {
    name: "comment-only inline object",
    input: "const x = {/* intentionally empty */}",
    output: "const x = { /* intentionally empty */ }",
  },
  {
    name: "comment-only multiline object",
    input: `\
const x = { // intentionally empty
}`,
    output: `\
const x = {
  // intentionally empty
}`,
  },
  {
    name: "multiline block comment-only object",
    input: `\
const x = {/* first
second */}`,
    output: `\
const x = {
  /* first
second */
}`,
  },
  {
    name: "one blank grouping line is retained",
    input: `\
const x = {
a:1,

b:2
}`,
    output: `\
const x = {
  a: 1,

  b: 2,
}`,
  },
  {
    name: "multiple blank lines collapse to one",
    input: `\
const x = {

a:1,
${'  '}


b:2

}`,
    output: `\
const x = {
  a: 1,

  b: 2,
}`,
  },
  {
    name: "blank lines around comment groups are retained",
    input: `\
const x = {
a:1,

// next group

b:2
}`,
    output: `\
const x = {
  a: 1,

  // next group

  b: 2,
}`,
  },
  {
    name: "property order and explicit key-value form are retained",
    input: `\
const x = {z:z,
a:a, __proto__:proto}`,
    output: `\
const x = {
  z: z,
  a: a,
  __proto__: proto,
}`,
  },
  {
    name: "a collapsed empty child does not collapse its parent",
    input: `\
const x = {child: {
}}`,
    output: `\
const x = {
  child: {},
}`,
  },
  {
    name: "directive-like strings are ordinary values",
    input: `\
const x = {text:"eslint-disable-next-line",
other:"@ts-expect-error"}`,
    output: `\
const x = {
  text: "eslint-disable-next-line",
  other: "@ts-expect-error",
}`,
  },
  {
    name: "BOM and absence of terminal newline are retained",
    input: "﻿const x = {a:1,b:2}",
    output: "﻿const x = { a: 1, b: 2 }",
  },
  {
    name: "hashbang is retained",
    input: `\
#!/usr/bin/env node
const x = {a:1,b:2}`,
    output: `\
#!/usr/bin/env node
const x = { a: 1, b: 2 }`,
  },
  {
    name: "nested default object is formatted but not its object pattern",
    input: "const { value = {a:1,b:2} } = source;",
    output: "const { value = { a: 1, b: 2 } } = source;",
  },
  {
    name: "inline TSX object value",
    input: "const view = <Component value={{a:1,b:2}} />;",
    output: "const view = <Component value={{ a: 1, b: 2 }} />;",
  },
  {
    name: "multiple immediately nested empty objects",
    input: "const x = {a:{},b:{},c:{}}",
    output: "const x = { a: {}, b: {}, c: {} }",
  },
  {
    name: "optional chaining non-null assertion and type assertion values",
    input: `\
const x = {a:foo?.bar!,
b:(value as Type)}`,
    output: `\
const x = {
  a: foo?.bar!,
  b: (value as Type),
}`,
  },
];

describe('object-layout', () => {
  it.each(cases)('$name', ({ input, output }) => {
    expectFixed({ input: input, output: output, settings: scriptConfig });
  });

  it('never wraps a very long one-line object or an object with many properties', () => {
    const long = 'x'.repeat(20_000);
    const input = `const x = {long:"${long}",${Array.from({ length: 160 }, (_, i) => `key${i}:${i}`).join(',')}}`;
    const output = `const x = { long: "${long}", ${Array.from({ length: 160 }, (_, i) => `key${i}: ${i}`).join(', ')} }`;
    expectFixed({ input: input, output: output, settings: scriptConfig });
    expect(output.includes('\n')).toBe(false);
  });

  it('does not wrap a long individual property inside a multiline object', () => {
    const long = 'x'.repeat(10_000);
    expectFixed({ input: `const x = {\ntext:"${long}",a:1\n}`, output: `const x = {\n  text: "${long}",\n  a: 1,\n}`, settings: scriptConfig });
  });

  it.each(['\r\n', '\r', '\u2028', '\u2029'])('preserves the local line ending %j', ending => {
    const input = 'const x = {a:1,\nb:2\n}'.replaceAll('\n', ending);
    const output = 'const x = {\n  a: 1,\n  b: 2,\n}'.replaceAll('\n', ending);
    expectFixed({ input: input, output: output, settings: scriptConfig });
  });

  it('finishes deeply nested objects within one ESLint fix invocation', () => {
    const depth = 48;
    const input = `const x = ${'{ child: '.repeat(depth)}{a:1,\nb:2}${' }'.repeat(depth)}`;
    const opening = Array.from({ length: depth }, (_, i) => `${'  '.repeat(i + 1)}child: {`).join('\n');
    const closing = Array.from({ length: depth }, (_, i) => `${'  '.repeat(depth - i)}},`).join('\n');
    const output = `const x = {\n${opening}\n${'  '.repeat(depth + 1)}a: 1,\n${'  '.repeat(depth + 1)}b: 2,\n${closing}\n}`;
    expectFixed({ input: input, output: output, settings: scriptConfig });
  });

  it('keeps the outer multiline decision when a deeply nested empty object collapses', () => {
    const depth = 32;
    const input = `const x = ${'{ child: '.repeat(depth)}{\n}${' }'.repeat(depth)}`;
    const output = `const x = {\n${Array.from({ length: depth - 1 }, (_, i) => `${'  '.repeat(i + 1)}child: {\n`).join('')}${'  '.repeat(depth)}child: {},\n${Array.from({ length: depth - 1 }, (_, i) => `${'  '.repeat(depth - i - 1)}},\n`).join('')}}`;
    expectFixed({ input: input, output: output, settings: scriptConfig });
  });

  it('leaves patterns, types, interfaces, imports, exports and blocks alone', () => {
    const code = `\
import {a,b} from 'module';
export {a,b};
const {x,y,...rest} = source;
type T = {x:number,y:string};
interface I {x:number;y:string}
function f() {if (ok) {run()}}
const values = [1,2,3];`;
    expectFixed({ input: code, output: code, settings: createConfig({ indent: false, vue: false, otherRules: {} }) });
  });

  it('has no blanket indentation fixer for nested expression bodies', () => {
    const input = 'const x = {run: () => {\n        work()\n}}';
    const output = 'const x = {\n  run: () => {\n        work()\n},\n}';
    expectFixed({ input: input, output: output, settings: createConfig({ indent: false, vue: false, otherRules: {} }) });
  });

  it('reports without changing the source in lint-only mode', () => {
    const input = 'const x = {a:1,\nb:2}';
    const messages = linter.verify(input, scriptConfig, { filename: 'fixture.ts' });
    expect(messages.some(message => message.ruleId === ruleId && message.fix !== undefined)).toBe(true);
    expect(input).toBe('const x = {a:1,\nb:2}');
    expect(rule.meta?.type).toBe('layout');
    expect(rule.meta?.fixable).toBe('code');
  });

  it.each([
    'const x = {a:1 b:2}',
    'const x = {a:',
    'const x = { ... }',
  ])('does not offer fixes for unparseable input %j', code => {
    const result = linter.verifyAndFix(code, scriptConfig, { filename: 'fixture.ts' });
    expect(result.output).toBe(code);
    expect(result.fixed).toBe(false);
    expect(result.messages.some(message => message.fatal)).toBe(true);
  });

  it.each([
    '// @ts-expect-error reason',
    '// @ts-ignore reason',
    '// eslint-disable-next-line no-undef',
    '/* istanbul ignore next */',
    '/* c8 ignore next */',
    '/* v8 ignore next */',
    '// prettier-ignore',
    '// biome-ignore lint/suspicious/noExplicitAny: reason',
  ])('reports but does not automatically move the targeted line of %s', directive => {
    const input = `${directive}\nconst x = {a:1,\nb:{c:2}};`;
    const result = linter.verifyAndFix(input, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.fixed).toBe(false);
    expect(result.messages.some(message => message.messageId === 'directive')).toBe(true);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
  });

  it.each([
    '// @ts-expect-error reason\n\n// explanatory line\n',
    '/// @ts-ignore reason\n\n',
    '/* explanation\n * @ts-expect-error reason */\n\n',
    '/* explanation\n * @ts-ignore reason */\n// context\n',
    '// prettier-ignore\n\n/* context */\n',
  ])('protects a directive across skipped lines or inside a block comment: %j', prefix => {
    const input = `${prefix}const x = {a:1,\nb:{c:2}};`;
    const result = linter.verifyAndFix(input, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.fixed).toBe(false);
    expect(result.messages.some(message => message.messageId === 'directive')).toBe(true);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
  });

  it('protects ancestors and descendants of a directive, but not unrelated objects', () => {
    const unsafe = 'const x = {a:{\n// @ts-expect-error reason\nb:1,c:{d:2}\n}};';
    const input = `${unsafe}\nconst safe = {a:1,b:2};`;
    const result = linter.verifyAndFix(input, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(result.output).toBe(`${unsafe}\nconst safe = { a: 1, b: 2 };`);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.every(message => message.messageId === 'directive' && !message.fix)).toBe(true);
    expectSameProgram({ before: input, after: result.output });
  });

  it('protects eslint-disable-line from gaining or losing properties on its line', () => {
    const input = 'const x = {a:unknown,b:other}; // eslint-disable-line no-undef';
    const result = linter.verifyAndFix(input, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.messages.some(message => message.messageId === 'directive')).toBe(true);
  });

  it('respects disabling this rule with an ESLint next-line directive', () => {
    const input = `// eslint-disable-next-line ${ruleId}\nconst x = {a:1,\nb:2};`;
    const result = linter.verifyAndFix(input, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.messages).toEqual([]);
  });

  it('converges with Naidan brace-style and indentation rules', () => {
    expectFixed({ input: 'const x = {run() { work(); },other:{a:1,b:2}};', output: 'const x = {\n  run() {\n    work();\n  },\n  other: { a: 1, b: 2 },\n};', settings: createConfig({ indent: true, vue: false, otherRules: { 'brace-style': ['warn', '1tbs', { allowSingleLine: false }], 'no-trailing-spaces': 'error' } }) });
  });

  it('converges when the existing template literal rule creates the first newline', () => {
    const input = 'const x = {text:"first\\nsecond",a:1};';
    const expected = 'const x = {\n  text: `\\\nfirst\nsecond`,\n  a: 1,\n};';
    const settings = createConfig({ indent: true, vue: false, otherRules: { 'fixture-template/template': 'error' } });
    const first = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(first.output).toBe(expected);
    expect(first.messages).toEqual([]);
    const second = linter.verifyAndFix(first.output, settings, { filename: 'fixture.ts' });
    expect(second.fixed).toBe(false);
    expect(second.messages).toEqual([]);
  });

  it('formats Vue script objects without rewriting Vue template expressions', () => {
    const template = '<template>\n  <Component :value="{foo:1,bar:2}" />\n</template>';
    const input = `<script setup lang="ts">\nconst x = {foo:{\na:1,b:2\n}};\n</script>\n${template}`;
    const expected = `<script setup lang="ts">\nconst x = {\n  foo: {\n    a: 1,\n    b: 2,\n  },\n};\n</script>\n${template}`;
    const settings = createConfig({ indent: true, vue: true, otherRules: {} });
    const first = linter.verifyAndFix(input, settings, { filename: 'fixture.vue' });
    expect(first.output).toBe(expected);
    expect(first.messages).toEqual([]);
    const second = linter.verifyAndFix(first.output, settings, { filename: 'fixture.vue' });
    expect(second.fixed).toBe(false);
    expect(second.messages).toEqual([]);
  });

  it('exports a configuration for the existing Naidan ts/vue formatting scope', () => {
    expect(ruleConfig.files).toEqual(['**/*.ts', '**/*.vue']);
    expect(ruleConfig.rules[ruleId]).toBe('error');
    expect(ruleConfig.plugins['local-rules-object-layout'].rules['object-layout']).toBe(rule);
  });

  it('is enabled in the actual Naidan configuration alongside the existing indent rule', async () => {
    const eslint = new ESLint();
    for (const filePath of ['src/utils/promise.ts', 'src/App.vue']) {
      const effective = await eslint.calculateConfigForFile(filePath);
      expect(effective.rules[ruleId]).toEqual([2]);
      expect(effective.rules.indent).toEqual([1, 2]);
      expect(effective.rules['max-len'][0]).toBe(0);
      expect(effective.rules['comma-dangle'][0]).toBe(0);
    }
  });
});

// Enumerate the interaction of comments and line breaks at all three outer
// boundaries. These are deterministic, small syntax-level cases, not a scan of
// Naidan's source tree.
const gaps = [
  { name: 'tight', text: '' },
  { name: 'spaced', text: '   ' },
  { name: 'newline', text: '\n' },
  { name: 'blank-line', text: '\n \n\n' },
  { name: 'block-comment', text: '/* preserved ,:{} */' },
  { name: 'line-comment', text: '// preserved ,:{}\n' },
];
const gapCases = gaps.flatMap(open => gaps.flatMap(middle => gaps.map(end => ({
  name: `${open.name}/${middle.name}/${end.name}`,
  open: open.text,
  middle: middle.text,
  end: end.text,
}))));

describe('object-layout boundary combinations', () => {
  it.each(gapCases)('$name preserves structure, comments, the layout choice and convergence', ({ open, middle, end }) => {
    const input = `const x = {${open}a /* key */ : /* value */ ((value)),${middle}b:{c:3,d:4}${end}};`;
    const settings = scriptConfig;
    const first = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(first.messages).toEqual([]);
    expectSameProgram({ before: input, after: first.output });
    const second = linter.verifyAndFix(first.output, settings, { filename: 'fixture.ts' });
    expect(second.messages).toEqual([]);
    expect(second.fixed).toBe(false);
    // All values and comments here begin as single-line tokens. Only the
    // authored boundary gaps can choose multiline mode in this enumeration.
    expect(first.output.includes('\n')).toBe(input.includes('\n'));
  });

  it('keeps a multiline computed key intact and spaces only its own colon', () => {
    expectFixed({ input: 'const x = {[\nkey ? a : b\n]:value,other:1}', output: 'const x = {\n  [\n  key ? a : b\n  ]: value,\n  other: 1,\n}', settings: scriptConfig });
  });

  it('indents an object value after a line comment without changing the comment', () => {
    expectFixed({ input: 'const x = {a: // reason\n{b:1,\nc:2}};', output: 'const x = {\n  a: // reason\n  {\n    b: 1,\n    c: 2,\n  },\n};', settings: scriptConfig });
  });

  it('handles comments before the colon without joining a line comment', () => {
    expectFixed({ input: 'const x = {a // explanation\n:1,b:2};', output: 'const x = {\n  a // explanation\n  : 1,\n  b: 2,\n};', settings: scriptConfig });
  });

  it('keeps empty-object comments in source order and indents their first lines only', () => {
    expectFixed({ input: 'const x = { /* first */\n/* second\nraw line */ // third\n};', output: 'const x = {\n  /* first */\n  /* second\nraw line */ // third\n};', settings: scriptConfig });
  });

  it('does not introduce a line break for escaped newlines in a string', () => {
    expectFixed({ input: 'const x = {text:"first\\nsecond"}', output: 'const x = { text: "first\\nsecond" }', settings: scriptConfig });
  });

  it('does not return overlapping fixes for nested object boundaries', () => {
    const code = 'const x = {a:{b:{c:1,\nd:2}},e:3}';
    const messages = linter.verify(code, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    const ranges = messages.flatMap(message => message.fix ? [message.fix.range] : [])
      .sort((a, b) => a[0] - b[0]);
    expect(ranges.length).toBeGreaterThan(5);
    for (let i = 1; i < ranges.length; i += 1) {
      const before = ranges[i - 1]!;
      const after = ranges[i]!;
      expect(before[1]).toBeLessThan(after[0]);
    }
  });

  it('accepts already canonical protected objects without a spurious manual-fix diagnostic', () => {
    const code = '// @ts-expect-error reason\nconst x = { a: 1 };';
    expectFixed({ input: code, output: code, settings: createConfig({ indent: false, vue: false, otherRules: {} }) });
  });

  it('continues after several separated protected ranges', () => {
    const code = '// @ts-ignore reason\nconst a = {x:1};\nconst b = {y:2};\n// @ts-expect-error reason\nconst c = {z:3};\nconst d = {w:4};';
    const output = '// @ts-ignore reason\nconst a = {x:1};\nconst b = { y: 2 };\n// @ts-expect-error reason\nconst c = {z:3};\nconst d = { w: 4 };';
    const result = linter.verifyAndFix(code, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(result.output).toBe(output);
    expect(result.messages).toHaveLength(2);
    expect(result.messages.every(message => message.messageId === 'directive')).toBe(true);
    expectSameProgram({ before: code, after: output });
  });
});

describe('object-layout and the module TEST_ONLY policy', () => {
  const settings = createConfig({
    indent: true,
    vue: false,
    otherRules: { 'fixture-module-test-only/module': 'error' },
  });

  it.each(['{}', '{\n}', '{  }'])('converges on an empty TEST_ONLY initialized as %j', literal => {
    expectFixed({
      input: `export const TEST_ONLY = ${literal};`,
      output: 'export const TEST_ONLY = {\n};',
      settings,
    });
  });

  it('expands a comment-only TEST_ONLY without dropping its comment', () => {
    expectFixed({
      input: 'export const TEST_ONLY = {/* reason */};',
      output: 'export const TEST_ONLY = {\n  /* reason */\n};',
      settings,
    });
  });

  it('still enforces the existing multiline policy for non-empty TEST_ONLY exports', () => {
    expectFixed({
      input: `\
const value = 1;
export const TEST_ONLY = {value};`,
      output: `\
const value = 1;
export const TEST_ONLY = {
  value,
};`,
      settings,
    });
  });

  it('converges after the module rule inserts a missing TEST_ONLY export', () => {
    const input = 'export const value = {a:1};';
    const output = `\
export const value = { a: 1 };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
`;
    const first = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(first.messages).toEqual([]);
    expect(first.output).toBe(output);
    const again = linter.verifyAndFix(first.output, settings, { filename: 'fixture.ts' });
    expect(again.messages).toEqual([]);
    expect(again.fixed).toBe(false);
  });
});

describe('object-layout TEST_ONLY exception boundaries', () => {
  const settings = createConfig({ indent: true, vue: false, otherRules: { 'fixture-module-test-only/module': 'error' } });

  it('keeps an already vertical empty export completely unchanged', () => {
    const code = 'export const TEST_ONLY = {\n};';
    expect(linter.verify(code, settings, { filename: 'fixture.ts' })).toEqual([]);
    expectFixed({ input: code, output: code, settings });
  });

  it('does not depend on the order of the two rules', () => {
    expectFixed({
      input: 'export const TEST_ONLY = {};',
      output: 'export const TEST_ONLY = {\n};',
      settings: { ...settings, rules: { 'fixture-module-test-only/module': 'error', [ruleId]: 'error', indent: ['error', 2] } },
    });
  });

  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('keeps the authored ending for a vertical export: %j', ending => {
    expectFixed({ input: `export const TEST_ONLY = {${ending}${ending}   };`, output: `export const TEST_ONLY = {${ending}};`, settings: scriptConfig });
  });

  it('keeps normal one-line children and collapses normal empty children inside TEST_ONLY', () => {
    expectFixed({
      input: 'export const TEST_ONLY = {one:{a:1,b:2},empty:{\n}};',
      output: 'export const TEST_ONLY = {\n  one: { a: 1, b: 2 },\n  empty: {},\n};',
      settings,
    });
  });

  it('recognizes a type annotation on the exported binding', () => {
    expectFixed({ input: 'export const TEST_ONLY: Record<string, unknown> = {};', output: 'export const TEST_ONLY: Record<string, unknown> = {\n};', settings });
  });

  it('keeps comments in an empty TEST_ONLY export', () => {
    const code = 'export const TEST_ONLY = {\n  // Add test-only entries here.\n};';
    expectFixed({ input: code, output: code, settings });
  });

  it('uses an accurate exception-specific diagnostic', () => {
    const messages = linter.verify('export const TEST_ONLY = {};', createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(messages.map(message => message.messageId)).toEqual(['testOnlyLayout']);
  });

  it.each([
    ['const TEST_ONLY = {\n};', 'const TEST_ONLY = {};'],
    ['function f() {const TEST_ONLY = {\n};}', 'function f() {const TEST_ONLY = {};}'],
    ['const x = {TEST_ONLY:{\n}};', 'const x = {\n  TEST_ONLY: {},\n};'],
    ['export const other = {\n};', 'export const other = {};'],
    ['export let TEST_ONLY = {\n};', 'export let TEST_ONLY = {};'],
    ['export const TEST_ONLY = {\n}, other = 1;', 'export const TEST_ONLY = {}, other = 1;'],
    ['export const TEST_ONLY = {\n} as const;', 'export const TEST_ONLY = {} as const;'],
    ['export const TEST_ONLY = {\n} satisfies object;', 'export const TEST_ONLY = {} satisfies object;'],
    ['namespace X { export const TEST_ONLY = {\n}; }', 'namespace X { export const TEST_ONLY = {}; }'],
    ['const TEST_ONLY = {\n}; export {TEST_ONLY};', 'const TEST_ONLY = {}; export {TEST_ONLY};'],
  ])('does not extend the exception to an unrelated or nonstandard declaration: %j', (input, output) => {
    expectFixed({ input, output, settings: scriptConfig });
  });

  it('does not override a line-sensitive directive on the special export', () => {
    const input = '// @ts-expect-error intentional fixture\nexport const TEST_ONLY = {a:1,\nb:2};';
    const result = linter.verifyAndFix(input, createConfig({ indent: false, vue: false, otherRules: {} }), { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.messages.map(message => message.messageId)).toEqual(['directive']);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
  });
});

describe('object-layout documentation attachment safety', () => {
  const settings = createConfig({ indent: false, vue: false, otherRules: {} });

  it.each([
    'const x = {/** @deprecated old */ a:1,\nb:2};',
    'const x = {a:1\n/** @internal */,b:2};',
    'const x = {a:1 /** @deprecated old */, b:2};',
    'const x = {\n/** @deprecated old */ a:1,\nb:2};',
    'const x = { /* ordinary */ /** @deprecated old */ a:1,\nb:2};',
    'const x = {a:1, /* first\nraw */ /** @deprecated old */ b:2};',
    'const x = {a:1, /** @deprecated final */};',
    'const x = {/** documentation only */\n};',
    'const x = {a:1,\n/** @internal\n * details */ b:2};',
  ])('refuses to relocate documentation trivia: %j', input => {
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.fixed).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('commentAttachment');
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
    expectSameProgram({ before: input, after: result.output });
  });

  it('still fixes whitespace beside a documentation comment when its attachment is unchanged', () => {
    expectFixed({
      input: 'const x = {\n/** @deprecated old */\na :1,\n\n\n/** @internal */\nb:2,\n};',
      output: 'const x = {\n  /** @deprecated old */\n  a: 1,\n\n  /** @internal */\n  b: 2,\n};',
      settings: scriptConfig,
    });
  });

  it('does not block an already canonical documented object', () => {
    const input = 'const x = {\n  /** Documentation. */\n  value: 1,\n};';
    expectFixed({ input, output: input, settings: scriptConfig });
  });

  it('fixes unrelated objects while leaving a documentation-sensitive object intact', () => {
    const unsafe = 'const x = {/** @deprecated old */ a:1,\nb:{c:2}};';
    const input = `${unsafe}\nconst y = {value:1};`;
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(`${unsafe}\nconst y = { value: 1 };`);
    expect(result.messages.every(message => message.messageId === 'commentAttachment' && message.fix === undefined)).toBe(true);
    expectSameProgram({ before: input, after: result.output });
  });

  it('preserves a documentation comment attached to an arrow value', () => {
    expectFixed({ input: 'const x = {a: /** @param value Example. */ ((value:number) => value),\nb:2};', output: 'const x = {\n  a: /** @param value Example. */ ((value:number) => value),\n  b: 2,\n};', settings: scriptConfig });
  });
});

describe('object-layout counted coverage directives', () => {
  const settings = createConfig({ indent: false, vue: false, otherRules: {} });

  it.each(['c8', 'v8'])('protects the whole counted %s range, not only its first token', tool => {
    const protectedCode = `/* ${tool} ignore next 3 */\nconst first = 1;\nconst second = {a:1,\nb:2};`;
    const input = `${protectedCode}\nconst safe = {a:1,b:2};`;
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(`${protectedCode}\nconst safe = { a: 1, b: 2 };`);
    expect(result.messages.map(message => message.messageId)).toEqual(['directive']);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
    expectSameProgram({ before: input, after: result.output });
  });

  it('conservatively bounds an excessively large count to the available source', () => {
    const input = `/* c8 ignore next ${'9'.repeat(400)} */\nconst first = 1;\nconst second = {a:1,\nb:2};`;
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.messages.map(message => message.messageId)).toEqual(['directive']);
  });
});

describe('object-layout and TEST_ONLY share directive protection', () => {
  const settings = createConfig({ indent: true, vue: false, otherRules: { 'fixture-module-test-only/module': 'error' } });

  it.each([
    '// @ts-expect-error missing fixture reference\n',
    '// @ts-ignore missing fixture reference\n\n// additional context\n',
    '/* c8 ignore next 3 */\nconst first = 1;\n',
    '// eslint-disable-next-line no-undef\n',
  ])('neither rule rewrites the line protected by %j', prefix => {
    const input = `${prefix}export const TEST_ONLY = {value: missing};`;
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.fixed).toBe(false);
    expect(result.messages.some(message => message.messageId === 'directive')).toBe(true);
    expect(result.messages.some(message => message.messageId === 'singleLine')).toBe(true);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
  });
});

describe('object-layout active diagnostic suppression', () => {
  it('preserves an active eslint no-undef suppression with both formatting rules enabled', () => {
    const settings = createConfig({ indent: true, vue: false, otherRules: { 'fixture-module-test-only/module': 'error', 'no-undef': 'error' } });
    const input = '// eslint-disable-next-line no-undef\nexport const TEST_ONLY = {value: missing};';
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.fixed).toBe(false);
    expect(result.messages.every(message => message.ruleId !== 'no-undef' && message.fix === undefined)).toBe(true);
  });
});

describe('object-layout existing TEST_ONLY insertion integrations', () => {
  it('converges after a composable return gets its guarded TEST_ONLY spread', () => {
    const settings = createConfig({ indent: true, vue: false, otherRules: { 'fixture-composable/composable': 'error', 'fixture-guard/guard': 'error' } });
    const input = 'function useExample() {\n  return {value:1};\n}';
    const first = linter.verifyAndFix(input, settings, { filename: 'src/useExample.ts' });
    expect(first.messages).toEqual([]);
    expect(first.output).toContain('    value: 1,');
    expect(first.output).toContain('...((__BUILD_MODE_IS_TEST__ && {');
    expect(first.output).toContain('TEST_ONLY: {\n');
    expect(first.output).toContain('// ESLint-required for useXxx return objects.');
    const again = linter.verifyAndFix(first.output, settings, { filename: 'src/useExample.ts' });
    expect(again.fixed).toBe(false);
    expect(again.messages).toEqual([]);
  });

  it('converges after defineExpose gets its guarded TEST_ONLY spread without touching the template', () => {
    const settings = createConfig({ indent: true, vue: true, otherRules: { 'fixture-expose/expose': 'error', 'fixture-guard/guard': 'error' } });
    const template = '<template><Example :value="{foo:1,bar:2}" /></template>';
    const input = `<script setup lang="ts">\ndefineExpose({value:1});\n</script>\n${template}`;
    const first = linter.verifyAndFix(input, settings, { filename: 'src/Example.vue' });
    expect(first.messages).toEqual([]);
    expect(first.output).toContain('  value: 1,');
    expect(first.output).toContain('...((__BUILD_MODE_IS_TEST__ && {');
    expect(first.output).toContain('TEST_ONLY: {\n');
    expect(first.output).toContain('// ESLint-required for defineExpose.');
    expect(first.output.endsWith(template)).toBe(true);
    const again = linter.verifyAndFix(first.output, settings, { filename: 'src/Example.vue' });
    expect(again.fixed).toBe(false);
    expect(again.messages).toEqual([]);
  });
});

// Exercise the compiler, not a reimplementation of its directive regex. A
// formatter can leave ESTree unchanged while moving a suppressed type error.
function semanticDiagnosticCodes({ code }: { code: string }): number[] {
  const filename = 'directive-fixture.ts';
  const options: ts.CompilerOptions = { strict: true, noEmit: true, noLib: true };
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    fileExists: path => path === filename,
    readFile: path => path === filename ? code : undefined,
    getSourceFile: path => path === filename ? source : undefined,
    getCurrentDirectory: () => '',
    getCanonicalFileName: path => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    getDefaultLibFileName: () => '',
    writeFile: () => {},
  };
  return ts.createProgram([filename], options, host).getSemanticDiagnostics().map(diagnostic => diagnostic.code);
}

describe('object-layout preserves compiler-recognized directive prefixes', () => {
  const prefixCases = ['expect-error', 'ignore'].flatMap(directive => (
    ['TS2304', '_reason', '123'].flatMap(suffix => (
      [
        `// @ts-${directive}${suffix}`,
        `/// @ts-${directive}${suffix}`,
        `/* @ts-${directive}${suffix} */`,
        `/* context\n * @ts-${directive}${suffix} */`,
      ].map(comment => ({ comment }))
    ))
  ));

  it.each(prefixCases)('preserves suppressed diagnostics for $comment', ({ comment }) => {
    const input = `${comment}\nconst x = {value: missing,\nother: 2};`;
    expect(semanticDiagnosticCodes({ code: input })).toEqual([]);
    // Check the protected object itself. An unrelated object still formats.
    const code = `${input}\nconst safe = {a:1,b:2};`;
    const settings = createConfig({ indent: false, vue: false, otherRules: {} });
    const first = linter.verifyAndFix(code, settings, { filename: 'fixture.ts' });
    expect(first.output).toBe(`${input}\nconst safe = { a: 1, b: 2 };`);
    expect(semanticDiagnosticCodes({ code: first.output })).toEqual([]);
    expect(first.messages.every(message => message.messageId === 'directive' && message.fix === undefined)).toBe(true);
    expectSameProgram({ before: code, after: first.output });
    expect(linter.verifyAndFix(first.output, settings, { filename: 'fixture.ts' }).fixed).toBe(false);
  });

  it.each(['expect-error', 'ignore'])('protects %s prefixes through both TEST_ONLY rules', directive => {
    const input = `// @ts-${directive}TS2304\nexport const TEST_ONLY = {value: missing};`;
    const settings = createConfig({ indent: true, vue: false, otherRules: { 'fixture-module-test-only/module': 'error' } });
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(semanticDiagnosticCodes({ code: input })).toEqual([]);
    expect(result.output).toBe(input);
    expect(result.fixed).toBe(false);
    expect(semanticDiagnosticCodes({ code: result.output })).toEqual([]);
    expect(result.messages.some(message => message.messageId === 'directive')).toBe(true);
    expect(result.messages.some(message => message.messageId === 'singleLine')).toBe(true);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
  });
});

describe('object-layout Node.js coverage directives', () => {
  it('preserves every line of a counted range, including objects below its first line', () => {
    const protectedCode = '/* node:coverage ignore next 3 */\nconst first = 1;\nconst value = false ? {a:1,\nb:2} : null;';
    const input = `${protectedCode}\nconst safe = {a:1,b:2};`;
    const settings = createConfig({ indent: false, vue: false, otherRules: {} });
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(`${protectedCode}\nconst safe = { a: 1, b: 2 };`);
    expect(result.messages.map(message => message.messageId)).toEqual(['directive']);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
    expectSameProgram({ before: input, after: result.output });
    expect(linter.verifyAndFix(result.output, settings, { filename: 'fixture.ts' }).fixed).toBe(false);
  });

  it.each(['', ' 2'])('does not bypass Node.js coverage protection through the TEST_ONLY rule (count %j)', count => {
    const input = `/* node:coverage ignore next${count} */\nexport const TEST_ONLY = {a:1,b:2};`;
    const settings = createConfig({ indent: true, vue: false, otherRules: { 'fixture-module-test-only/module': 'error' } });
    const result = linter.verifyAndFix(input, settings, { filename: 'fixture.ts' });
    expect(result.output).toBe(input);
    expect(result.fixed).toBe(false);
    expect(result.messages.some(message => message.messageId === 'directive')).toBe(true);
    expect(result.messages.some(message => message.messageId === 'singleLine')).toBe(true);
    expect(result.messages.every(message => message.fix === undefined)).toBe(true);
  });
});

describe('object-layout independently applicable boundary fixes', () => {
  it.each([
    'const x = {a:\n1};',
    'const x = {a:{\n}};',
    'const x = {a:1, // trailing\nb:2};',
    'const x = {a:1 // trailing\n};',
    'const x = {a/* note */: /* other */1,\nb:2};',
    'const x = {a:1\n, /* note */b:2};',
    'const x = {[(a?b:c)]:((1)),\n...((v))};',
  ])('preserves the program for every subset of its boundary fixes: %j', input => {
    const settings = createConfig({ indent: false, vue: false, otherRules: {} });
    const fixes = linter.verify(input, settings, { filename: 'fixture.ts' })
      .flatMap(message => message.ruleId === ruleId && message.fix ? [message.fix] : [])
      .sort((left, right) => left.range[0] - right.range[0]);
    expect(fixes.length).toBeGreaterThan(0);
    // Keep this exhaustive check small even if a future implementation changes
    // its report granularity. These seven fixtures currently yield 120 subsets.
    expect(fixes.length).toBeLessThanOrEqual(8);
    for (let mask = 0; mask < 2 ** fixes.length; mask += 1) {
      let output = input;
      for (let index = fixes.length - 1; index >= 0; index -= 1) {
        if ((mask & (1 << index)) === 0) {
          continue;
        }
        const fix = fixes[index]!;
        output = output.slice(0, fix.range[0]) + fix.text + output.slice(fix.range[1]);
      }
      expectSameProgram({ before: input, after: output });
      // Subsets may choose a different layout when they remove the only
      // authored newline, but they must still parse and reach a fixed point.
      const first = linter.verifyAndFix(output, settings, { filename: 'fixture.ts' });
      expect(first.messages).toEqual([]);
      expectSameProgram({ before: input, after: first.output });
      expect(linter.verifyAndFix(first.output, settings, { filename: 'fixture.ts' }).fixed).toBe(false);
    }
  });
});
