import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import { parse, type ChildNode, type Container } from 'postcss';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import { describe, expect, it } from 'vitest';
import cssLayout from './css-layout.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ruleId = 'local-rules-css-layout/css-layout';
const linter = new Linter();
const config: Linter.Config[] = [
  {
    files: ['**/*.vue'],
    languageOptions: { parser: vueParser, parserOptions: { parser: tsParser } },
  },
  ...cssLayout,
];

// Check preservation independently of the formatter's source-range helpers.
// This oracle covers PostCSS-supported syntax only: escaped custom properties
// and directly escaped whitespace have separate byte-for-byte no-fix tests.
// Comparing two PostCSS ASTs alone would miss its misparsing of those forms.
function structure({ css }: { css: string }): unknown {
  function snapshot({ node }: { node: ChildNode }): unknown {
    const commentsBetween = node.raws.between?.includes('/*') ? node.raws.between : undefined;
    switch (node.type) {
    case 'decl':
      return {
        type: node.type, prop: node.prop,
        value: node.raws.value?.raw ?? node.value,
        important: node.important, rawImportant: node.raws.important,
        between: node.prop.startsWith('--') ? node.raws.between : commentsBetween,
        hack: node.raws.before?.match(/[*_]$/u)?.[0],
      };
    case 'comment':
      return { type: node.type, raw: node.source!.input.css.slice(node.source!.start!.offset, node.source!.end!.offset) };
    case 'rule':
      return { type: node.type, selector: node.raws.selector?.raw ?? node.selector, commentsBetween, nodes: snapshotChildren({ container: node }) };
    case 'atrule':
      return {
        type: node.type, name: node.name, params: node.raws.params?.raw ?? node.params,
        afterName: node.raws.afterName, commentsBetween,
        nodes: node.nodes ? snapshotChildren({ container: node }) : undefined,
      };
    default: {
      const _ex: never = node;
      throw new Error(`Unexpected node ${String(_ex)}`);
    }
    }
  }

  function snapshotChildren({ container }: { container: Container }): unknown[] {
    return container.nodes!.map(node => snapshot({ node: node as ChildNode }));
  }

  return snapshotChildren({ container: parse(css) });
}

function expectFixed({ input, output }: { input: string; output: string }) {
  const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
  expect(result.messages).toEqual([]);
  expect(result.output).toBe(output);
  expect(structure({ css: result.output })).toEqual(structure({ css: input }));
  const repeated = linter.verifyAndFix(result.output, config, { filename: 'src/example.css' });
  expect(repeated.messages).toEqual([]);
  expect(repeated.fixed).toBe(false);
  expect(repeated.output).toBe(output);
}

function styleBodies({ code }: { code: string }) {
  const parsed = vueParser.parseForESLint(code, { parser: tsParser, sourceType: 'module', ecmaVersion: 'latest' });
  const children = parsed.services!.getDocumentFragment()!.children;
  const ranges = children.filter(node => node.type === 'VElement' && node.name === 'style' && node.endTag)
    .map(node => [node.startTag.range[1], node.endTag!.range[0]]);
  let cursor = 0;
  const outside = [];
  const bodies = [];
  for (const [start, end] of ranges) {
    outside.push(code.slice(cursor, start));
    bodies.push(code.slice(start, end));
    cursor = end;
  }
  outside.push(code.slice(cursor));
  return { outside, bodies };
}

function expectVueFixed({ input, output }: { input: string; output: string }) {
  const result = linter.verifyAndFix(input, config, { filename: 'src/example.vue' });
  expect(result.messages).toEqual([]);
  expect(result.output).toBe(output);
  const before = styleBodies({ code: input });
  const after = styleBodies({ code: result.output });
  expect(after.outside).toEqual(before.outside);
  expect(after.bodies.map(css => structure({ css }))).toEqual(before.bodies.map(css => structure({ css })));
  const repeated = linter.verifyAndFix(result.output, config, { filename: 'src/example.vue' });
  expect(repeated.messages).toEqual([]);
  expect(repeated.fixed).toBe(false);
}

