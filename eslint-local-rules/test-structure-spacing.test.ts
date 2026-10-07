// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ESLint, type Linter } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import path from 'node:path';
import testLayout, { rule } from './test-structure-spacing.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ruleId = 'local-rules-test-layout/test-structure-spacing';
const filePath = path.join(repoRoot, 'src/utils/example.test.ts');
const languageConfig = {
  files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
  languageOptions: { parser },
};
const structureConfig = {
  ...testLayout,
  rules: { [ruleId]: 'error' },
} satisfies Linter.Config;
const options = {
  cwd: repoRoot,
  overrideConfigFile: true,
  overrideConfig: [languageConfig, structureConfig],
} satisfies ESLint.Options;
const check = new ESLint(options);
const fix = new ESLint({ ...options, fix: true });

async function expectFixed({ code, output }: { code: string, output: string }) {
  const [diagnostic] = await check.lintText(code, { filePath });
  expect(diagnostic.fatalErrorCount).toBe(0);
  expect(diagnostic.errorCount).toBeGreaterThan(0);
  expect(diagnostic.messages.every(message => message.ruleId === ruleId)).toBe(true);
  const [fixed] = await fix.lintText(code, { filePath });
  expect(fixed.messages).toEqual([]);
  expect(fixed.output).toBe(output);
  const [repeated] = await fix.lintText(output, { filePath });
  expect(repeated.messages).toEqual([]);
  expect(repeated.output).toBeUndefined();
}

async function expectUnchanged({ code }: { code: string }) {
  const [result] = await fix.lintText(code, { filePath });
  expect(result.messages).toEqual([]);
  expect(result.output).toBeUndefined();
}

const declarations = [
  { name: 'it', code: "it('case', () => {});" },
  { name: 'it.each', code: "it.each([1, 2])('case %s', value => {});" },
  { name: 'test', code: "test('case', () => {});" },
  { name: 'describe', code: "describe('suite', () => {});" },
  { name: 'describe.each', code: "describe.each([1, 2])('suite %s', value => {});" },
  { name: 'beforeAll', code: 'beforeAll(() => {});' },
  { name: 'beforeEach', code: 'beforeEach(() => {});' },
  { name: 'afterEach', code: 'afterEach(() => {});' },
  { name: 'afterAll', code: 'afterAll(() => {});' },
];
const pairs = declarations.flatMap(left => declarations.map(right => ({
  name: `${left.name} / ${right.name}`,
  left: left.code,
  right: right.code,
})));

function inSuite({ code }: { code: string }) {
  return `\
describe('outer', () => {
${code.split('\n').map(line => line ? `  ${line}` : '').join('\n')}
});`;
}

