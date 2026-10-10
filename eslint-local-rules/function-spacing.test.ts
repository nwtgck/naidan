// @vitest-environment node
import { ESLint, Linter } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import config, { rule } from './function-spacing.js';
import objectConfig from './object-layout.js';
import testConfig from './test-structure-spacing.js';

const ruleId = 'local-rules-function-spacing/function-spacing';
const linter = new Linter();
const repoRoot = path.resolve(import.meta.dirname, '..');

function settings({ vue = false, extra = {} }: {
  vue?: boolean;
  extra?: Linter.RulesRecord;
} = {}): Linter.Config[] {
  return [
    config as Linter.Config,
    {
      files: config.files,
      languageOptions: {
        parser: vue ? vueParser : parser,
        parserOptions: {
          ...(vue ? { parser } : {}),
          sourceType: 'module',
          ecmaVersion: 'latest',
        },
      },
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      rules: extra,
    },
  ];
}

function withoutPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPositions);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['loc', 'range', 'parent', 'tokens', 'comments'].includes(key))
      .map(([key, entry]) => [key, withoutPositions(entry)]));
  }
  return value;
}

function documentationBindings({ code, jsx }: { code: string; jsx: boolean }) {
  const source = ts.createSourceFile('fixture.ts', code, ts.ScriptTarget.Latest, true, jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings: { kind: ts.SyntaxKind; comments: string[] }[] = [];
  function visit(node: ts.Node) {
    bindings.push({ kind: node.kind, comments: ts.getJSDocCommentsAndTags(node).map(comment => comment.getText(source)) });
    ts.forEachChild(node, visit);
  }
  visit(source);
  return bindings;
}

function expectSameProgram({ before, after, jsx = false }: { before: string; after: string; jsx?: boolean }) {
  const options = { range: true, loc: true, tokens: true, comment: true, jsx };
  const first = parser.parse(before, options);
  const second = parser.parse(after, options);
  expect(withoutPositions(second)).toEqual(withoutPositions(first));
  expect(second.tokens?.map(token => [token.type, token.value])).toEqual(first.tokens?.map(token => [token.type, token.value]));
  expect(second.comments?.map(comment => after.slice(...comment.range))).toEqual(first.comments?.map(comment => before.slice(...comment.range)));
  expect(documentationBindings({ code: after, jsx })).toEqual(documentationBindings({ code: before, jsx }));
}

function expectFixed({ input, output, filename = 'fixture.ts', configs = settings() }: {
  input: string;
  output: string;
  filename?: string;
  configs?: Linter.Config[];
}) {
  const messages = linter.verify(input, configs, { filename });
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.every(message => message.ruleId === ruleId && message.messageId === 'spacing')).toBe(true);
  for (const message of messages) {
    // Every fix inserts just one complete line ending at an existing boundary.
    expect(message.fix?.range[0]).toBe(message.fix?.range[1]);
    expect(message.fix?.text).toMatch(/^(?:\r\n|[\n\r\u2028\u2029])$/u);
  }
  const fixed = linter.verifyAndFix(input, configs, { filename });
  expect(fixed.messages).toEqual([]);
  expect(fixed.fixed).toBe(true);
  expect(fixed.output).toBe(output);
  expectSameProgram({ before: input, after: output, jsx: filename.endsWith('x') });
  const again = linter.verifyAndFix(fixed.output, configs, { filename });
  expect(again).toEqual({ fixed: false, output, messages: [] });
}