describe('CSS layout', () => {
  it('expands the requested example into ordinary CSS', () => {
    expectFixed({
      input: '.media-step { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }',
      output: `\
.media-step {
  border-top: 1px solid var(--line);
  margin-top: 36px;
  padding-top: 22px;
}`,
    });
  });

  it('indents nested rules, declarations, keyframes, and at-rules without sorting', () => {
    expectFixed({
      input: '@media (width > 1px){.b,.a{z-index:2;color:red;&:hover{color:blue}}}@keyframes pulse{from{opacity:0}50%,to{opacity:1}}',
      output: `\
@media (width > 1px) {
  .b,.a {
    z-index: 2;
    color: red;
    &:hover {
      color: blue;
    }
  }
}
@keyframes pulse {
  from {
    opacity: 0;
  }
  50%,to {
    opacity: 1;
  }
}`,
    });
  });

  it('handles Tailwind and Vue syntax without generic CSS validity rules', () => {
    expectFixed({
      input: '@reference "../style.css";@custom-variant dark (&:where(.dark, .dark *));@layer base{.x :deep(.y){@apply text-[1rem] dark:bg-gray-950;color:v-bind("theme.color")} :global(.a){color:red}}',
      output: `\
@reference "../style.css";
@custom-variant dark (&:where(.dark, .dark *));
@layer base {
  .x :deep(.y) {
    @apply text-[1rem] dark:bg-gray-950;
    color: v-bind("theme.color");
  }
  :global(.a) {
    color: red;
  }
}`,
    });
  });

  it('preserves quotes, data URLs, escapes, and punctuation inside values', () => {
    expectFixed({
      input: String.raw`.a{content:";:}{ /* not a comment */";background:url("data:image/svg+xml;utf8,<svg>{;}</svg>");font-family:'A;B',sans-serif;--tokens:{a:b;c:d};content:'a\'b';}`,
      output: String.raw`.a {
  content: ";:}{ /* not a comment */";
  background: url("data:image/svg+xml;utf8,<svg>{;}</svg>");
  font-family: 'A;B',sans-serif;
  --tokens:{a:b;c:d};
  content: 'a\'b';
}`,
    });
  });

  it('preserves custom-property token streams, including significant edge whitespace', () => {
    expectFixed({
      input: '.a{--empty:;--space:   ;--x:  red  ;--raw:\n    { a:b; };color:var(--x);--last:   }',
      output: `\
.a {
  --empty:;
  --space:   ;
  --x:  red  ;
  --raw:
    { a:b; };
  color: var(--x);
  --last:   ;
}`,
    });
  });

  it.each(['', '   ', '/**/', ' /**/ '])('preserves empty/comment-only regular values without growing whitespace: %j', value => {
    expectFixed({ input: `.a{color:${value};margin:0}`, output: `.a {\n  color:${value};\n  margin: 0;\n}` });
  });

  it.each([
    String.raw`\2d\2d foo`, String.raw`\00002d\00002dfoo`, String.raw`\2D\2D foo`,
    String.raw`\-\-foo`, String.raw`-\2d foo`, String.raw`\2d -foo`, String.raw`-\-foo`,
  ])('never fixes an escaped custom-property name that PostCSS cannot classify safely: %s', name => {
    for (const value of ['red', '', '   ', '/**/', ' /**/ ', '{a:b;c:d}']) {
      for (const suffix of [';color:red', '']) {
        const input = `.a{${name}:${value}${suffix}}`;
        const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
        expect(result.fixed).toBe(false);
        expect(result.output).toBe(input);
        expect(result.messages).toEqual([]);
      }
    }
  });

  it('still handles literal custom-property prefixes with escapes later in the name', () => {
    expectFixed({ input: String.raw`.a{--\66 oo:   ;color:red}`, output: String.raw`.a {
  --\66 oo:   ;
  color: red;
}` });
  });

  it.each([
    String.raw`.a{font-family:foo\ }`,
    String.raw`.a{animation-name:foo\ }`,
    '#foo\\\t{color:red}',
    '@keyframes foo\\\t{from{opacity:0}}',
    '.a{background:url(foo\\ bar)}',
  ])('does not fix directly escaped whitespace at value or header boundaries: %j', input => {
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
    expect(result.messages).toEqual([]);
  });

  it('distinguishes numeric-escape terminators and quoted/comment text from directly escaped whitespace', () => {
    const input = String.raw`/* \-\-foo: \ */ .\31 a{content:"\-\-foo: \ ";font-family:foo\20 bar}`;
    const output = String.raw`/* \-\-foo: \ */
.\31 a {
  content: "\-\-foo: \ ";
  font-family: foo\20 bar;
}`;
    expectFixed({ input, output });
  });

  it('protects escaped token streams in Vue without changing other blocks', () => {
    const input = String.raw`<template><div/></template><style>.a{\2d\2d foo:{a:b;c:d}}</style>`;
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.vue' });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
    expect(result.messages).toEqual([]);
  });

  it.each(['url', 'URL', String.raw`u\72l`, String.raw`\75rl`, String.raw`\55\52\4c`])('does not confuse comment-like unquoted %s URL text with CSS comments', name => {
    for (const declaration of [String.raw`\2d\2d foo:{a:b;c:d};color:red`, String.raw`font-family:foo\ `]) {
      for (const url of ['https://example.com/*', String.raw`https://example.com/\)/*`]) {
        const input = `.a{background:${name}(${url});${declaration}}`;
        const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
        expect(result.fixed).toBe(false);
        expect(result.output).toBe(input);
        expect(result.messages).toEqual([]);
      }
    }
  });

  it.each([
    { input: String.raw`.a\:b{color:red}`, output: String.raw`.a\:b {
  color: red;
}` },
    { input: String.raw`:deep(.group\/item){color:red}`, output: String.raw`:deep(.group\/item) {
  color: red;
}` },
    { input: String.raw`.\2d\2d foo:hover{color:red}`, output: String.raw`.\2d\2d foo:hover {
  color: red;
}` },
    { input: String.raw`@supports (\2d\2d foo: red){.a{color:red}}`, output: String.raw`@supports (\2d\2d foo: red) {
  .a {
    color: red;
  }
}` },
    { input: String.raw`.a{--tokens:\2d\2d foo:red;color:blue}`, output: String.raw`.a {
  --tokens:\2d\2d foo:red;
  color: blue;
}` },
  ])('formats safe selector, prelude and custom-value escapes without false positives: %#', ({ input, output }) => {
    expectFixed({ input, output });
  });

  it('accepts an already laid-out escaped custom property without requiring a rename or suppression', () => {
    const input = String.raw`.a {
  \2d\2d foo: red;
}`;
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
    expect(result.messages).toEqual([]);
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });

  it.each(['URL', 'uRl'])('accepts comment-like unquoted %s URL text that PostCSS cannot parse', name => {
    const input = `.a{background:${name}(https://example.com/*);color:red}`;
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
    expect(result.messages).toEqual([]);
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });

  it.each(['url(https://example.com/*)', 'URL(https://example.com/a)'])('formats supported unquoted URL text: %s', value => {
    expectFixed({ input: `.a{background:${value};color:red}`, output: `.a {\n  background: ${value};\n  color: red;\n}` });
  });

  it.each(['&{} ', '@media(width>0px){}'])('protects escaped custom declarations following a nested block: %s', nested => {
    const input = String.raw`.a{${nested}\2d\2d foo:{a:b;c:d};color:red}`;
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
    expect(result.messages).toEqual([]);
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });

  it('preserves multiline values and selectors without line-length wrapping', () => {
    const long = 'x'.repeat(20_000);
    expectFixed({
      input: `\
.a,
  .b{background-image:
    linear-gradient(red, blue),
    linear-gradient(black, white);content:"${long}";}`,
      output: `\
.a,
  .b {
  background-image:
    linear-gradient(red, blue),
    linear-gradient(black, white);
  content: "${long}";
}`,
    });
  });

  it('keeps trailing comments and comment-internal text attached and unchanged', () => {
    expectFixed({
      input: `\
/* Header */ .a{color:red;/* trailing */margin:0;
 /* Next property */
 padding:0;
 /* Multiline
      internal indentation */
 display:block /* value comment */;}
/* Footer */`,
      output: `\
/* Header */
.a {
  color: red; /* trailing */
  margin: 0;
  /* Next property */
  padding: 0;
  /* Multiline
      internal indentation */
  display: block /* value comment */;
}
/* Footer */`,
    });
  });

  it('does not rewrite comments inside declaration or block headers', () => {
    expectFixed({
      input: '.a/* header */{color/* name */:/* value */red;@foo /* after name */ value /* header */{x:y}}',
      output: `\
.a/* header */{
  color/* name */:/* value */red;
  @foo /* after name */ value /* header */{
    x: y;
  }
}`,
    });
  });

  it('keeps blank-line grouping and file-edge newlines', () => {
    expectFixed({
      input: '\n\n  .a {\n\n\tcolor :red;\n \n\t\n margin:0;\n\n }\n\n',
      output: '\n\n.a {\n\n  color: red;\n\n\n  margin: 0;\n\n}\n\n',
    });
  });

  it.each(['\n', '\r\n', '\r'])('preserves newline style %j', newline => {
    expectFixed({
      input: '.a{\ncolor:red;margin:0\n}'.replaceAll('\n', newline),
      output: '.a {\n  color: red;\n  margin: 0;\n}'.replaceAll('\n', newline),
    });
  });

  it('preserves a leading BOM', () => {
    expectFixed({ input: '\uFEFF.a{color:red}', output: '\uFEFF.a {\n  color: red;\n}' });
  });

  it('preserves legacy property hacks, importance, free semicolons, and empty blocks', () => {
    expectFixed({
      input: '.a{*color:red!important;_color:blue ! important; ;margin:0;;}.empty{}.spaced{ }',
      output: `\
.a {
  *color: red!important;
  _color: blue ! important; ;
  margin: 0;;
}
.empty {}
.spaced { }`,
    });
  });

  it.each([';', ' ;', '\n ;'])('handles a block own-semicolon without consuming the next rule: %j', suffix => {
    expectFixed({ input: `.a{}${suffix} .b{color:red}`, output: `.a {}${suffix}\n.b {\n  color: red;\n}` });
  });

  it.each(['', '  ', '/* Only a comment */', '@import "x"', '.a {}', '.a {\n  color: red;\n}'])('leaves already acceptable CSS unchanged: %j', input => {
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
    expect(result.messages).toEqual([]);
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });

  it('fixes hundreds of declarations together and converges in a single pass', () => {
    const declarations = Array.from({ length: 200 }, (_, index) => `prop-${index}:${index};`);
    const input = `.a{${declarations.join('')}}`;
    const output = `.a {\n${declarations.map(value => `  ${value.replace(':', ': ')}`).join('\n')}\n}`;
    const messages = linter.verify(input, config, { filename: 'src/example.css' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ ruleId, messageId: 'layout' });
    const fix = messages[0].fix!;
    const firstPass = input.slice(0, fix.range[0]) + fix.text + input.slice(fix.range[1]);
    expect(firstPass).toBe(output);
    expect(linter.verify(firstPass, config, { filename: 'src/example.css' })).toEqual([]);
    expectFixed({ input, output });
  });

  it.each(['.a{color:red', '.a{color:"open}', '.a{color:red;margin blue}', '.a{color:red}}'])('reports invalid CSS without changing it: %j', input => {
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].fatal).toBe(true);
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });

  it('reports errors at the CSS location for CRLF input', () => {
    const result = linter.verify('.a {\r\n  color:red;\r\n  broken\r\n}', config, { filename: 'src/example.css' });
    expect(result[0]).toMatchObject({ fatal: true, line: 3, column: 3 });
  });

  it.each(['stylelint-disable-next-line color-no-invalid-hex', 'eslint-disable-next-line unknown', 'prettier-ignore', 'biome-ignore format: preserve'])('requires manual formatting around position-sensitive comments: %s', comment => {
    const input = `/* ${comment} */\n.a{color:red;margin:0}`;
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.css' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ ruleId, messageId: 'directive' });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });
});

