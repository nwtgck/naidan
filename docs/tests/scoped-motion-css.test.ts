import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const docsRoot = fileURLToPath(new URL('../', import.meta.url));
const scopeId = 'data-v-docs-motion-test';
const rootGuard = /^html:has\(#docs-(?:pause-motion|light-theme):checked\)$/;
const sourceRootOnly = /^:global\(html:has\(#docs-(?:pause-motion|light-theme):checked\)\)$/;

function scopedStyles({ file }: { file: string }) {
  const filename = join(docsRoot, file);
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename });
  expect(errors, file).toHaveLength(0);
  return descriptor.styles.filter(style => style.scoped).map(style => {
    const output = compileStyle({ source: style.content, filename, id: scopeId, scoped: true });
    expect(output.errors, file).toHaveLength(0);
    return { source: postcss.parse(style.content), compiled: postcss.parse(output.code) };
  });
}

describe('Docs scoped motion CSS', () => {
  it('keeps every pause and light-theme rule on its intended descendant after Vue compilation', () => {
    const pending = [docsRoot];
    let checked = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) throw new Error('Missing directory');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filename = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(filename);
          continue;
        }
        if (!entry.name.endsWith('.vue')) continue;
        const file = relative(docsRoot, filename);
        for (const { source, compiled } of scopedStyles({ file })) {
          const sourceRules: Rule[] = [], compiledRules: Rule[] = [];
          source.walkRules(rule => {
            sourceRules.push(rule);
          });
          compiled.walkRules(rule => {
            compiledRules.push(rule);
          });
          expect(compiledRules.length, file).toBe(sourceRules.length);
          for (const [ruleIndex, sourceRule] of sourceRules.entries()) {
            const compiledRule = compiledRules[ruleIndex];
            if (!compiledRule) throw new Error(`Missing compiled rule in ${file}`);
            const sourceSelectors = postcss.list.comma(sourceRule.selector);
            const compiledSelectors = postcss.list.comma(compiledRule.selector);
            expect(compiledSelectors.length, `${file}:${sourceRule.source?.start?.line}`).toBe(sourceSelectors.length);
            for (const [selectorIndex, sourceSelector] of sourceSelectors.entries()) {
              if (!sourceSelector.includes('#docs-pause-motion:checked') && !sourceSelector.includes('#docs-light-theme:checked')) continue;
              const selector = compiledSelectors[selectorIndex];
              if (!selector) throw new Error(`Missing compiled selector in ${file}`);
              expect(selector, `${file}:${sourceRule.source?.start?.line}`).toMatch(/^html:has\(#docs-(?:pause-motion|light-theme):checked\)/);
              if (sourceRootOnly.test(sourceSelector)) continue;
              expect(selector, `${file}:${sourceRule.source?.start?.line}`).not.toMatch(rootGuard);
              if (!sourceSelector.includes(':global(')) expect(selector, `${file}:${sourceRule.source?.start?.line}`).toContain(`[${scopeId}]`);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each([
    { file: 'site/BrowserMock.vue', selector: `html:has(#docs-pause-motion:checked) .demo-send-stop[${scopeId}]`, property: 'visibility', value: 'hidden' },
    { file: 'site/demos/SettingsCameraFrame.vue', selector: `html:has(#docs-pause-motion:checked) .focus-open .camera-canvas[${scopeId}]`, property: 'transform', value: undefined },
    { file: 'site/demos/NaidanRpcStep.vue', selector: `html:has(#docs-pause-motion:checked) .camera .canvas[${scopeId}]`, property: 'transform', value: undefined },
    { file: 'site/demos/BackupSettingsStep.vue', selector: `html:has(#docs-pause-motion:checked) .pointer[${scopeId}]`, property: 'display', value: 'none' },
    { file: 'site/demos/BackupSettingsStep.vue', selector: `html:has(#docs-light-theme:checked) .backup-viewport[${scopeId}]`, property: '--demo-warning', value: undefined },
  ])('preserves the $property declaration on $selector', ({ file, selector, property, value }) => {
    const rules: Rule[] = [];
    for (const { compiled } of scopedStyles({ file })) compiled.walkRules(rule => {
      rules.push(rule);
    });
    const target = rules.find(rule => postcss.list.comma(rule.selector).includes(selector));
    expect(target, file).toBeDefined();
    expect(target?.nodes.some(node => node.type === 'decl' && node.prop === property && (value === undefined || node.value === value))).toBe(true);
  });
});
