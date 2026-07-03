import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSourceModules } from './source-module-analyzer.mjs';

describe('static Tailwind source module analysis', () => {
  it('falls back unowned candidate modules to initial CSS', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, 'main.ts'), 'export const main = true;\n');
      const orphan = path.join(sourceRoot, 'Orphan.vue');
      fs.writeFileSync(orphan, '<template><div tw-class="underline">orphan</div></template>\n');

      const analysis = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        entryModule: path.join(sourceRoot, 'main.ts'),
        aliases: [],
        additionalLazyRootDirectories: [],
      });

      expect(analysis.fallbackInitialModules).toContain(orphan);
      expect(analysis.moduleOwners.get(orphan)).toEqual(new Set(['initial']));
      expect(analysis.candidateOwners.get('underline')).toEqual(new Set(['initial']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
