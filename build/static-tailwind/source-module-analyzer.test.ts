import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  analyzeSourceModules,
  createSourceModuleAnalysisCache,
  isBoundaryStringPayloadPath,
  isStaticTailwindSourceFile,
  isStaticTailwindSourcePath,
} from './source-module-analyzer';

describe('static Tailwind source path boundary', () => {
  it.each(['messages', 'catalogs'])('excludes only the source-root strings/%s payload', (payload) => {
    const sourceRoot = path.join(os.tmpdir(), 'strings', 'messages', 'project', 'src');
    const payloadRoot = path.join(sourceRoot, 'strings', payload);
    expect(isBoundaryStringPayloadPath({ filename: payloadRoot, sourceRoot })).toBe(true);
    for (const extension of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue']) {
      const filename = path.join(payloadRoot, 'nested', '..', `message.${extension}`);
      expect(isBoundaryStringPayloadPath({ filename, sourceRoot })).toBe(true);
      expect(isStaticTailwindSourceFile({ filename, sourceRoot })).toBe(false);
    }
    for (const filename of [
      path.join(sourceRoot, 'strings', `${payload}-extra`, 'message.ts'),
      path.join(sourceRoot, 'features', 'strings', payload, 'message.ts'),
      path.join(sourceRoot, 'strings', 'runtime.ts'),
      path.join(sourceRoot, 'strings', 'index.ts'),
      path.join(sourceRoot, 'strings', 'types.ts'),
      path.join(sourceRoot, 'strings', 'utils.test-support.ts'),
    ]) {
      expect(isBoundaryStringPayloadPath({ filename, sourceRoot })).toBe(false);
      expect(isStaticTailwindSourceFile({ filename, sourceRoot })).toBe(true);
    }
    expect(isBoundaryStringPayloadPath({ filename: path.join(sourceRoot, '..', 'strings', payload), sourceRoot })).toBe(false);
    expect(isStaticTailwindSourcePath({ filename: path.join(payloadRoot, 'theme.css'), sourceRoot })).toBe(true);
  });

  it('keeps local stylesheet dependencies inside the boundary without treating them as analyzable modules', () => {
    const sourceRoot = path.join(os.tmpdir(), 'naidan-tailwind-source-boundary');
    const stylesheet = path.join(sourceRoot, 'theme.css');

    expect(isStaticTailwindSourcePath({ filename: stylesheet, sourceRoot })).toBe(true);
    expect(isStaticTailwindSourceFile({ filename: stylesheet, sourceRoot })).toBe(false);
    expect(isStaticTailwindSourceFile({ filename: path.join(sourceRoot, 'Feature.vue'), sourceRoot })).toBe(true);
    expect(isStaticTailwindSourcePath({
      filename: path.join(sourceRoot, 'test-tmp', 'theme.css'),
      sourceRoot,
    })).toBe(false);
    expect(isStaticTailwindSourcePath({
      filename: path.join(path.dirname(sourceRoot), 'outside.css'),
      sourceRoot,
    })).toBe(false);
  });
});

