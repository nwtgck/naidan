import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

function readPrintMediaRule({ selector }: { selector: string }): Rule {
  const source = readFileSync(path.resolve(process.cwd(), 'src/components/PrintView.vue'), 'utf8');
  const { descriptor } = parse(source, { filename: 'PrintView.vue' });
  const globalStyle = descriptor.styles.find(style => !style.scoped && style.content.includes('@media print'));
  expect(globalStyle, 'PrintView must keep a global @media print stylesheet').toBeDefined();

  const root = postcss.parse(globalStyle?.content ?? '');
  const printMedia = root.nodes.find((node): node is AtRule => (
    node.type === 'atrule'
      && node.name === 'media'
      && node.params.trim() === 'print'
  ));
  expect(printMedia, 'PrintView must keep an @media print block').toBeDefined();

  const rule = printMedia?.nodes?.find((node): node is Rule => (
    node.type === 'rule' && node.selector === selector
  ));
  expect(rule, `Missing print rule: ${selector}`).toBeDefined();
  if (rule === undefined) {
    throw new Error(`Missing print rule: ${selector}`);
  }
  return rule;
}

function expectImportantDisplay({ rule, value }: { rule: Rule, value: string }): void {
  const declaration = rule.nodes.find((node): node is Declaration => (
    node.type === 'decl' && node.prop === 'display'
  ));
  expect(declaration).toBeDefined();
  expect(declaration?.value).toBe(value);
  expect(declaration?.important).toBe(true);
}

describe('PrintView print CSS topology contract', () => {
  it('hides all body-level roots except the teleported print layer', () => {
    const rule = readPrintMediaRule({ selector: 'body > *:not(.naidan-print-view-layer)' });
    expectImportantDisplay({ rule, value: 'none' });
  });

  it('reveals the body-level print layer with an important display rule', () => {
    const rule = readPrintMediaRule({ selector: 'body > .naidan-print-view-layer' });
    expectImportantDisplay({ rule, value: 'block' });
  });
});