describe('test-structure-spacing', () => {
  it.each(pairs)('separates $name at file scope and inside a suite', async ({ left, right }) => {
    for (const gap of ['\n', '\n\n\n', '\n\n\n\n']) {
      const code = `${left}${gap}${right}`;
      const output = `${left}\n\n${right}`;
      await expectFixed({ code, output });
      await expectFixed({ code: inSuite({ code }), output: inSuite({ code: output }) });
    }
    await expectUnchanged({ code: `${left}\n\n${right}` });
    await expectUnchanged({ code: inSuite({ code: `${left}\n\n${right}` }) });
  });

  it('reports the specific missing sibling gap', async () => {
    const [result] = await check.lintText(`\
it('a', () => {});
it('b', () => {});`, { filePath });
    expect(result.messages).toMatchObject([
      { ruleId, messageId: 'siblingSpacing', line: 2, column: 1 },
    ]);
  });

  it('separates same-line siblings without reformatting their bodies', async () => {
    await expectFixed({
      code: `\
describe('outer', () => {
  it('a', () => {}); it('b', () => {});
});`,
      output: `\
describe('outer', () => {
  it('a', () => {});

  it('b', () => {});
});`,
    });
  });

  it('handles nested suites without padding their first or last child', async () => {
    await expectFixed({
      code: `\
describe('outer', () => {

  beforeEach(() => {});
  describe('inner', () => {


    it('a', () => {});
    it.each([
      ['b'],
      ['c'],
    ])('case %s', value => {});

  });
  it('d', () => {});

});`,
      output: `\
describe('outer', () => {
  beforeEach(() => {});

  describe('inner', () => {
    it('a', () => {});

    it.each([
      ['b'],
      ['c'],
    ])('case %s', value => {});
  });

  it('d', () => {});
});`,
    });
  });

  it('handles trailing timeouts and multiline declaration arguments', async () => {
    await expectFixed({
      code: `\
beforeAll(async () => {
  await prepare();
}, 30000);


it(
  'preserves the result',
  async () => {
    await run();
  },
  30_000,
);
it('next', { timeout: 1000 }, () => {});`,
      output: `\
beforeAll(async () => {
  await prepare();
}, 30000);

it(
  'preserves the result',
  async () => {
    await run();
  },
  30_000,
);

it('next', { timeout: 1000 }, () => {});`,
    });
  });

  it.each([
    'it.skip', 'it.only', 'it.todo', 'it.concurrent', 'it.sequential', 'it.fails',
    'it.concurrent.skip', 'test.skip', 'test.each([1])', 'test.for([1])',
    'it.skipIf(false)', 'it.runIf(true)', 'it.skipIf(false).each([1])',
    'describe.skip', 'describe.only', 'describe.concurrent', 'describe.sequential',
    'describe.shuffle', 'describe.runIf(true).each([1])', 'suite', 'suite.each([1])',
    'it["skip"]', 'it["each"]([1])',
  ])('recognizes %s as a complete declaration', async callee => {
    await expectFixed({
      code: `${callee}('a', () => {});\nit('b', () => {});`,
      output: `${callee}('a', () => {});\n\nit('b', () => {});`,
    });
  });

  it('handles todo declarations without callbacks', async () => {
    await expectFixed({
      code: `\
it.todo('a');
it.todo('b');`,
      output: `\
it.todo('a');

it.todo('b');`,
    });
  });

  it('preserves each tagged-template tables while separating declarations', async () => {
    const table = `\
it.each\`\
  input | expected
  \${1}  | \${2}


  \${3}  | \${4}
\`('case $input', ({ input, expected }) => {});`;
    await expectFixed({
      code: `${table}\n${table}`,
      output: `${table}\n\n${table}`,
    });
  });

  it('recognizes aliased and namespace Vitest imports by binding', async () => {
    await expectFixed({
      code: `\
import { describe as group, it as example, beforeEach as setup } from 'vitest';
import * as runner from 'vitest';
group('outer', () => {
  setup(() => {});
  example.each([1])('a', value => {});
  runner.test('b', () => {});
  runner['afterEach'](() => {});
});`,
      output: `\
import { describe as group, it as example, beforeEach as setup } from 'vitest';
import * as runner from 'vitest';

group('outer', () => {
  setup(() => {});

  example.each([1])('a', value => {});

  runner.test('b', () => {});

  runner['afterEach'](() => {});
});`,
    });
  });

  it.each([
    `\
function it() {}
it('a', () => {});
it('b', () => {});`,
    `\
const test = service.test;
test('a', () => {});
test('b', () => {});`,
    `\
import { it } from 'another-library';
it('a', () => {});
it('b', () => {});`,
    `\
import it from 'vitest';
it('a', () => {});
it('b', () => {});`,
    `\
import type { it } from 'vitest';
it('a', () => {});
it('b', () => {});`,
    `\
import { type it } from 'vitest';
it('a', () => {});
it('b', () => {});`,
    `\
import { vi as it } from 'vitest';
it('a', () => {});
it('b', () => {});`,
    `\
import * as runner from 'another-library';
runner.it('a', () => {});
runner.it('b', () => {});`,
    `\
function register(it) {
  it('a', () => {});
  it('b', () => {});
}`,
    `\
import * as runner from 'vitest';
function register(runner) {
  runner.it('a', () => {});
  runner.it('b', () => {});
}`,
  ])('leaves unrelated or shadowed bindings unchanged: %#', async code => {
    await expectUnchanged({ code });
  });

  it.each([
    `\
it.each([1]);
it.each([2]);`,
    `\
describe.runIf(true);
describe.runIf(false);`,
    `\
it.extend({});
it.extend({});`,
    `\
it.unknown('a');
it.unknown('b');`,
    `\
object.it('a', () => {});
object.it('b', () => {});`,
    `\
it[method]('a', () => {});
it[method]('b', () => {});`,
    `\
it?.('a', () => {});
it?.('b', () => {});`,
    `\
it.each\`input
\${1}\`;
it.each\`input
\${2}\`;`,
  ])('does not guess unsupported calls or unfinished builders: %#', async code => {
    await expectUnchanged({ code });
  });

  it('supports TypeScript callee wrappers without rewriting them', async () => {
    await expectFixed({
      code: `\
(it as typeof it)('a', () => {});
it!('b', () => {});`,
      output: `\
(it as typeof it)('a', () => {});

it!('b', () => {});`,
    });
  });

  it('separates declarations from helpers but not ordinary sibling statements', async () => {
    await expectFixed({
      code: `\
describe('outer', () => {
  const first = 1;
  const second = 2;
  function fixture() { return first + second; }
  beforeEach(() => {});
  const third = 3;
  const fourth = 4;
  it('a', () => {});
});`,
      output: `\
describe('outer', () => {
  const first = 1;
  const second = 2;
  function fixture() { return first + second; }

  beforeEach(() => {});

  const third = 3;
  const fourth = 4;

  it('a', () => {});
});`,
    });
  });

  it('does not move hooks or change their scope', async () => {
    await expectFixed({
      code: `\
beforeEach(() => {});
describe('outer', () => {
  it('a', () => {});
  afterEach(() => {});
  it('b', () => {});
});`,
      output: `\
beforeEach(() => {});

describe('outer', () => {
  it('a', () => {});

  afterEach(() => {});

  it('b', () => {});
});`,
    });
  });

  it('does not space out setup, actions, or assertions inside callbacks', async () => {
    await expectUnchanged({ code: `\
it('transforms a value', async () => {
  const input = createInput();
  const service = createService();
  const result = await service.transform({ input });
  expect(result.value).toBe('expected');
  expect(result.error).toBeUndefined();
});` });
  });

  it('preserves existing internal grouping, inline statements, and unrelated blocks', async () => {
    await expectUnchanged({ code: `\
it('a', () => {
  const input = createInput(); const service = createService();


  const result = service.transform({ input });
  expect(result).toBeDefined();
  if (result) {

    verify(result);

  }
});

function helper() {

  first();


  second();

}` });
  });

  it.each(declarations)('removes edge padding from $name callbacks only', async ({ code }) => {
    await expectFixed({
      code: code.replace('{}', `\
{

  first();


  second();

}`),
      output: code.replace('{}', `\
{
  first();


  second();
}`),
    });
  });

  it('handles empty padded callbacks without overlapping fixes', async () => {
    await expectFixed({
      code: `\
describe('empty', () => {


});`,
      output: `\
describe('empty', () => {
});`,
    });
    await expectUnchanged({ code: "describe('empty', () => {});" });
  });

  it('handles a function callback after an options object', async () => {
    await expectFixed({
      code: `\
describe('a', { timeout: 1000 }, function cases() {

  it('a', function body() {

    verify();

  });

});`,
      output: `\
describe('a', { timeout: 1000 }, function cases() {
  it('a', function body() {
    verify();
  });
});`,
    });
  });

  it('handles registrations in loops, conditionals, and switch cases', async () => {
    await expectFixed({
      code: `\
for (const value of [1, 2]) {
  if (value) {
    it('a', () => {});
    it('b', () => {});
  }
}
switch (mode) {
case 'active':
  it('c', () => {});
  it('d', () => {});
}`,
      output: `\
for (const value of [1, 2]) {
  if (value) {
    it('a', () => {});

    it('b', () => {});
  }
}
switch (mode) {
case 'active':
  it('c', () => {});

  it('d', () => {});
}`,
    });
  });

  it.each([
    { prefix: 'if (enabled) ', suffix: ';' },
    { prefix: 'if (enabled) fallback(); else ', suffix: ';' },
    { prefix: 'for (const value of values) ', suffix: ';' },
    { prefix: 'while (registerNext()) ', suffix: ';' },
    { prefix: 'do ', suffix: '; while (registerNext());' },
    { prefix: 'enabled && ', suffix: ';' },
    { prefix: 'void ', suffix: ';' },
    { prefix: 'const register = () => ', suffix: ';' },
    { prefix: 'function register() { return ', suffix: '; }' },
  ])('removes callback padding regardless of the enclosing expression: $prefix', async ({ prefix, suffix }) => {
    for (const callee of ['it', 'it.each([1])', 'describe', 'test']) {
      await expectFixed({
        code: `\
${prefix}${callee}('case', () => {

  const input = createInput();
  const result = transform(input);
  expect(result).toBeDefined();

})${suffix}`,
        output: `\
${prefix}${callee}('case', () => {
  const input = createInput();
  const result = transform(input);
  expect(result).toBeDefined();
})${suffix}`,
      });
    }
  });

  it('removes padding from hook callbacks in conditional registrations', async () => {
    await expectFixed({
      code: `\
if (enabled) beforeEach(() => {

  reset();

});
if (enabled) afterEach(() => {

  dispose();

});`,
      output: `\
if (enabled) beforeEach(() => {
  reset();
});
if (enabled) afterEach(() => {
  dispose();
});`,
    });
  });

  it('does not treat conditional registrations as direct sibling declarations', async () => {
    await expectUnchanged({ code: `\
const input = createInput();
if (enabled) it('a', () => {});
enabled && it('b', () => {});
const result = transform(input);
expect(result).toBeDefined();` });
  });

  it.each([
    `\
import { it } from 'another-library';
if (enabled) it('a', () => {

  verify();

});`,
    `\
function register(it) {
  enabled && it('a', () => {

    verify();

  });
}`,
    `\
it.each([() => {

  data();

}]);`,
    `\
it.skipIf(() => {

  enabled();

});`,
    `\
it?.('a', () => {

  verify();

});`,
  ])('preserves non-declaration callbacks when visiting calls directly: %#', async code => {
    await expectUnchanged({ code });
  });

  it('preserves semicolonless declarations', async () => {
    await expectFixed({
      code: `\
it('a', () => {})
it('b', () => {})`,
      output: `\
it('a', () => {})

it('b', () => {})`,
    });
  });

  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('preserves line-ending style: %#', async newline => {
    const code = `\
describe('outer', () => {

  it('a', () => {});
  it('b', () => {});

});`;
    const output = `\
describe('outer', () => {
  it('a', () => {});

  it('b', () => {});
});`;
    await expectFixed({ code: code.replaceAll('\n', newline), output: output.replaceAll('\n', newline) });
  });

  it('preserves tab indentation and collapses whitespace-only excess blank lines', async () => {
    await expectFixed({
      code: "describe('outer', () => {\n\tit('a', () => {});\n \n\t\n\tit('b', () => {});\n});",
      output: "describe('outer', () => {\n\tit('a', () => {});\n\n\tit('b', () => {});\n});",
    });
  });

  it('does not rewrite gaps containing comments', async () => {
    await expectUnchanged({ code: `\
describe('outer', () => {

  // Existing placement is outside this rule's scope.

  it('a', () => {});
  // Existing placement is outside this rule's scope.
  it('b', () => {});


  /* Existing placement is outside this rule's scope. */

  it('c', () => {});

  // Existing placement is outside this rule's scope.

});` });
  });

  it('preserves template literal continuations, String.raw, and test-like text byte for byte', async () => {
    const first = `\
it('source text', () => {
  const script = \`\\
echo first


it('inside a string',()=>{});


\`;
  const raw = String.raw\`start\\n


describe('not code',()=>{});
\`;
  const escaped = 'one\\ntwo';
  const pattern = /it\\(.*,\\(\\)=>/;
  expect(script).toBeDefined(); expect(raw).toBeDefined();
});`;
    await expectFixed({
      code: `${first}\nit('next', () => {});`,
      output: `${first}\n\nit('next', () => {});`,
    });
  });

  it('preserves file-leading and trailing blank lines', async () => {
    await expectFixed({
      code: `\


it('a', () => {});
it('b', () => {});


`,
      output: `\


it('a', () => {});

it('b', () => {});


`,
    });
  });
});