describe('Vue CSS layout', () => {
  it('formats scoped and global blocks while preserving scripts and templates byte for byte', () => {
    expectVueFixed({
      input: `\
<script setup lang="ts">
const css = '.a{color:red}';
</script>
<template><div style="color:red;margin:0" :style="{color:'red'}">.a{color:red}</div></template>
<style scoped>.a{color:red}</style>
<style lang="css">@media(x){.b{margin:0}}</style>`,
      output: `\
<script setup lang="ts">
const css = '.a{color:red}';
</script>
<template><div style="color:red;margin:0" :style="{color:'red'}">.a{color:red}</div></template>
<style scoped>
.a {
  color: red;
}
</style>
<style lang="css">
@media(x) {
  .b {
    margin: 0;
  }
}
</style>`,
    });
  });

  it('preserves style-edge blank lines and Windows newlines', () => {
    const input = '<template><div/></template>\n<style scoped>\n\n .a{color:red}\n\n</style>\n';
    const output = '<template><div/></template>\n<style scoped>\n\n.a {\n  color: red;\n}\n\n</style>\n';
    expectVueFixed({ input: input.replaceAll('\n', '\r\n'), output: output.replaceAll('\n', '\r\n') });
  });

  it.each([
    '<template><div/></template>',
    '<template><div/></template><style></style>',
    '<template><div/></template><style src="./external.css"></style>',
    '<template><div/></template><style lang="scss">$red:red;.a{color:$red}</style>',
    '<template><div/></template><style lang="less">@red:red;.a{color:@red}</style>',
    '<template><div/></template><custom>.a{color:red}</custom>',
  ])('does not modify empty, external, or non-CSS blocks: %s', input => {
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.vue' });
    expect(result.messages).toEqual([]);
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });

  it('reports a Vue CSS syntax error against its actual source line without fixing it', () => {
    const input = '<template><div/></template>\n<style scoped>\n.a{\n  broken\n}\n</style>';
    const result = linter.verifyAndFix(input, config, { filename: 'src/example.vue' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ ruleId, messageId: 'syntax', line: 4, column: 3 });
    expect(result.fixed).toBe(false);
    expect(result.output).toBe(input);
  });
});

