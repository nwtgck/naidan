// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyTransformersJsFixes } from './transform';
import { bundledJinjaTemplate, originalBundledJinjaTemplate } from './jinja-template-fixture';

const original = readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8');
const FixedTemplate = bundledJinjaTemplate({ code: applyTransformersJsFixes({ code: original, version: '4.2.0' }).code });
const OriginalTemplate = originalBundledJinjaTemplate();

it('preserves the original bundled parser failure for whitespace-control generation tags', () => {
  expect(() => new OriginalTemplate('{%- generation -%}answer{%- endgeneration -%}')).toThrow('Unknown statement type: generation');
});

it('renders generation body using the lexer whitespace controls', () => {
  expect(new FixedTemplate('before  {%- generation -%}  answer  {%- endgeneration -%}  after').render()).toBe('beforeanswerafter');
});

it('preserves tag-looking text inside string expressions instead of preprocessing it away', () => {
  const source = '{{ "{% generation %}literal{% endgeneration %}" }}';
  expect(new OriginalTemplate(source).render()).toBe('literal');
  expect(new FixedTemplate(source).render()).toBe('{% generation %}literal{% endgeneration %}');
});

it('renders nested generation blocks without adding scope or changing body order', () => {
  const source = '{% set answer = "before" %}{% generation %}A{% set answer = "after" %}{% generation %}B{% endgeneration %}C{% endgeneration %}{{ answer }}';
  expect(new FixedTemplate(source).render()).toBe('ABCafter');
});

it('preserves normal block whitespace and trims only explicit whitespace controls', () => {
  expect(new FixedTemplate('A  {% generation %} B {% endgeneration %}  C').render()).toBe('A   B   C');
  expect(new FixedTemplate('A  {%- generation %} B {% endgeneration -%}  C').render()).toBe('A B C');
});

it('uses normal block newline handling around generation syntax', () => {
  expect(new FixedTemplate(`\
before
  {% generation %}
answer
  {% endgeneration %}
after`).render()).toBe(`\
before
answer
after`);
});

it('supports generation blocks nested in loops and conditional branches', () => {
  const source = '{% for item in items %}{% if item %}{% generation %}[{{ item }}]{% endgeneration %}{% endif %}{% endfor %}';
  expect(new FixedTemplate(source).render({ items: ['one', '', 'two'] })).toBe('[one][two]');
});

it('preserves a literal closing tag inside a generation block and ignores tag-looking comments', () => {
  const source = '{% generation %}{# {% endgeneration %} #}{{ "{% endgeneration %}" }}{% endgeneration %}';
  expect(new FixedTemplate(source).render()).toBe('{% endgeneration %}');
});

it('passes data values through unchanged rather than recursively treating them as template syntax', () => {
  const content = `\
<image>
{% generation %}user text{% endgeneration %}`;
  expect(new FixedTemplate('{% generation %}{{ content }}{% endgeneration %}').render({ content })).toBe(content);
});

it('preserves macro calls and block assignment evaluation inside generation blocks', () => {
  const source = '{% macro say(x) %}[{{ x }}]{% endmacro %}{% generation %}{% set text %}{{ say("body") }}{% endset %}{{ text }}{% endgeneration %}';
  expect(new FixedTemplate(source).render()).toBe('[body]');
});

it.each([
  '{% generation %}unclosed',
  '{% endgeneration %}',
  '{% generation argument %}body{% endgeneration %}',
  '{% generation %}body{% endgeneration argument %}',
  '{% generation %}{% if true %}body{% endgeneration %}{% endif %}',
  '{% generation %}{% generation %}body{% endgeneration %}',
])('rejects malformed generation syntax without silently deleting it: %s', source => {
  expect(() => new FixedTemplate(source)).toThrow(SyntaxError);
});
