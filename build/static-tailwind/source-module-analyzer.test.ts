import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSourceModules, createSourceModuleAnalysisCache } from './source-module-analyzer';

describe('static Tailwind source module analysis', () => {
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
        ownershipMode: 'single-css',
        cache: createSourceModuleAnalysisCache(),
      });

      expect(analysis.candidateOwners.get('underline')).toEqual(new Set(['initial']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('assigns candidates to stable source-module owners without building an import graph', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      const entryModule = path.join(sourceRoot, 'main.ts');
      const featureA = path.join(sourceRoot, 'FeatureA.vue');
      const featureB = path.join(sourceRoot, 'nested', 'FeatureB.vue');
      fs.writeFileSync(entryModule, "const target = './FeatureA.vue'; const decoy = 'text-red-500'; import(target);\n");
      fs.writeFileSync(featureA, '<template><div class="bg-red-500" tw-class="underline p-2">A</div></template>\n');
      fs.mkdirSync(path.dirname(featureB), { recursive: true });
      fs.writeFileSync(featureB, '<template><div tw-class="underline italic">B</div></template>\n');

      const analysis = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'source-module',
        cache: createSourceModuleAnalysisCache(),
      });

      expect(analysis.cssOwners).toEqual([
        { name: 'module:src/FeatureA.vue', root: featureA },
        { name: 'module:src/nested/FeatureB.vue', root: featureB },
      ]);
      expect(analysis.candidateOwners.get('p-2')).toEqual(new Set(['module:src/FeatureA.vue']));
      expect(analysis.candidateOwners.get('italic')).toEqual(new Set(['module:src/nested/FeatureB.vue']));
      expect(analysis.candidateOwners.has('bg-red-500')).toBe(false);
      expect(analysis.candidateOwners.has('text-red-500')).toBe(false);
      expect(analysis.candidateOwners.get('underline')).toEqual(new Set([
        'module:src/FeatureA.vue',
        'module:src/nested/FeatureB.vue',
      ]));
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
        ownershipMode: 'single-css',
        cache: createSourceModuleAnalysisCache(),
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

  it('collects candidates from Vue TSX script blocks with JSX syntax intact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      const entryModule = path.join(sourceRoot, 'main.ts');
      const component = path.join(sourceRoot, 'TsxMacro.vue');
      fs.writeFileSync(entryModule, "import './TsxMacro.vue';\n");
      fs.writeFileSync(component, [
        '<script setup lang="tsx">',
        "import { tw } from 'virtual:naidan-tailwind';",
        "const view: JSX.Element = <div className={tw('p-4')} />;",
        '</script>',
        '<template><div /></template>',
        '',
      ].join('\n'));

      const analysis = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'source-module',
        cache: createSourceModuleAnalysisCache(),
      });

      expect(analysis.candidateOwners.get('p-4')).toEqual(new Set(['module:src/TsxMacro.vue']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports same-line Vue template candidates at absolute source locations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      const component = path.join(sourceRoot, 'SameLine.vue');
      fs.writeFileSync(component, '<template><div tw-class="p-2 m-1" /></template>\n');

      const analysis = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'single-css',
        cache: createSourceModuleAnalysisCache(),
      });

      expect(analysis.candidateGroups).toEqual([expect.objectContaining({
        filename: component,
        sourceKind: 'tw-class',
        candidates: ['p-2', 'm-1'],
        line: 1,
        column: 16,
      })]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps file ordering deterministic and invalidates changed, deleted, and excluded cache entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    const cache = createSourceModuleAnalysisCache();
    try {
      fs.mkdirSync(path.join(sourceRoot, 'nested'), { recursive: true });
      fs.mkdirSync(path.join(sourceRoot, 'test-tmp'), { recursive: true });
      fs.mkdirSync(path.join(sourceRoot, 'lint-rule-tmp'), { recursive: true });
      const first = path.join(sourceRoot, 'A.vue');
      const second = path.join(sourceRoot, 'nested', 'B.vue');
      fs.writeFileSync(first, '<template><div tw-class="p-1" /></template>\n');
      fs.writeFileSync(second, '<template><div tw-class="p-2" /></template>\n');
      fs.writeFileSync(path.join(sourceRoot, 'Ignored.test.ts'), "import { tw } from 'virtual:naidan-tailwind'; tw('p-3');\n");
      fs.writeFileSync(path.join(sourceRoot, 'UnrelatedBroken.ts'), 'const invalid = <;\n');
      fs.writeFileSync(path.join(sourceRoot, 'test-tmp', 'Ignored.vue'), '<template><div tw-class="p-4" /></template>\n');
      fs.writeFileSync(path.join(sourceRoot, 'lint-rule-tmp', 'Ignored.vue'), '<template><div tw-class="p-5" /></template>\n');

      const initial = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'single-css',
        cache,
      });
      expect(initial.files).toEqual([first, path.join(sourceRoot, 'UnrelatedBroken.ts'), second]);
      expect([...initial.candidateOwners.keys()].sort()).toEqual(['p-1', 'p-2']);

      fs.writeFileSync(first, '<template><div tw-class="m-1" /></template>\n');
      fs.rmSync(second);
      const updated = analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'single-css',
        cache,
      });

      expect(updated.files).toEqual([first, path.join(sourceRoot, 'UnrelatedBroken.ts')]);
      expect([...updated.candidateOwners.keys()]).toEqual(['m-1']);
      expect(cache.has(second)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports Vue compiler errors using absolute SFC coordinates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, 'Invalid.vue'),
        '<template><div tw-content-class="p-2" /></template>\n',
      );

      expect(() => analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'single-css',
        cache: createSourceModuleAnalysisCache(),
      })).toThrow(/Invalid\.vue:1:16 Unknown Tailwind class attribute tw-content-class/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports Vue script macro errors using absolute SFC coordinates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, 'InvalidMacro.vue'),
        `<script setup lang="ts">import { tw } from 'virtual:naidan-tailwind'; const value = tw(dynamicValue);</script><template><div /></template>
`,
      );

      expect(() => analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'single-css',
        cache: createSourceModuleAnalysisCache(),
      })).toThrow(/InvalidMacro\.vue:1:85 tw\(\) requires exactly one string literal/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects external Vue templates instead of silently omitting their candidates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, 'External.vue'),
        '<template src="./External.html"></template>\n',
      );
      expect(() => analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'source-module',
        cache: createSourceModuleAnalysisCache(),
      })).toThrow(/External Vue template src files are not supported/u);

      fs.writeFileSync(
        path.join(sourceRoot, 'External.vue'),
        '<template lang="pug">div.p-2</template>\n',
      );
      expect(() => analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'source-module',
        cache: createSourceModuleAnalysisCache(),
      })).toThrow(/Unsupported Vue template language "pug"/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates unreachable source modules with the same macro and template rules as transformed modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      const entryModule = path.join(sourceRoot, 'main.ts');
      fs.writeFileSync(entryModule, 'export const main = true;\n');
      fs.writeFileSync(path.join(sourceRoot, 'InvalidMacro.ts'), [
        "import { tw } from 'virtual:naidan-tailwind';",
        'tw(className);',
        '',
      ].join('\n'));

      expect(() => analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'source-module',
        cache: createSourceModuleAnalysisCache(),
      })).toThrow(/tw\(\) requires exactly one string literal/u);

      fs.rmSync(path.join(sourceRoot, 'InvalidMacro.ts'));
      fs.writeFileSync(
        path.join(sourceRoot, 'InvalidAttribute.vue'),
        '<template><div tw-content-class="p-2" /></template>\n',
      );
      expect(() => analyzeSourceModules({
        projectRoot: root,
        sourceRoot,
        ownershipMode: 'source-module',
        cache: createSourceModuleAnalysisCache(),
      })).toThrow(/Unknown Tailwind class attribute tw-content-class/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