describe('repository CSS layout integration', () => {
  it('enables only CSS layout rules for owned CSS and keeps TypeScript rules on Vue', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const cssConfig = await eslint.calculateConfigForFile('src/style.css');
    expect(cssConfig.rules).toEqual({ [ruleId]: [2] });
    const vueConfig = await eslint.calculateConfigForFile('src/components/PrintView.vue');
    expect(vueConfig.rules[ruleId]).toEqual([2]);
    expect(vueConfig.rules['@typescript-eslint/no-explicit-any']).toEqual([2]);
    expect(vueConfig.languageOptions.parserOptions.project).toContain('./tsconfig.app.json');
    const tsConfig = await eslint.calculateConfigForFile('src/utils/promise.ts');
    expect(tsConfig.rules[ruleId]).toBeUndefined();
  });

  it('fixes CSS through the real repository config and accepts Tailwind at-rules', async () => {
    const eslint = new ESLint({ cwd: repoRoot, fix: true });
    const [result] = await eslint.lintText('@reference "x";.a{@apply dark:text-red-500;color:red}', { filePath: 'src/style.css' });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe('@reference "x";\n.a {\n  @apply dark:text-red-500;\n  color: red;\n}');
  });

  it('includes Docs CSS and Vue in whole-repository lint without applying JavaScript rules to CSS', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const docsVue = await eslint.calculateConfigForFile('docs/components/DocLayout.vue');
    expect(docsVue.rules[ruleId]).toEqual([2]);
    expect(docsVue.languageOptions.parserOptions.project).toEqual(['./docs/tsconfig.json']);
    const docsCss = await eslint.calculateConfigForFile('docs/styles/site.css');
    expect(docsCss.rules).toEqual({ [ruleId]: [2] });
    expect(await eslint.isPathIgnored('docs/styles/site.css')).toBe(false);
    const input = '.media-step { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }';
    const [result] = await new ESLint({ cwd: repoRoot, fix: true }).lintText(input, { filePath: 'docs/styles/site.css' });
    expect(result.messages).toEqual([]);
    expect(result.output).toBe('.media-step {\n  border-top: 1px solid var(--line);\n  margin-top: 36px;\n  padding-top: 22px;\n}');
    const vue = linter.verifyAndFix(`<template><div/></template><style>${input}</style>`, config, { filename: 'docs/example.vue' });
    expect(vue.messages).toEqual([]);
    expect(vue.output).toBe(`<template><div/></template><style>\n${result.output}\n</style>`);
  });

  it('does not include generated and negative-fixture CSS', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    for (const filePath of ['dist/example.css', 'public/example.css', 'node_modules/example.css', 'src/test-tmp/example.css', 'eslint-local-rules/fixtures/example.css']) {
      expect(await eslint.isPathIgnored(filePath)).toBe(true);
    }
  });
});
