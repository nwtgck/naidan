import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileStyle, parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

function frozenOpacity({ file, target, mode }: { file: string; target: string; mode: 'pause' | 'reduced' }) {
  const filename = fileURLToPath(new URL(`../components/demos/${file}`, import.meta.url));
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const opacity: string[] = [];
  for (const style of descriptor.styles) {
    const compiled = compileStyle({ source: style.content, filename, id: 'data-v-files-motion', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    postcss.parse(compiled.code).walkRules(rule => {
      const underReducedMotion = rule.parent?.type === 'atrule' && rule.parent.params.includes('prefers-reduced-motion:reduce');
      const selectors = postcss.list.comma(rule.selector);
      const matches = selectors.some(selector => selector.endsWith(`${target}[data-v-files-motion]`)
        && (mode === 'pause' ? selector.startsWith('html:has(#docs-pause-motion:checked)') : underReducedMotion));
      if (matches) {
        rule.walkDecls('opacity', declaration => {
          opacity.push(declaration.value);
        });
      }
    });
  }
  return opacity.at(-1);
}

describe('file workflow motion', () => {
  it.each(['pause', 'reduced'] as const)('leaves only the finished focus scenes visible for %s motion', mode => {
    for (const [file, visible, hidden] of [
      ['FileExplorerStep.vue', '.archive-outside', '.archive-inner'],
      ['BackupSettingsStep.vue', '.generated-archive', '.stage-archive .import-window'],
      ['BackupSettingsStep.vue', '.base64-import', '.base64-export'],
      ['FolderAccessDemo.vue', '.paused-state', '.copying-state'],
    ] as const) {
      expect(frozenOpacity({ file, target: visible, mode }), `${file}: ${visible}`).toBe('1');
      expect(frozenOpacity({ file, target: hidden, mode }), `${file}: ${hidden}`).toBe('0');
    }
  });
});