const fixedCases = [
  {
    name: 'adjacent top-level function declarations and their ordinary neighbors',
    input: 'const before = 1;\nfunction start() {}\nfunction stop() {}\nconst after = 2;',
    output: 'const before = 1;\n\nfunction start() {}\n\nfunction stop() {}\n\nconst after = 2;',
  },
  {
    name: 'named exports and asynchronous generators',
    input: 'const before = 1;\nexport async function* start() { yield 1; }\nexport function stop() {}\nexport const after = 2;',
    output: 'const before = 1;\n\nexport async function* start() { yield 1; }\n\nexport function stop() {}\n\nexport const after = 2;',
  },
  {
    name: 'an anonymous default export',
    input: 'const before = 1;\nexport default function () {}\nconst after = 2;',
    output: 'const before = 1;\n\nexport default function () {}\n\nconst after = 2;',
  },
  {
    name: 'a named default export',
    input: 'const before = 1;\nexport default async function main() {}\nconst after = 2;',
    output: 'const before = 1;\n\nexport default async function main() {}\n\nconst after = 2;',
  },
  {
    name: 'a default arrow function export',
    input: 'const before = 1;\nexport default async () => 1;\nconst after = 2;',
    output: 'const before = 1;\n\nexport default async () => 1;\n\nconst after = 2;',
  },
  {
    name: 'a default function value wrapped in a type assertion',
    input: 'const before = 1;\nexport default (function () {} as Callable);\nconst after = 2;',
    output: 'const before = 1;\n\nexport default (function () {} as Callable);\n\nconst after = 2;',
  },
  {
    name: 'function expressions and arrows assigned directly to variables',
    input: "const count = 1;\nconst name = 'test';\nconst start = function () {};\nlet stop = () => {};\nvar reset = async () => {};\nconst enabled = true;",
    output: "const count = 1;\nconst name = 'test';\n\nconst start = function () {};\n\nlet stop = () => {};\n\nvar reset = async () => {};\n\nconst enabled = true;",
  },
  {
    name: 'exported function-valued bindings',
    input: 'export const before = 1;\nexport const run = () => 1;\nexport const after = 2;',
    output: 'export const before = 1;\n\nexport const run = () => 1;\n\nexport const after = 2;',
  },
  {
    name: 'parentheses and TypeScript expression wrappers',
    input: 'const a = 1;\nconst b = ((() => 1) as Callable)! satisfies Callable;\nconst c = 2;',
    output: 'const a = 1;\n\nconst b = ((() => 1) as Callable)! satisfies Callable;\n\nconst c = 2;',
  },
  {
    name: 'an angle-bracket type assertion',
    input: 'const a = 1;\nconst b = <Callable>(() => 1);\nconst c = 2;',
    output: 'const a = 1;\n\nconst b = <Callable>(() => 1);\n\nconst c = 2;',
  },
  {
    name: 'an import immediately before a function',
    input: "import value from 'example';\nfunction main() {}",
    output: "import value from 'example';\n\nfunction main() {}",
  },
  {
    name: 'an export list immediately after a function',
    input: 'function main() {}\nexport { main };',
    output: 'function main() {}\n\nexport { main };',
  },
  {
    name: 'a class and an interface next to function implementations',
    input: 'class Example {}\nfunction main() {}\ninterface Contract { first(): void; second(): void; }',
    output: 'class Example {}\n\nfunction main() {}\n\ninterface Contract { first(): void; second(): void; }',
  },
  {
    name: 'a directive prologue before an implementation',
    input: "'use strict';\nfunction main() {}",
    output: "'use strict';\n\nfunction main() {}",
  },
  {
    name: 'existing extra blank lines remain intact',
    input: 'const before = 1;\n\n\nfunction main() {}\nconst after = 2;',
    output: 'const before = 1;\n\n\nfunction main() {}\n\nconst after = 2;',
  },
  {
    name: 'semicolon-less declarations',
    input: 'const before = 1\nconst run = () => {}\nconst after = 2',
    output: 'const before = 1\n\nconst run = () => {}\n\nconst after = 2',
  },
  {
    name: 'empty statement semicolons remain with the preceding declaration',
    input: 'const before = 1;\nfunction run() {};;\nconst after = 2;',
    output: 'const before = 1;\n\nfunction run() {};;\n\nconst after = 2;',
  },
  {
    name: 'class methods but not consecutive fields',
    input: "class Service {\n  timeout = 1000;\n  name = 'example';\n  start() {}\n  stop() {}\n  enabled = true;\n}",
    output: "class Service {\n  timeout = 1000;\n  name = 'example';\n\n  start() {}\n\n  stop() {}\n\n  enabled = true;\n}",
  },
  {
    name: 'class function-valued fields only at a method boundary',
    input: 'class Service {\n  start = () => {};\n  stop = function () {};\n  reset() {}\n  enabled = true;\n}',
    output: 'class Service {\n  start = () => {};\n  stop = function () {};\n\n  reset() {}\n\n  enabled = true;\n}',
  },
  {
    name: 'a constructor and parameter properties',
    input: 'class Service {\n  enabled = true;\n  constructor(public readonly name: string) {}\n  start() {}\n}',
    output: 'class Service {\n  enabled = true;\n\n  constructor(public readonly name: string) {}\n\n  start() {}\n}',
  },
  {
    name: 'asynchronous, generator, private and static methods',
    input: 'class Service {\n  async start() {}\n  *values() { yield 1; }\n  #stop() {}\n  static reset() {}\n}',
    output: 'class Service {\n  async start() {}\n\n  *values() { yield 1; }\n\n  #stop() {}\n\n  static reset() {}\n}',
  },
  {
    name: 'class expressions inside local functions',
    input: 'function factory() {\n  const value = class {\n    start() {}\n    stop() {}\n  };\n  return value;\n}',
    output: 'function factory() {\n  const value = class {\n    start() {}\n\n    stop() {}\n  };\n  return value;\n}',
  },
  {
    name: 'class expressions stored in objects do not space the object properties',
    input: 'const value = {\n  name: "x",\n  Class: class {\n    start() {}\n    stop() {}\n  },\n  enabled: true,\n};',
    output: 'const value = {\n  name: "x",\n  Class: class {\n    start() {}\n\n    stop() {}\n  },\n  enabled: true,\n};',
  },
  {
    name: 'abstract signatures only when adjacent to an implemented method',
    input: 'abstract class Service {\n  abstract first(): void;\n  abstract second(): void;\n  run() {}\n  abstract third(): void;\n}',
    output: 'abstract class Service {\n  abstract first(): void;\n  abstract second(): void;\n\n  run() {}\n\n  abstract third(): void;\n}',
  },
  {
    name: 'static blocks are not themselves methods',
    input: 'class Service {\n  static { initialize(); }\n  value = 1;\n  run() {}\n  static { finish(); }\n}',
    output: 'class Service {\n  static { initialize(); }\n  value = 1;\n\n  run() {}\n\n  static { finish(); }\n}',
  },
  {
    name: 'decorators stay with a method',
    input: 'class Service {\n  enabled = true;\n  /** Run the service. */\n  @memoize\n  @trace("run")\n  run() {}\n  stop() {}\n}',
    output: 'class Service {\n  enabled = true;\n\n  /** Run the service. */\n  @memoize\n  @trace("run")\n  run() {}\n\n  stop() {}\n}',
  },
  {
    name: 'an extra class semicolon stays with the previous method',
    input: 'class Service {\n  run() {};\n  stop() {}\n}',
    output: 'class Service {\n  run() {};\n\n  stop() {}\n}',
  },
  {
    name: 'a leading JSDoc comment remains attached to the next declaration',
    input: 'const value = 1;\n/** @deprecated Use another entry. */\nexport function run() {}\nconst after = 2;',
    output: 'const value = 1;\n\n/** @deprecated Use another entry. */\nexport function run() {}\n\nconst after = 2;',
  },
  {
    name: 'same-line notes stay attached to the preceding definition',
    input: 'function run() {} // previous note\n// next note\nconst after = 2;',
    output: 'function run() {} // previous note\n\n// next note\nconst after = 2;',
  },
  {
    name: 'leading comment groups are not broken up',
    input: 'const before = 1;\n// first\n/* second */\n/** third */\nfunction run() {}',
    output: 'const before = 1;\n\n// first\n/* second */\n/** third */\nfunction run() {}',
  },
  {
    name: 'multiline trailing notes stay with the preceding definition',
    input: 'function run() {} /* note\n  second line */\nconst after = 2;',
    output: 'function run() {} /* note\n  second line */\n\nconst after = 2;',
  },
  {
    name: 'blank lines inside a comment do not count as boundary separation',
    input: 'const before = 1;\n/* note\n\nsecond line */\nfunction run() {}',
    output: 'const before = 1;\n\n/* note\n\nsecond line */\nfunction run() {}',
  },
  {
    name: 'pure annotations remain together with the next declaration',
    input: 'const before = 1;\n/* @__NO_SIDE_EFFECTS__ */\nfunction run() {}',
    output: 'const before = 1;\n\n/* @__NO_SIDE_EFFECTS__ */\nfunction run() {}',
  },
  {
    name: 'tabs are preserved',
    input: 'class C {\n\tfirst() {}\n\tsecond() {}\n}',
    output: 'class C {\n\tfirst() {}\n\n\tsecond() {}\n}',
  },
  {
    name: 'a leading byte-order mark is preserved',
    input: '\uFEFFconst before = 1;\nfunction run() {}',
    output: '\uFEFFconst before = 1;\n\nfunction run() {}',
  },
  {
    name: 'a hashbang and internal template literal whitespace are preserved',
    input: '#!/usr/bin/env node\nconst before = 1;\nfunction run() { return `first\n\n    last`; }',
    output: '#!/usr/bin/env node\nconst before = 1;\n\nfunction run() { return `first\n\n    last`; }',
  },
];