describe('static Tailwind source module analysis', () => {
  it('prunes payload directories before enumeration or reads and removes their cached sources', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    const payloads = [
      path.join(sourceRoot, 'strings', 'messages', 'Example', 'en.ts'),
      path.join(sourceRoot, 'strings', 'catalogs', 'en.ts'),
    ];
    const supported = [
      path.join(sourceRoot, 'features', 'strings', 'messages', 'Feature.ts'),
      path.join(sourceRoot, 'strings', 'messages-extra', 'Feature.ts'),
      path.join(sourceRoot, 'strings', 'runtime.ts'),
    ];
    for (const [index, file] of [...payloads, ...supported].entries()) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `import { tw } from 'virtual:naidan-tailwind'; export const value = tw('p-[${index}px]');`);
    }
    const cache = createSourceModuleAnalysisCache();
    for (const file of payloads) {
      cache.set(file, { source: 'stale payload', groups: [] });
    }
    const originalDirectories = fs.readdirSync;
    using directories = vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      if (isBoundaryStringPayloadPath({ filename: String(args[0]), sourceRoot })) {
        throw new Error('Payload directory must not be enumerated.');
      }
      return Reflect.apply(originalDirectories, fs, args) as ReturnType<typeof originalDirectories>;
    });
    const originalRead = fs.promises.readFile;
    using reads = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      if (isBoundaryStringPayloadPath({ filename: String(args[0]), sourceRoot })) {
        throw new Error('Payload source must not be read.');
      }
      return Reflect.apply(originalRead, fs.promises, args) as ReturnType<typeof originalRead>;
    });

    const analysis = await analyzeSourceModules({ projectRoot: root, sourceRoot, ownershipMode: 'source-module', cache });

    expect(analysis.files).toEqual(supported);
    expect(analysis.candidateGroups.map(({ filename }) => filename)).toEqual(supported);
    expect(analysis.candidateGroups.map(({ candidates }) => candidates)).toEqual([['p-[2px]'], ['p-[3px]'], ['p-[4px]']]);
    expect(analysis.cssOwners.map(({ root: ownerRoot }) => ownerRoot)).toEqual(supported);
    expect(reads.mock.calls.map(([file]) => file)).toEqual(supported);
    expect(directories.mock.calls.map(([directory]) => directory)).not.toContain(path.join(sourceRoot, 'strings', 'messages'));
    expect(directories.mock.calls.map(([directory]) => directory)).not.toContain(path.join(sourceRoot, 'strings', 'catalogs'));
    for (const file of payloads) {
      expect(cache.has(file)).toBe(false);
    }
  });

  it('assigns every candidate to initial CSS without building a module graph in single CSS mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    const entryModule = path.join(sourceRoot, 'main.ts');
    const feature = path.join(sourceRoot, 'Feature.vue');
    fs.writeFileSync(entryModule, "const target = './Feature.vue'; import(target);\n");
    fs.writeFileSync(
      feature,
      '<template><div tw-class="underline">feature</div></template>\n',
    );

    const analysis = await analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'single-css',
      cache: createSourceModuleAnalysisCache(),
    });

    expect(analysis.candidateOwners.get('underline')).toEqual(new Set(['initial']));
  });

  it('assigns candidates to stable source-module owners without building an import graph', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    const entryModule = path.join(sourceRoot, 'main.ts');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'nested', 'FeatureB.vue');
    fs.writeFileSync(entryModule, "const target = './FeatureA.vue'; const decoy = 'text-red-500'; import(target);\n");
    fs.writeFileSync(featureA, '<template><div class="bg-red-500" tw-class="underline p-2">A</div></template>\n');
    fs.mkdirSync(path.dirname(featureB), { recursive: true });
    fs.writeFileSync(featureB, '<template><div tw-class="underline italic">B</div></template>\n');

    const analysis = await analyzeSourceModules({
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
  });

  it('reports Vue script macro candidates at file-relative locations with unique group IDs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
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

    const analysis = await analyzeSourceModules({
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
  });

  it('collects candidates from Vue TSX script blocks with JSX syntax intact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
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

    const analysis = await analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'source-module',
      cache: createSourceModuleAnalysisCache(),
    });

    expect(analysis.candidateOwners.get('p-4')).toEqual(new Set(['module:src/TsxMacro.vue']));
  });

  it('reports same-line Vue template candidates at absolute source locations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    const component = path.join(sourceRoot, 'SameLine.vue');
    fs.writeFileSync(component, '<template><div tw-class="p-2 m-1" /></template>\n');

    const analysis = await analyzeSourceModules({
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
  });

  it('keeps file ordering deterministic and invalidates changed, deleted, and excluded cache entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    const cache = createSourceModuleAnalysisCache();
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
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

    const initial = await analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'single-css',
      cache,
    });
    expect(initial.files).toEqual([first, path.join(sourceRoot, 'UnrelatedBroken.ts'), second]);
    expect([...initial.candidateOwners.keys()].sort()).toEqual(['p-1', 'p-2']);

    fs.writeFileSync(first, '<template><div tw-class="m-1" /></template>\n');
    fs.rmSync(second);
    const updated = await analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'single-css',
      cache,
    });

    expect(updated.files).toEqual([first, path.join(sourceRoot, 'UnrelatedBroken.ts')]);
    expect([...updated.candidateOwners.keys()]).toEqual(['m-1']);
    expect(cache.has(second)).toBe(false);

    const renamed = path.join(sourceRoot, 'nested', 'Renamed.vue');
    fs.renameSync(first, renamed);
    const afterRename = await analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'source-module',
      cache,
    });
    expect(afterRename.files).toEqual([path.join(sourceRoot, 'UnrelatedBroken.ts'), renamed]);
    expect(afterRename.candidateOwners.get('m-1')).toEqual(new Set(['module:src/nested/Renamed.vue']));
    expect(cache.has(first)).toBe(false);
  });

  it('bounds concurrent reads and preserves analysis order when a batch finishes in reverse', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot);
    const files = Array.from({ length: 65 }, (_, index) => path.join(sourceRoot, `${String(index).padStart(2, '0')}.ts`));
    for (const [index, file] of files.entries()) {
      fs.writeFileSync(file, `import { tw } from 'virtual:naidan-tailwind'; export const value = tw('p-[${index}px]');`);
    }
    const originalRead = fs.promises.readFile;
    const pendingReads = new Map<string, () => void>();
    const completionOrder: string[] = [];
    let holdReads = true;
    let activeReads = 0;
    let maxActiveReads = 0;
    using reads = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        const source = await Reflect.apply(originalRead, fs.promises, args) as Awaited<ReturnType<typeof originalRead>>;
        const file = String(args[0]);
        if (holdReads) {
          await new Promise<void>((resolve) => pendingReads.set(file, resolve));
        }
        completionOrder.push(file);
        return source;
      } finally {
        activeReads -= 1;
      }
    });
    const cache = createSourceModuleAnalysisCache();
    const pending = analyzeSourceModules({ projectRoot: root, sourceRoot, ownershipMode: 'source-module', cache });
    await using _settleReads = {
      async [Symbol.asyncDispose]() {
        holdReads = false;
        for (const release of pendingReads.values()) {
          release();
        }
        await pending;
      },
    };
    for (const size of [32, 32, 1]) {
      await vi.waitFor(() => expect(pendingReads.size).toBe(size));
      const batch = [...pendingReads].sort(([left], [right]) => right.localeCompare(left));
      pendingReads.clear();
      for (const [, release] of batch) {
        release();
      }
    }
    const cold = await pending;
    holdReads = false;
    expect(maxActiveReads).toBe(32);
    expect(activeReads).toBe(0);
    expect(completionOrder.slice(0, 32)).toEqual(files.slice(0, 32).reverse());
    expect(cold.files).toEqual(files);
    expect(cold.candidateGroups.map(({ filename }) => filename)).toEqual(files);
    expect(cold.cssOwners.map(({ root: ownerRoot }) => ownerRoot)).toEqual(files);

    const warm = await analyzeSourceModules({ projectRoot: root, sourceRoot, ownershipMode: 'source-module', cache });
    expect(warm).toEqual(cold);
    expect(reads).toHaveBeenCalledTimes(files.length * 2);
  });

  it('preserves diagnostic order ahead of later read failures and propagates the original read error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot);
    const first = path.join(sourceRoot, 'A.vue');
    const second = path.join(sourceRoot, 'B.ts');
    fs.writeFileSync(first, '<template><div tw-content-class="p-2" /></template>');
    fs.writeFileSync(second, 'export const value = true;');
    const readError = Object.assign(new Error('source is unreadable'), { code: 'EACCES' });
    const originalRead = fs.promises.readFile;
    using _reads = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === second) {
        throw readError;
      }
      return Reflect.apply(originalRead, fs.promises, args) as ReturnType<typeof originalRead>;
    });
    const cache = createSourceModuleAnalysisCache();
    await expect(analyzeSourceModules({ projectRoot: root, sourceRoot, ownershipMode: 'source-module', cache }))
      .rejects.toThrow(/A\.vue:1:16 Unknown Tailwind class attribute/u);

    fs.writeFileSync(first, '<template><div tw-class="p-2" /></template>');
    await expect(analyzeSourceModules({ projectRoot: root, sourceRoot, ownershipMode: 'source-module', cache }))
      .rejects.toBe(readError);
  });

  it('removes cached candidates when a file disappears after enumeration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot);
    const file = path.join(sourceRoot, 'Feature.vue');
    fs.writeFileSync(file, '<template><div tw-class="p-2" /></template>');
    const cache = createSourceModuleAnalysisCache();
    await analyzeSourceModules({ projectRoot: root, sourceRoot, ownershipMode: 'source-module', cache });
    const missing = Object.assign(new Error('source disappeared'), { code: 'ENOENT' });
    using _reads = vi.spyOn(fs.promises, 'readFile').mockRejectedValue(missing);

    const analysis = await analyzeSourceModules({ projectRoot: root, sourceRoot, ownershipMode: 'source-module', cache });
    expect(analysis.files).toEqual([file]);
    expect(analysis.candidateGroups).toEqual([]);
    expect(cache.has(file)).toBe(false);

    const absentRoot = await analyzeSourceModules({
      projectRoot: root,
      sourceRoot: path.join(root, 'missing'),
      ownershipMode: 'source-module',
      cache,
    });
    expect(absentRoot.files).toEqual([]);
  });

  it('reports Vue compiler errors using absolute SFC coordinates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'Invalid.vue'),
      '<template><div tw-content-class="p-2" /></template>\n',
    );

    await expect(analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'single-css',
      cache: createSourceModuleAnalysisCache(),
    })).rejects.toThrow(/Invalid\.vue:1:16 Unknown Tailwind class attribute tw-content-class/u);
  });

  it('reports Vue script macro errors using absolute SFC coordinates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'InvalidMacro.vue'),
      `<script setup lang="ts">import { tw } from 'virtual:naidan-tailwind'; const value = tw(dynamicValue);</script><template><div /></template>
`,
    );

    await expect(analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'single-css',
      cache: createSourceModuleAnalysisCache(),
    })).rejects.toThrow(/InvalidMacro\.vue:1:85 tw\(\) requires exactly one string literal/u);
  });

  it('rejects external Vue templates instead of silently omitting their candidates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'External.vue'),
      '<template src="./External.html"></template>\n',
    );
    await expect(analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'source-module',
      cache: createSourceModuleAnalysisCache(),
    })).rejects.toThrow(/External Vue template src files are not supported/u);

    fs.writeFileSync(
      path.join(sourceRoot, 'External.vue'),
      '<template lang="pug">div.p-2</template>\n',
    );
    await expect(analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'source-module',
      cache: createSourceModuleAnalysisCache(),
    })).rejects.toThrow(/Unsupported Vue template language "pug"/u);
  });

  it('validates unreachable source modules with the same macro and template rules as transformed modules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-analysis-'));
    const sourceRoot = path.join(root, 'src');
    using _cleanupResource = {
      [Symbol.dispose]() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    fs.mkdirSync(sourceRoot, { recursive: true });
    const entryModule = path.join(sourceRoot, 'main.ts');
    fs.writeFileSync(entryModule, 'export const main = true;\n');
    fs.writeFileSync(path.join(sourceRoot, 'InvalidMacro.ts'), [
      "import { tw } from 'virtual:naidan-tailwind';",
      'tw(className);',
      '',
    ].join('\n'));

    await expect(analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'source-module',
      cache: createSourceModuleAnalysisCache(),
    })).rejects.toThrow(/tw\(\) requires exactly one string literal/u);

    fs.rmSync(path.join(sourceRoot, 'InvalidMacro.ts'));
    fs.writeFileSync(
      path.join(sourceRoot, 'InvalidAttribute.vue'),
      '<template><div tw-content-class="p-2" /></template>\n',
    );
    await expect(analyzeSourceModules({
      projectRoot: root,
      sourceRoot,
      ownershipMode: 'source-module',
      cache: createSourceModuleAnalysisCache(),
    })).rejects.toThrow(/Unknown Tailwind class attribute tw-content-class/u);
  });
});