describe('test layout configuration', () => {
  it('declares a whitespace-only layout rule', () => {
    expect(rule.meta).toMatchObject({ type: 'layout', fixable: 'whitespace', schema: [] });
  });

  it('combines structure, comma, and arrow spacing without padding ordinary statements', async () => {
    const combined = new ESLint({
      ...options,
      overrideConfig: [languageConfig, testLayout],
      fix: true,
    });
    const code = `\
describe('outer',()=>{

  beforeEach(()=>{
    reset();
  });
  it('a',async()=>{
    const input = createInput();
    const service = createService();
    const result = await service.transform({ input });
    expect(result.value).toBe('expected');
    expect(result.error).toBeUndefined();
  });


  it.each([1,2])('b',(value)=>{
    expect(value).toBeDefined();
  });

});`;
    const output = `\
describe('outer', () => {
  beforeEach(() => {
    reset();
  });

  it('a', async () => {
    const input = createInput();
    const service = createService();
    const result = await service.transform({ input });
    expect(result.value).toBe('expected');
    expect(result.error).toBeUndefined();
  });

  it.each([1, 2])('b', (value) => {
    expect(value).toBeDefined();
  });
});`;
    const [result] = await combined.lintText(code, { filePath });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe(output);
    const [repeated] = await combined.lintText(output, { filePath });
    expect(repeated.messages).toEqual([]);
    expect(repeated.output).toBeUndefined();
  });

  it('converges with the existing indentation and brace-style rules for inline nested suites', async () => {
    const linter = new ESLint({
      ...options,
      overrideConfig: [languageConfig, testLayout, {
        rules: {
          indent: ['error', 2],
          'brace-style': ['error', '1tbs', { allowSingleLine: false }],
        },
      }],
      fix: true,
    });
    const code = "describe('outer',()=>{beforeEach(()=>{reset();});it('a',async()=>{await run();});describe.each([1])('inner',()=>{it('b',()=>{expect(true).toBe(true);});});});";
    const output = `\
describe('outer', () => {
  beforeEach(() => {
    reset();
  });

  it('a', async () => {
    await run();
  });

  describe.each([1])('inner', () => {
    it('b', () => {
      expect(true).toBe(true);
    });
  });
});`;
    const [result] = await linter.lintText(code, { filePath });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe(output);
    const [repeated] = await linter.lintText(output, { filePath });
    expect(repeated.messages).toEqual([]);
    expect(repeated.output).toBeUndefined();
  });

  it('keeps source literals unchanged with all new spacing rules enabled', async () => {
    const linter = new ESLint({ ...options, overrideConfig: [languageConfig, testLayout], fix: true });
    const code = `\
it('literal',()=>{
  const source = \`\\
it('not a call',()=>{});


\`;
  const raw = String.raw\`first\\n


describe('not a suite',()=>{});
\`;
  expect(source).toBeDefined();
  expect(raw).toBeDefined();
});
it('next',()=>{});`;
    const output = `\
it('literal', () => {
  const source = \`\\
it('not a call',()=>{});


\`;
  const raw = String.raw\`first\\n


describe('not a suite',()=>{});
\`;
  expect(source).toBeDefined();
  expect(raw).toBeDefined();
});

it('next', () => {});`;
    const [result] = await linter.lintText(code, { filePath });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe(output);
    const [repeated] = await linter.lintText(output, { filePath });
    expect(repeated.messages).toEqual([]);
    expect(repeated.output).toBeUndefined();
  });

  it('does not apply the configuration to production files', async () => {
    const linter = new ESLint({ ...options, overrideConfig: [languageConfig, testLayout], fix: true });
    const [result] = await linter.lintText(`\
it('a',()=>{});
it('b',()=>{});`, {
      filePath: path.join(repoRoot, 'src/utils/example.ts'),
    });
    expect(result.messages).toEqual([]);
    expect(result.output).toBeUndefined();
  });

  it.each(['test', 'spec'])('applies the configuration to .%s.ts files', async suffix => {
    const linter = new ESLint({ ...options, overrideConfig: [languageConfig, testLayout], fix: true });
    const [result] = await linter.lintText(`\
it('a',()=>{});
it('b',()=>{});`, {
      filePath: path.join(repoRoot, `src/utils/example.${suffix}.ts`),
    });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe(`\
it('a', () => {});

it('b', () => {});`);
  });

  it('is enabled by the repository configuration only for test files', async () => {
    const linter = new ESLint({ cwd: repoRoot });
    const testConfig = await linter.calculateConfigForFile(path.join(repoRoot, 'src/utils/promise.test.ts'));
    expect(testConfig.rules[ruleId]).toEqual([2]);
    expect(testConfig.rules['comma-spacing']).toEqual([2, { before: false, after: true }]);
    expect(testConfig.rules['arrow-spacing']).toEqual([2, { before: true, after: true }]);
    expect(testConfig.rules['space-before-function-paren']).toEqual([2, { anonymous: 'ignore', named: 'ignore', asyncArrow: 'always' }]);
    const productionConfig = await linter.calculateConfigForFile(path.join(repoRoot, 'src/utils/promise.ts'));
    expect(productionConfig.rules[ruleId]).toBeUndefined();
    expect(productionConfig.rules['comma-spacing']).toBeUndefined();
    expect(productionConfig.rules['arrow-spacing']).toBeUndefined();
    expect(productionConfig.rules['space-before-function-paren']).toBeUndefined();
    expect(await linter.isPathIgnored(path.join(repoRoot, 'eslint-local-rules/test-structure-spacing.test.ts'))).toBe(true);
    expect(await linter.isPathIgnored(path.join(repoRoot, 'eslint-local-rules/fixtures/example.test.ts'))).toBe(true);
  });

  it.each([
    'src/test-tmp/kv-vitest.config.ts',
    'src/test-tmp/generated.fixture.ts',
    'src/test-tmp/nested/example.test.ts',
    'src/test-tmp/nested/example.spec.ts',
    'src/test-tmp/nested/example.vue',
    'src/test-tmp/nested/example.js',
  ])('excludes temporary support file %s before parsing or autofix', async relativePath => {
    const linter = new ESLint({ cwd: repoRoot, fix: true });
    const temporaryFilePath = path.join(repoRoot, relativePath);
    const results = await linter.lintText('export default {};', {
      filePath: temporaryFilePath,
      warnIgnored: false,
    });
    expect(results).toEqual([]);
    expect(await linter.isPathIgnored(temporaryFilePath)).toBe(true);
  });

  it.each([
    'src/utils/promise.ts',
    'src/utils/promise.test.ts',
    'src/test-setup.ts',
    'vite.config.ts',
    'build/transformers-js-fixes/replacements.ts',
    'src/lint-rule-tmp/example.ts',
    'src/test-tmp-other/example.test.ts',
    'src/features/example/test-tmp/example.test.ts',
  ])('keeps %s linted with its existing TypeScript projects', async relativePath => {
    const linter = new ESLint({ cwd: repoRoot });
    const includedFilePath = path.join(repoRoot, relativePath);
    expect(await linter.isPathIgnored(includedFilePath)).toBe(false);
    const config = await linter.calculateConfigForFile(includedFilePath);
    expect(config.languageOptions.parserOptions.project).toEqual([
      './tsconfig.app.json',
      './tsconfig.node.json',
    ]);
  });

  it('allows isolated rule tests to keep linting temporary test fixtures', async () => {
    const linter = new ESLint({ ...options, fix: true });
    const [result] = await linter.lintText(`\
it('a', () => {});
it('b', () => {});`, {
      filePath: path.join(repoRoot, 'src/test-tmp/test-layout.example.test.ts'),
    });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe(`\
it('a', () => {});

it('b', () => {});`);
  });
});