const unchangedCases = [
  {
    name: 'the user-provided object literal',
    code: `const service = {
  timeout: 1000,
  name: 'example',
  start() {},
  stop: function () {},
  reset: () => {},
  enabled: true,
};`,
  },
  { name: 'multiline object implementations', code: 'const service = {\n  run() {\n    work();\n  },\n  stop() {\n    work();\n  },\n};' },
  { name: 'interface methods, properties and call signatures', code: 'interface Service {\n  name: string;\n  start(): void;\n  stop: () => void;\n  (): void;\n  new(): Service;\n}' },
  { name: 'type literal methods', code: 'type Service = {\n  start(): void;\n  stop: () => void;\n};' },
  { name: 'ambient top-level signatures', code: 'declare function first(): void;\ndeclare function second(): void;' },
  { name: 'declare class signatures', code: 'declare class Service {\n  start(): void;\n  stop(): void;\n}' },
  { name: 'abstract methods without an implementation neighbor', code: 'abstract class Service {\n  abstract start(): void;\n  abstract stop(): void;\n  value = 1;\n}' },
  { name: 'top-level signatures without an implementation', code: 'function first(x: string): void;\nfunction first(x: number): void;' },
  { name: 'local function declarations and values', code: 'function main() {\n  const value = 1;\n  function helper() {}\n  const callback = () => {};\n  use(callback);\n}' },
  { name: 'block-local function declarations', code: '{\n  const value = 1;\n  function helper() {}\n  use(helper);\n}' },
  { name: 'namespace-local functions', code: 'namespace Local {\n  export function start() {}\n  export function stop() {}\n}' },
  { name: 'test callbacks and their local helpers', code: "describe('suite', () => {\n  const value = 1;\n  function helper() {}\n  it('case', () => {});\n});" },
  { name: 'callbacks inside variable initializers', code: 'const values = items.map(function (item) { return item.value; });\nconst results = items.filter(item => item.enabled);\nconst count = results.length;' },
  { name: 'standalone calls and callbacks', code: 'promise.then(function (result) { use(result); });\nrun(() => {});' },
  { name: 'function references and factories', code: 'const start = service.start;\nconst stop = createStop();\nconst reset = wrap(() => {});\nconst value = 1;' },
  { name: 'conditional function values', code: 'const start = enabled ? () => {} : undefined;\nconst value = 1;' },
  { name: 'multiple bindings in one declaration', code: 'const start = () => {}, enabled = true;\nconst value = 1;' },
  { name: 'destructuring is not a standalone function binding', code: 'const { name } = function example() {};\nconst value = 1;' },
  { name: 'assignment expressions', code: 'start = function () {};\nstop = () => {};' },
  { name: 'default-exported references', code: 'const value = 1;\nexport default value;' },
  { name: 'field-only classes', code: 'class Service {\n  count = 1;\n  start = () => {};\n  stop = function () {};\n  reset = () => {};\n}' },
  { name: 'an accessor field', code: 'class Service {\n  accessor count = 1;\n  enabled = true;\n}' },
  { name: 'a single method does not pad class braces', code: 'class Service {\n  start() {}\n}' },
  { name: 'a single function does not pad file edges', code: 'function start() {}' },
  { name: 'existing outer padding is not removed', code: '\n\nfunction start() {}\n\n' },
  { name: 'existing class padding is not removed', code: 'class Service {\n\n  start() {}\n\n}' },
  { name: 'extra existing separation is retained', code: 'function start() {}\n\n\n\nfunction stop() {}' },
  { name: 'comment groups already separated before them', code: 'function start() {}\n\n// note\nconst value = 1;' },
  { name: 'comment groups already separated after them', code: 'function start() {}\n// note\n\nconst value = 1;' },
  { name: 'comments attached inline to a single method', code: 'class Service { start() {} /* note */ }' },
  { name: 'empty class and file', code: 'class Service {}' },
  { name: 'empty source', code: '' },
];

