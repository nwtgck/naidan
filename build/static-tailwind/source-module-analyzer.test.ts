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
        ownershipMode: 'module-graph',
      });

      expect(analysis.fallbackInitialModules).toContain(orphan);
      expect(analysis.moduleOwners.get(orphan)).toEqual(new Set(['initial']));
      expect(analysis.candidateOwners.get('underline')).toEqual(new Set(['initial']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('assigns every candidate to initial CSS without building a module graph in single CSS mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      const entryModule = path.join(sourceRoot, 'main.ts');
      const feature = path.join(sourceRoot, 'Feature.vue');
      fs.writeFileSync(entryModule, "const target = './Feature.vue'; import(target);\n");
      fs.writeFileSync(
        feature,
        '<template><div tw-class="underline">feature</div></template>\n',
      );

      const analysis = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        entryModule,
        aliases: [],
        additionalLazyRootDirectories: [],
        ownershipMode: 'single-css',
      });

      expect(analysis.graph.size).toBe(0);
      expect(analysis.unresolvedDynamicImports).toEqual([]);
      expect(analysis.lazyOwners).toEqual([]);
      expect(analysis.moduleOwners.get(feature)).toEqual(new Set(['initial']));
      expect(analysis.candidateOwners.get('underline')).toEqual(new Set(['initial']));
      expect(analysis.fallbackInitialModules.size).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports Vue script macro candidates at file-relative locations with unique group IDs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      const entryModule = path.join(sourceRoot, 'main.ts');
      const component = path.join(sourceRoot, 'MacroLocations.vue');
      fs.writeFileSync(entryModule, "import './MacroLocations.vue';\n");
      fs.writeFileSync(component, [
        '<template><div /></template>',
        '<script lang="ts">',
        "import { tw } from 'virtual:naidan-tailwind';",
        "const standard = tw('p-1');",
        '</script>',
        '<script setup lang="ts">',
        "import { tw } from 'virtual:naidan-tailwind';",
        "const setup = tw('m-1');",
        '</script>',
        '',
      ].join('\n'));

      const analysis = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        entryModule,
        aliases: [],
        additionalLazyRootDirectories: [],
        ownershipMode: 'single-css',
      });
      const macroGroups = analysis.candidateGroups.filter(({ filename }) => filename === component);

      expect(macroGroups.map(({ id, line, candidates }) => ({ id, line, candidates }))).toEqual([
        {
          id: `${component}:script:macro:0`,
          line: 4,
          candidates: ['p-1'],
        },
        {
          id: `${component}:script-setup:macro:0`,
          line: 8,
          candidates: ['m-1'],
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat sibling paths with a matching prefix as source modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    const siblingRoot = path.join(root, 'src-extra');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.mkdirSync(siblingRoot, { recursive: true });
      const entryModule = path.join(sourceRoot, 'main.ts');
      fs.writeFileSync(entryModule, "import '../src-extra/Outside.vue';\n");
      fs.writeFileSync(path.join(siblingRoot, 'Outside.vue'), '<template><div tw-class="underline">outside</div></template>\n');

      const analysis = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        entryModule,
        aliases: [],
        additionalLazyRootDirectories: [],
        ownershipMode: 'module-graph',
      });

      expect(analysis.graph.get(entryModule)?.staticImports).toEqual([]);
      expect(analysis.candidateOwners.has('underline')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
