import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const docsRoot = fileURLToPath(new URL('../', import.meta.url));
const scopeId = 'data-v-docs-motion-test';
const preferenceRoot = /html(?::has\(#docs-(?:pause-motion|light-theme):checked\)|\[data-theme=(?:"light"|'light')\])/;
const rootStart = new RegExp(`^${preferenceRoot.source}(?=\\s|$)`);
const rootGuard = new RegExp(`^${preferenceRoot.source}$`);
const sourceRootOnly = new RegExp(`^:global\\(${preferenceRoot.source}\\)$`);
const sourceWholeGlobal = new RegExp(`^:global\\(${preferenceRoot.source}(?:\\s+.+)?\\)$`);

function assertPreferenceSelector({ sourceSelector, compiledSelector, context }: { sourceSelector: string; compiledSelector: string; context: string }): void {
  expect(compiledSelector, context).toMatch(rootStart);
  if (sourceRootOnly.test(sourceSelector)) {
    expect(compiledSelector, context).toMatch(rootGuard);
    return;
  }
  expect(compiledSelector, context).not.toMatch(rootGuard);
  if (!sourceWholeGlobal.test(sourceSelector)) {
    expect(compiledSelector, context).toContain(`[${scopeId}]`);
  }
}

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
      if (!directory) {
        throw new Error('Missing directory');
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filename = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(filename);
          continue;
        }
        if (!entry.name.endsWith('.vue')) {
          continue;
        }
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
            if (!compiledRule) {
              throw new Error(`Missing compiled rule in ${file}`);
            }
            const sourceSelectors = postcss.list.comma(sourceRule.selector);
            const compiledSelectors = postcss.list.comma(compiledRule.selector);
            expect(compiledSelectors.length, `${file}:${sourceRule.source?.start?.line}`).toBe(sourceSelectors.length);
            for (const [selectorIndex, sourceSelector] of sourceSelectors.entries()) {
              if (!sourceSelector.includes('#docs-pause-motion:checked') && !sourceSelector.includes('#docs-light-theme:checked')
                && !sourceSelector.match(/html\[data-theme=(?:"light"|'light')\]/)) {
                continue;
              }
              const selector = compiledSelectors[selectorIndex];
              if (!selector) {
                throw new Error(`Missing compiled selector in ${file}`);
              }
              assertPreferenceSelector({ sourceSelector, compiledSelector: selector, context: `${file}:${sourceRule.source?.start?.line}` });
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each(["'light'", '"light"'])('rejects a lost descendant while allowing local targets and intentional global roots with %s', theme => {
    const root = `html[data-theme=${theme}]`;
    const compileSelector = ({ selector }: { selector: string }): string => {
      const output = compileStyle({ source: `${selector} { color: blue; }`, filename: 'Preference.vue', id: scopeId, scoped: true });
      expect(output.errors).toHaveLength(0);
      const rules: Rule[] = [];
      postcss.parse(output.code).walkRules(rule => {
        rules.push(rule);
      });
      const compiled = rules[0]?.selector;
      if (!compiled) {
        throw new Error('Missing compiled preference selector');
      }
      return compiled;
    };
    const brokenSource = `:global(${root}) .camera`;
    const broken = compileSelector({ selector: brokenSource });
    expect(broken).toBe(root);
    expect(() => assertPreferenceSelector({ sourceSelector: brokenSource, compiledSelector: broken, context: 'lost camera' })).toThrow();

    const localSource = `${root} .camera`;
    const local = compileSelector({ selector: localSource });
    expect(local).toBe(`${root} .camera[${scopeId}]`);
    expect(() => assertPreferenceSelector({ sourceSelector: localSource, compiledSelector: local, context: 'local camera' })).not.toThrow();

    const globalSource = `:global(${root})`;
    expect(() => assertPreferenceSelector({ sourceSelector: globalSource, compiledSelector: compileSelector({ selector: globalSource }), context: 'intentional global root' })).not.toThrow();
  });

  it.each([
    { file: 'components/HomeChatResponseDemo.vue', selector: `html:has(#docs-pause-motion:checked) .demo-send-stop[${scopeId}]`, property: 'visibility', value: 'hidden' },
    { file: 'components/demos/SettingsCameraFrame.vue', selector: `html:has(#docs-pause-motion:checked) .camera-canvas[${scopeId}]`, property: 'transform', value: 'translate(var(--rest-x),var(--rest-y)) scale(var(--rest-scale))' },
    { file: 'components/demos/NaidanRpcStep.vue', selector: `html:has(#docs-pause-motion:checked) .camera .canvas[${scopeId}]`, property: 'transform', value: undefined },
    { file: 'components/demos/BackupSettingsStep.vue', selector: `html:has(#docs-pause-motion:checked) .pointer[${scopeId}]`, property: 'display', value: 'none' },
    { file: 'components/demos/BackupSettingsStep.vue', selector: `html:has(#docs-light-theme:checked) .backup-viewport[${scopeId}]`, property: '--demo-warning', value: undefined },
  ])('preserves the $property declaration on $selector', ({ file, selector, property, value }) => {
    const rules: Rule[] = [];
    for (const { compiled } of scopedStyles({ file })) {
      compiled.walkRules(rule => {
        rules.push(rule);
      });
    }
    const targets = rules.filter(rule => postcss.list.comma(rule.selector).includes(selector));
    expect(targets.length, file).toBeGreaterThan(0);
    expect(targets.some(rule => rule.nodes.some(node => node.type === 'decl' && node.prop === property && (value === undefined || node.value === value)))).toBe(true);
  });

  it('uses complete focus poses when pausing or reducing camera motion', () => {
    const rules: Rule[] = [];
    for (const { compiled } of scopedStyles({ file: 'components/demos/SettingsCameraFrame.vue' })) {
      compiled.walkRules(rule => {
        rules.push(rule);
      });
    }
    const cameraSelector = `.camera-canvas[${scopeId}]`;
    const finalTransform = 'translate(var(--rest-x),var(--rest-y)) scale(var(--rest-scale))';
    const pauseRules = rules.filter(rule => postcss.list.comma(rule.selector).includes(`html:has(#docs-pause-motion:checked) ${cameraSelector}`));
    const reducedRules = rules.filter(rule => postcss.list.comma(rule.selector).includes(cameraSelector)
      && rule.parent?.type === 'atrule' && rule.parent.name === 'media' && rule.parent.params.includes('prefers-reduced-motion'));
    for (const cameraRules of [pauseRules, reducedRules]) {
      expect(cameraRules.some(rule => rule.nodes.some(node => node.type === 'decl' && node.prop === 'animation' && node.value === 'none' && node.important))).toBe(true);
      expect(cameraRules.some(rule => rule.nodes.some(node => node.type === 'decl' && node.prop === 'transform' && node.value === finalTransform))).toBe(true);
    }
    const defaults = rules.filter(rule => postcss.list.comma(rule.selector).includes(`.settings-camera[${scopeId}]`));
    const openPoses = rules.filter(rule => postcss.list.comma(rule.selector).includes(`.focus-open[${scopeId}]`));
    expect(openPoses.some(rule => rule.parent?.type === 'root')).toBe(true);
    expect(openPoses.some(rule => rule.parent?.type === 'atrule' && rule.parent.name === 'media' && rule.parent.params.includes('max-width'))).toBe(true);
    for (const poseRules of [defaults, ...openPoses.map(rule => [rule])]) {
      const variables = poseRules.flatMap(rule => rule.nodes.flatMap(node => node.type === 'decl' && node.value.trim() !== '' ? [node.prop] : []));
      expect(variables).toEqual(expect.arrayContaining(['--rest-x', '--rest-y', '--rest-scale']));
    }
  });
});