describe('function-spacing', () => {
  it.each(fixedCases)('fixes $name', ({ input, output }) => {
    expectFixed({ input, output });
  });

  it.each(unchangedCases)('preserves $name', ({ code }) => {
    expect(linter.verifyAndFix(code, settings(), { filename: 'fixture.test.ts' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('reports a single diagnostic per boundary, even between two targets', () => {
    const messages = linter.verify('function a() {}\nfunction b() {}', settings(), { filename: 'fixture.ts' });
    expect(messages).toMatchObject([{ ruleId, messageId: 'spacing', line: 2, column: 1 }]);
  });

  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('preserves line ending %j', ending => {
    expectFixed({ input: `const before = 1;${ending}function run() {}`, output: `const before = 1;${ending}${ending}function run() {}` });
  });

  it('uses the local ending in a mixed-ending file', () => {
    expectFixed({ input: 'const a = 1;\r\nconst b = 2;\nfunction run() {}\rconst c = 3;', output: 'const a = 1;\r\nconst b = 2;\n\nfunction run() {}\r\rconst c = 3;' });
  });

  it('keeps whitespace-only existing blank lines', () => {
    const code = 'function a() {}\n  \nfunction b() {}';
    expect(linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('does not touch return statements, regular expressions or template text', () => {
    expectFixed({
      input: 'function run() {\n  return\n  /expression/;\n}\nconst render = () => `\n\n  text\n`;\nconst after = 1;',
      output: 'function run() {\n  return\n  /expression/;\n}\n\nconst render = () => `\n\n  text\n`;\n\nconst after = 1;',
    });
  });
});

const accessorKeys = [
  { name: 'ordinary', getter: 'value', setter: 'value' },
  { name: 'private', getter: '#value', setter: '#value' },
  { name: 'quoted', getter: '"value"', setter: "'value'" },
  { name: 'literal computed', getter: '["value"]', setter: 'value' },
  { name: 'numeric', getter: '1', setter: '[1]' },
  { name: 'symbol identifier', getter: '[key]', setter: '[key]' },
  { name: 'well-known symbol', getter: '[Symbol.iterator]', setter: '[Symbol.iterator]' },
];

describe('function-spacing accessor groups', () => {
  it.each(accessorKeys)('keeps $name getter/setter pairs together', ({ getter, setter }) => {
    for (const modifier of ['', 'static ']) {
      for (const reverse of [false, true]) {
        const members = [`  ${modifier}get ${getter}() { return 1; }`, `  ${modifier}set ${setter}(value: number) {}`];
        if (reverse) members.reverse();
        const pair = members.join('\n');
        expectFixed({
          input: `class C {\n  before = 1;\n${pair}\n  after = 2;\n}`,
          output: `class C {\n  before = 1;\n\n${pair}\n\n  after = 2;\n}`,
        });
      }
    }
  });

  it.each([
    ['different names', 'get first() { return 1; }', 'set second(value: number) {}'],
    ['different staticness', 'static get value() { return 1; }', 'set value(value: number) {}'],
    ['different privacy', 'get #value() { return 1; }', 'set value(value: number) {}'],
    ['two getters', 'get value() { return 1; }', 'get value() { return 2; }'],
    ['dynamic computed keys', 'get [key()]() { return 1; }', 'set [key()](value: number) {}'],
  ])('does not pair %s', (_name, left, right) => {
    expectFixed({ input: `class C {\n  ${left}\n  ${right}\n}`, output: `class C {\n  ${left}\n\n  ${right}\n}` });
  });

  it('retains an existing blank line within an accessor pair', () => {
    const code = 'class C {\n  get value() { return 1; }\n\n  set value(value: number) {}\n}';
    expect(linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('keeps documentation and decorators within a paired implementation', () => {
    expectFixed({
      input: 'class C {\n  before = 1;\n  /** Read. */\n  @memoize\n  get value() { return 1; }\n  /** Write. */\n  @trace\n  set value(value: number) {}\n  after = 2;\n}',
      output: 'class C {\n  before = 1;\n\n  /** Read. */\n  @memoize\n  get value() { return 1; }\n  /** Write. */\n  @trace\n  set value(value: number) {}\n\n  after = 2;\n}',
    });
  });

  it('pairs only two accessors at a time', () => {
    expectFixed({
      input: 'class C {\n  get value() { return 1; }\n  set value(value: number) {}\n  get value() { return 2; }\n}',
      output: 'class C {\n  get value() { return 1; }\n  set value(value: number) {}\n\n  get value() { return 2; }\n}',
    });
  });
});

describe('function-spacing overload groups', () => {
  it.each(['', 'export ', 'export default '])('groups top-level %sfunction overloads with the implementation', prefix => {
    const group = `${prefix}function parse(x: string): string;\n${prefix}function parse(x: number): string;\n${prefix}function parse(x: string | number): string { return String(x); }`;
    expectFixed({ input: `const before = 1;\n${group}\nconst after = 2;`, output: `const before = 1;\n\n${group}\n\nconst after = 2;` });
  });

  it.each(['parse', '"parse"', '[Symbol.iterator]', '#parse'])('groups class overloads of %s', key => {
    for (const modifier of ['', 'static ']) {
      const group = `  ${modifier}${key}(x: string): string;\n  ${modifier}${key}(x: number): string;\n  ${modifier}${key}(x: string | number) { return String(x); }`;
      expectFixed({ input: `class C {\n  before = 1;\n${group}\n  after = 2;\n}`, output: `class C {\n  before = 1;\n\n${group}\n\n  after = 2;\n}` });
    }
  });

  it('groups constructor overloads', () => {
    const group = '  constructor(x: string);\n  constructor(x: number);\n  constructor(x: string | number) {}';
    expectFixed({ input: `class C {\n  before = 1;\n${group}\n  after = 2;\n}`, output: `class C {\n  before = 1;\n\n${group}\n\n  after = 2;\n}` });
  });

  it('keeps overload comments attached to their respective signatures', () => {
    const group = '/** String input. */\nfunction parse(x: string): string;\n/** Number input. */\nfunction parse(x: number): string;\n/** Implementation. */\nfunction parse(x: string | number) { return String(x); }';
    expectFixed({ input: `const before = 1;\n${group}\nconst after = 2;`, output: `const before = 1;\n\n${group}\n\nconst after = 2;` });
  });

  it.each([
    ['unrelated function signature', 'function other(x: string): string;', 'function parse(x: string) { return x; }'],
    ['ambient function declaration', 'declare function parse(x: string): string;', 'function parse(x: string) { return x; }'],
    ['mismatched export kind', 'export function parse(x: string): string;', 'function parse(x: string) { return x; }'],
  ])('does not group %s', (_name, signature, implementation) => {
    expectFixed({ input: `${signature}\n${implementation}`, output: `${signature}\n\n${implementation}` });
  });

  it('does not group mismatched static class signatures', () => {
    expectFixed({ input: 'class C {\n  static run(): void;\n  run() {}\n}', output: 'class C {\n  static run(): void;\n\n  run() {}\n}' });
  });

  it('does not absorb an unrelated signature ahead of a real overload group', () => {
    const group = 'function parse(x: string): string;\nfunction parse(x: string) { return x; }';
    expectFixed({ input: `function other(): void;\n${group}`, output: `function other(): void;\n\n${group}` });
  });

  it('does not group across an intervening declaration', () => {
    expectFixed({ input: 'function parse(x: string): string;\nconst value = 1;\nfunction parse(x: string) { return x; }', output: 'function parse(x: string): string;\nconst value = 1;\n\nfunction parse(x: string) { return x; }' });
  });
});

const manualCases = [
  { name: 'two same-line declarations', code: 'function first() {} function second() {}', messageId: 'inline' },
  { name: 'compact class methods', code: 'class C { first() {} second() {} }', messageId: 'inline' },
  { name: 'same-line comments and declarations', code: 'function first() {} /* note */ function second() {}', messageId: 'inline' },
  { name: 'a line break only inside a block comment', code: 'function first() {} /* note\nsecond line */function second() {}', messageId: 'inline' },
  { name: 'a trailing JSDoc block', code: 'function first() {} /** @deprecated Note. */\nfunction second() {}', messageId: 'commentAttachment' },
  { name: 'a trailing multiline JSDoc block', code: 'function first() {} /** @deprecated\nNote. */\nfunction second() {}', messageId: 'commentAttachment' },
  { name: 'a counted coverage span', code: '/* v8 ignore next 2 */\nfunction first() {}\nfunction second() {}', messageId: 'directive' },
  { name: 'a counted c8 span', code: '/* c8 ignore next 2 */\nfunction first() {}\nfunction second() {}', messageId: 'directive' },
  { name: 'a counted node coverage span', code: '// node:coverage ignore next 2\nfunction first() {}\nfunction second() {}', messageId: 'directive' },
];

describe('function-spacing conservative fixes', () => {
  it.each(manualCases)('reports $name without editing it', ({ code, messageId }) => {
    const result = linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(code);
    expect(result.messages).toMatchObject([{ ruleId, messageId }]);
    expect(result.messages[0].fix).toBeUndefined();
  });

  it.each([
    '// @ts-expect-error Note.',
    '// @ts-ignore',
    '/// @ts-expect-errorTS2304',
    '/* detail\n * @ts-expect-error Note. */',
    '// eslint-disable-next-line no-empty-function',
    '/* istanbul ignore next */',
    '/* v8 ignore next 1 */',
    '// prettier-ignore',
    '// biome-ignore lint/example: reason',
  ])('can insert before the entire directive/target group: %s', directive => {
    expectFixed({
      input: `const before = 1;\n${directive}\nfunction run() {}`,
      output: `const before = 1;\n\n${directive}\nfunction run() {}`,
      configs: settings({ extra: directive.startsWith('// eslint-') ? { 'no-empty-function': 'error' } : {} }),
    });
  });

  it('preserves the target of this rule’s own disable-next-line directive', () => {
    const code = `const before = 1;\n// eslint-disable-next-line ${ruleId}\nfunction run() {}\nconst after = 2;`;
    const output = `const before = 1;\n// eslint-disable-next-line ${ruleId}\nfunction run() {}\n\nconst after = 2;`;
    const first = linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' });
    expect(first.messages).toEqual([]);
    expect(first.output).toBe(output);
    expect(linter.verify(output, settings(), { filename: 'fixture.ts' })).toEqual([]);
  });

  it('does not rewrite an already separated counted span', () => {
    const code = '// v8 ignore next 3\nfunction first() {}\n\nfunction second() {}';
    expect(linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('can insert after the end of a counted span', () => {
    expectFixed({ input: '// v8 ignore next 1\nfunction first() {}\nfunction second() {}', output: '// v8 ignore next 1\nfunction first() {}\n\nfunction second() {}' });
  });
});

function vueScriptContents({ code }: { code: string }) {
  const parsed = vueParser.parseForESLint(code, { parser, sourceType: 'module' });
  const fragment = parsed.services?.getDocumentFragment();
  return fragment?.children
    .filter(node => node.type === 'VElement' && node.name === 'script' && node.endTag)
    .map(node => {
      if (node.type !== 'VElement' || !node.endTag) throw new Error('Expected a script block');
      return code.slice(node.startTag.range[1], node.endTag.range[0]);
    }) ?? [];
}

function expectVueFixed({ input, output }: { input: string; output: string }) {
  const configs = settings({ vue: true });
  const filename = 'Component.vue';
  const result = linter.verifyAndFix(input, configs, { filename });
  expect(result.messages).toEqual([]);
  expect(result.output).toBe(output);
  expect(result.fixed).toBe(true);
  expect(linter.verifyAndFix(output, configs, { filename })).toEqual({ fixed: false, output, messages: [] });
  const before = vueScriptContents({ code: input });
  const after = vueScriptContents({ code: output });
  expect(after).toHaveLength(before.length);
  for (let index = 0; index < before.length; index += 1) {
    expectSameProgram({ before: before[index], after: after[index] });
  }
}

describe('function-spacing Vue scripts', () => {
  it.each(['<script>', '<script lang="ts">', '<script setup>', '<script setup lang="ts">'])('fixes top-level functions in %s', opening => {
    const before = `${opening}\nconst before = 1;\nfunction run() {}\nconst after = 2;\n</script>`;
    const after = `${opening}\nconst before = 1;\n\nfunction run() {}\n\nconst after = 2;\n</script>`;
    expectVueFixed({ input: before, output: after });
  });

  it('handles both script blocks without inserting padding between them', () => {
    expectVueFixed({
      input: '<script lang="ts">\nexport const before = 1;\nexport function run() {}\n</script>\n<template><div>{{ count }}</div></template>\n<script setup lang="ts">\nconst reset = () => {};\nconst count = 1;\n</script>',
      output: '<script lang="ts">\nexport const before = 1;\n\nexport function run() {}\n</script>\n<template><div>{{ count }}</div></template>\n<script setup lang="ts">\nconst reset = () => {};\n\nconst count = 1;\n</script>',
    });
  });

  it('handles script setup before a normal script', () => {
    expectVueFixed({
      input: '<script setup lang="ts">\nconst reset = () => {};\nconst count = 1;\n</script>\n<script lang="ts">\nexport const before = 1;\nexport function run() {}\n</script>',
      output: '<script setup lang="ts">\nconst reset = () => {};\n\nconst count = 1;\n</script>\n<script lang="ts">\nexport const before = 1;\n\nexport function run() {}\n</script>',
    });
  });

  it('handles generic script setup without padding synthetic scope boundaries', () => {
    expectVueFixed({
      input: '<script setup lang="ts" generic="T extends string">\nconst count = 1;\nconst identity = (value: T) => value;\nconst after = 2;\n</script>',
      output: '<script setup lang="ts" generic="T extends string">\nconst count = 1;\n\nconst identity = (value: T) => value;\n\nconst after = 2;\n</script>',
    });
  });

  it('spaces implemented class members inside script setup', () => {
    expectVueFixed({
      input: '<script setup lang="ts">\nclass Service {\n  start() {}\n  stop() {}\n}\n</script>',
      output: '<script setup lang="ts">\nclass Service {\n  start() {}\n\n  stop() {}\n}\n</script>',
    });
  });

  it('keeps options objects, interfaces and template/style blocks byte-identical', () => {
    const prefix = '<template>\n  <button @click="() => { first(); second(); }">{{ { first: 1, second: 2 } }}</button>\n</template>\n<style scoped>\nbutton { color: red; }\n</style>\n';
    const script = '<script lang="ts">\ninterface Contract { first(): void; second(): void; }\nexport default { first() {}, second() {} };\n';
    expectVueFixed({ input: `${prefix}${script}function helper() {}\n</script>`, output: `${prefix}${script}\nfunction helper() {}\n</script>` });
  });

  it.each([
    '<script lang="ts">function first() {}</script><script setup lang="ts">function second() {}</script>',
    '<script setup lang="ts">const run = () => {};</script>',
    '<template><div>{{ () => {} }}</div></template>',
    '<style>div { color: red; }</style>',
    '<script src="./external.ts"></script><template><div /></template>',
    '<script lang="ts">\nexport default {\n  start() {},\n  stop() {},\n};\n</script>',
  ])('preserves unrelated or single-definition component %s', code => {
    expect(linter.verifyAndFix(code, settings({ vue: true }), { filename: 'Component.vue' })).toEqual({ fixed: false, output: code, messages: [] });
  });
});

describe('function-spacing registration and integration', () => {
  it.each(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'test.ts', 'spec.ts'])('is enabled for .%s', extension => {
    expectFixed({ input: 'const value = 1;\nconst run = () => {};', output: 'const value = 1;\n\nconst run = () => {};', filename: `fixture.${extension}` });
  });

  it('can run with the default JavaScript parser without a type service', () => {
    const input = 'class Service {\n  start() {}\n  stop() {}\n}';
    const output = 'class Service {\n  start() {}\n\n  stop() {}\n}';
    expect(linter.verifyAndFix(input, [config as Linter.Config], { filename: 'fixture.js' })).toEqual({ fixed: true, output, messages: [] });
  });

  it('supports JSX-valued standalone functions without visiting JSX contents as members', () => {
    expectFixed({
      input: 'const value = 1;\nconst View = () => <div onClick={() => {}}>{value}</div>;\nconst after = 2;',
      output: 'const value = 1;\n\nconst View = () => <div onClick={() => {}}>{value}</div>;\n\nconst after = 2;',
      filename: 'fixture.tsx',
    });
  });

  it('converges with object-layout without adding blank lines to object properties', () => {
    const input = 'const service = {\n  enabled: true,\n  start() {},\n  stop: function () {},\n  reset: () => {},\n};\nfunction run() {}\nconst after = { value: 1 };';
    const output = 'const service = {\n  enabled: true,\n  start() {},\n  stop: function () {},\n  reset: () => {},\n};\n\nfunction run() {}\n\nconst after = { value: 1 };';
    const configs = [...settings(), objectConfig as Linter.Config];
    expectFixed({ input, output, configs });
  });

  it('converges when object-layout also needs to edit a function-valued initializer', () => {
    const input = 'const before = 1;\nconst run = () => ({value:1,other:2});\nconst after = 2;';
    const output = 'const before = 1;\n\nconst run = () => ({ value: 1, other: 2 });\n\nconst after = 2;';
    const configs = [...settings(), objectConfig as Linter.Config];
    expect(linter.verifyAndFix(input, configs, { filename: 'fixture.ts' })).toEqual({ fixed: true, output, messages: [] });
    expectSameProgram({ before: input, after: output });
    expect(linter.verifyAndFix(output, configs, { filename: 'fixture.ts' })).toEqual({ fixed: false, output, messages: [] });
  });

  it('preserves the always-vertical TEST_ONLY object export', () => {
    const input = 'function run() {}\nexport const TEST_ONLY = {\n};';
    const output = 'function run() {}\n\nexport const TEST_ONLY = {\n};';
    expectFixed({ input, output, configs: [...settings(), objectConfig as Linter.Config] });
  });

  it('converges with test-structure-spacing without padding local helpers', () => {
    const input = "const fixture = () => 1;\nimport { describe, it } from 'vitest';\ndescribe('suite', () => {\n\n  const value = 1;\n  function localHelper() {}\n  it('first', () => {});\n  it('second', () => {});\n\n});";
    const output = "const fixture = () => 1;\n\nimport { describe, it } from 'vitest';\n\ndescribe('suite', () => {\n  const value = 1;\n  function localHelper() {}\n\n  it('first', () => {});\n\n  it('second', () => {});\n});";
    const configs = [...settings(), testConfig as Linter.Config];
    expect(linter.verifyAndFix(input, configs, { filename: 'fixture.test.ts' })).toEqual({ fixed: true, output, messages: [] });
    expectSameProgram({ before: input, after: output });
    expect(linter.verifyAndFix(output, configs, { filename: 'fixture.test.ts' })).toEqual({ fixed: false, output, messages: [] });
  });

  it('converges with brace-style and indent on separate member lines', () => {
    const input = 'class C {\n first() { a(); }\n second() { b(); }\n}';
    const configs = settings({ extra: { 'brace-style': ['error', '1tbs', { allowSingleLine: false }], indent: ['error', 2] } });
    const fixed = linter.verifyAndFix(input, configs, { filename: 'fixture.ts' });
    expect(fixed.messages).toEqual([]);
    expect(fixed.output).toContain('  }\n\n  second()');
    expectSameProgram({ before: input, after: fixed.output });
    expect(linter.verifyAndFix(fixed.output, configs, { filename: 'fixture.ts' })).toEqual({ fixed: false, output: fixed.output, messages: [] });
  });

  it('is registered as an error in the actual Naidan config for scripts, tests and Vue', async () => {
    // Resolve configuration only; do not run the full project lint/typecheck.
    const eslint = new ESLint({ cwd: repoRoot });
    for (const filename of ['src/main.ts', 'src/utils/example.test.ts', 'src/components/Example.vue', 'eslint-local-rules/function-spacing.js']) {
      const resolved = await eslint.calculateConfigForFile(path.join(repoRoot, filename));
      expect(resolved?.rules[ruleId]).toEqual([2]);
      expect(resolved?.plugins['local-rules-function-spacing'].rules['function-spacing'].meta).toEqual(rule.meta);
    }
  });

  it('handles many independent boundaries in a single fix pass', () => {
    const input = Array.from({ length: 400 }, (_, index) => `function f${index}() {}`).join('\n');
    const output = input.replaceAll('\n', '\n\n');
    const messages = linter.verify(input, settings(), { filename: 'fixture.ts' });
    expect(messages).toHaveLength(399);
    const fixes = messages.map(message => message.fix!);
    for (let index = 1; index < fixes.length; index += 1) expect(fixes[index].range[0]).toBeGreaterThan(fixes[index - 1].range[1]);
    expect(linter.verifyAndFix(input, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: true, output, messages: [] });
    expect(linter.verifyAndFix(output, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: false, output, messages: [] });
  });
});

describe('function-spacing adversarial boundaries', () => {
  it('groups legal anonymous default-export overloads', () => {
    const group = 'export default function(x: string): void;\nexport default function(x: number): void;\nexport default function(x: string | number) {}';
    expectFixed({ input: `const before = 1;\n${group}\nconst after = 2;`, output: `const before = 1;\n\n${group}\n\nconst after = 2;` });
  });

  it('does not mistake a comment whose text is a semicolon for a class separator', () => {
    expectFixed({ input: 'class C {\n  first() {}\n  /*;*/\n  second() {}\n}', output: 'class C {\n  first() {}\n\n  /*;*/\n  second() {}\n}' });
  });

  it('keeps empty class separators and their notes with the preceding member', () => {
    expectFixed({ input: 'class C {\n  first() {} /* previous */;\n  // empty member\n  ;\n  second() {}\n}', output: 'class C {\n  first() {} /* previous */;\n  // empty member\n  ;\n\n  second() {}\n}' });
  });

  it('does not relocate documentation preceding an empty class separator', () => {
    const code = 'class C {\n  first() {} /** @deprecated Note. */;\n  second() {}\n}';
    const result = linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(code);
    expect(result.messages).toMatchObject([{ ruleId, messageId: 'commentAttachment' }]);
    expect(result.messages[0].fix).toBeUndefined();
  });

  it('handles local classes in test callbacks without touching the local function declarations', () => {
    expectFixed({
      input: "it('case', () => {\n  const value = 1;\n  function local() {}\n  class C {\n    first() {}\n    second() {}\n  }\n  use(C);\n});",
      output: "it('case', () => {\n  const value = 1;\n  function local() {}\n  class C {\n    first() {}\n\n    second() {}\n  }\n  use(C);\n});",
      filename: 'fixture.test.ts',
    });
  });

  it('spaces a multiline variable declaration only at its complete outer boundary', () => {
    expectFixed({
      input: 'const before = 1;\nconst run: (value: number) => number = (\n  value: number,\n) => {\n  function helper() {}\n  return value;\n};\nconst after = 2;',
      output: 'const before = 1;\n\nconst run: (value: number) => number = (\n  value: number,\n) => {\n  function helper() {}\n  return value;\n};\n\nconst after = 2;',
    });
  });

  it('separates nested class methods without padding the enclosing method body', () => {
    expectFixed({
      input: 'class Outer {\n  create() {\n    class Inner {\n      first() {}\n      second() {}\n    }\n    return Inner;\n  }\n  stop() {}\n}',
      output: 'class Outer {\n  create() {\n    class Inner {\n      first() {}\n\n      second() {}\n    }\n    return Inner;\n  }\n\n  stop() {}\n}',
    });
  });

  it('recognizes generic function expressions through instantiation expressions', () => {
    expectFixed({
      input: 'const before = 1;\nconst run = (function<T>(value: T) { return value; })<string>;\nconst after = 2;',
      output: 'const before = 1;\n\nconst run = (function<T>(value: T) { return value; })<string>;\n\nconst after = 2;',
    });
  });

  it('leaves all-function multiple bindings unsplit', () => {
    const code = 'const before = 1;\nconst first = () => {}, second = () => {};\nconst after = 2;';
    expect(linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('can fix independent safe boundaries while reporting a compact boundary as manual', () => {
    const input = 'const before = 1;\nfunction first() {} function second() {}\nconst after = 2;';
    const output = 'const before = 1;\n\nfunction first() {} function second() {}\n\nconst after = 2;';
    const result = linter.verifyAndFix(input, settings(), { filename: 'fixture.ts' });
    expect(result.output).toBe(output);
    expect(result.fixed).toBe(true);
    expect(result.messages).toMatchObject([{ ruleId, messageId: 'inline' }]);
    expectSameProgram({ before: input, after: output });
    const again = linter.verifyAndFix(output, settings(), { filename: 'fixture.ts' });
    expect(again.fixed).toBe(false);
    expect(again.output).toBe(output);
    expect(again.messages).toEqual(result.messages);
  });

  it('keeps the last line of a counted suppression span protected', () => {
    const input = '/* v8 ignore next 3 */\nconst before = 1;\n/** Run. */\nfunction run() {}\nconst after = 2;';
    const output = '/* v8 ignore next 3 */\nconst before = 1;\n/** Run. */\nfunction run() {}\n\nconst after = 2;';
    const result = linter.verifyAndFix(input, settings(), { filename: 'fixture.ts' });
    expect(result.output).toBe(output);
    expect(result.messages).toMatchObject([{ ruleId, messageId: 'directive' }]);
    expect(result.messages[0].fix).toBeUndefined();
    expectSameProgram({ before: input, after: output });
  });

  it('does not pad class expressions embedded in Vue template expressions', () => {
    const code = '<template><div :data-test="(class { first() {} second() {} })" /></template>';
    expect(linter.verifyAndFix(code, settings({ vue: true }), { filename: 'Component.vue' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('does not carry a function target across a leading semicolon in the next Vue script', () => {
    const code = '<script lang="ts">\nfunction run() {}\n</script>\n<script setup lang="ts">\n;\nconst value = 1;\n</script>';
    expect(linter.verifyAndFix(code, settings({ vue: true }), { filename: 'Component.vue' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('does not pad leading empty statements at a file edge', () => {
    const code = ';\n;\nfunction run() {}';
    expect(linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: false, output: code, messages: [] });
  });

  it('does not combine an overload and implementation from different Vue script blocks', () => {
    const code = '<script lang="ts">\nfunction run(x: string): void;\n</script>\n<script setup lang="ts">\nfunction run(x: string) {}\n</script>';
    expect(linter.verifyAndFix(code, settings({ vue: true }), { filename: 'Component.vue' })).toEqual({ fixed: false, output: code, messages: [] });
  });
});

const boundaryKinds = [
  { name: 'ordinary binding', target: false, code: (suffix: string) => `const value${suffix} = 1;` },
  { name: 'function declaration', target: true, code: (suffix: string) => `function run${suffix}() {}` },
  { name: 'arrow binding', target: true, code: (suffix: string) => `const run${suffix} = () => {};` },
  { name: 'object binding', target: false, code: (suffix: string) => `const object${suffix} = { run() {} };` },
];
const boundaryPairs = boundaryKinds.flatMap(left => boundaryKinds.map(right => ({ name: `${left.name} / ${right.name}`, left, right })));

describe('function-spacing boundary matrix', () => {
  it.each(boundaryPairs)('checks exactly the intended boundary for $name', ({ left, right }) => {
    for (const ending of ['\n', '\r\n']) {
      for (const trivia of [
        { gap: ending, separated: false },
        { gap: `${ending}// next${ending}`, separated: false },
        { gap: ` /* previous */${ending}/** @deprecated Next. */${ending}`, separated: false },
        { gap: `${ending}/** @deprecated Next. */ `, separated: false },
        { gap: ending.repeat(2), separated: true },
        { gap: `${ending}/* middle */${ending.repeat(2)}`, separated: true },
      ]) {
        const input = left.code('Left') + trivia.gap + right.code('Right');
        const before = linter.verify(input, settings(), { filename: 'fixture.ts' });
        expect(before).toHaveLength((left.target || right.target) && !trivia.separated ? 1 : 0);
        const fixed = linter.verifyAndFix(input, settings(), { filename: 'fixture.ts' });
        expect(fixed.messages).toEqual([]);
        expect(fixed.fixed).toBe(before.length > 0);
        expectSameProgram({ before: input, after: fixed.output });
        expect(linter.verifyAndFix(fixed.output, settings(), { filename: 'fixture.ts' })).toEqual({ fixed: false, output: fixed.output, messages: [] });
      }
    }
  });

  it.each([
    '// @ts-expect-error Note.',
    '// @ts-ignore',
    '/// @ts-expect-errorTS2304',
    '/* @ts-ignore */',
    '// eslint-disable-next-line no-empty-function',
  ])('does not insert between a trailing next-line directive and its target: %s', directive => {
    const code = `function first() {} ${directive}\nfunction second() {}`;
    const result = linter.verifyAndFix(code, settings(), { filename: 'fixture.ts' });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(code);
    expect(result.messages).toMatchObject([{ ruleId, messageId: 'directive' }]);
    expect(result.messages[0].fix).toBeUndefined();
  });
});
