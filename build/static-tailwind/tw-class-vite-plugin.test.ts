import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCssRegistrationBundleIntegrity, createTwClassVitePlugin } from './tw-class-vite-plugin';

const temporaryDirectories: string[] = [];

type HookHandler<TArguments extends unknown[], TResult> = (...arguments_: TArguments) => TResult;

function getHookHandler<TArguments extends unknown[], TResult>({ hook, name }: {
  hook: unknown,
  name: string,
}): HookHandler<TArguments, TResult> {
  if (typeof hook === 'function') return hook as HookHandler<TArguments, TResult>;
  if (typeof hook === 'object' && hook !== null && 'handler' in hook && typeof hook.handler === 'function') {
    return hook.handler as HookHandler<TArguments, TResult>;
  }
  throw new TypeError(`Expected ${name} to be a callable Vite hook.`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeFile({ root, relativePath, content }: {
  root: string,
  relativePath: string,
  content: string,
}): void {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-static-tailwind-hmr-'));
  temporaryDirectories.push(root);
  fs.symlinkSync(path.resolve(import.meta.dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFile({
    root,
    relativePath: 'package.json',
    content: JSON.stringify({ devDependencies: { tailwindcss: '4.3.2' } }),
  });
  writeFile({ root, relativePath: 'src/style.css', content: '@import "tailwindcss" source(none);\n' });
  writeFile({
    root,
    relativePath: 'src/main.ts',
    content: `export const loadA = () => import('./FeatureA.vue');\nexport const loadB = () => import('./FeatureB.vue');\n`,
  });
  writeFile({ root, relativePath: 'src/FeatureA.vue', content: '<template><div tw-class="p-2">A</div></template>\n' });
  writeFile({ root, relativePath: 'src/FeatureB.vue', content: '<template><div tw-class="text-blue-500">B</div></template>\n' });
  return root;
}

async function createServeHarness({ root }: { root: string }) {
  const sourceRoot = path.join(root, 'src');
  const plugin = createTwClassVitePlugin({
    projectRoot: root,
    sourceRoot,
    entryModule: path.join(sourceRoot, 'main.ts'),
    tailwindCssPath: path.join(sourceRoot, 'style.css'),
    debugOutputDirectory: undefined,
    outputMode: 'split',
    cssPlanning: 'enabled',
    maxSplitCssGroups: undefined,
  });
  const configResolved = getHookHandler<[unknown], void | Promise<void>>({
    hook: plugin.configResolved,
    name: 'configResolved',
  });
  await configResolved.call({} as never, { command: 'serve' });
  const buildStart = getHookHandler<[unknown], void | Promise<void>>({
    hook: plugin.buildStart,
    name: 'buildStart',
  });
  await buildStart.call({ info() {} } as never, {});
  const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
    hook: plugin.hotUpdate,
    name: 'hotUpdate',
  });
  return { hotUpdate, plugin, sourceRoot };
}

function createHotUpdateContext({ environmentName, reloads, sentPayloads, onSend }: {
  environmentName: string;
  reloads: unknown[];
  sentPayloads: unknown[];
  onSend: (() => void) | undefined;
}) {
  return {
    environment: {
      name: environmentName,
      moduleGraph: {
        getModuleById() {
          return undefined;
        },
        getModulesByFile() {
          return undefined;
        },
      },
      async reloadModule(module: unknown) {
        reloads.push(module);
      },
      hot: {
        send(payload: unknown) {
          sentPayloads.push(payload);
          onSend?.();
        },
      },
    },
  };
}

describe('static Tailwind Vite plugin configuration', () => {
  function optionsForRoot({ root }: { root: string }) {
    const sourceRoot = path.join(root, 'src');
    return {
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split' as const,
      cssPlanning: 'enabled' as const,
      maxSplitCssGroups: undefined,
    };
  }

  it('rejects unknown planning modes and invalid group limits immediately', () => {
    const root = createFixture();
    const options = optionsForRoot({ root });
    expect(() => createTwClassVitePlugin({
      ...options,
      cssPlanning: 'unexpected' as 'enabled',
    })).toThrow(/Unknown CSS planning mode/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      maxSplitCssGroups: 1.5,
    })).toThrow(/maxSplitCssGroups must be a non-negative integer/u);
  });

  it('rejects destructive debug output directories before buildStart can clear them', () => {
    const root = createFixture();
    const options = optionsForRoot({ root });
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: root,
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(root, 'src', 'debug-tailwind'),
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(root, 'dist'),
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(path.dirname(root), 'outside-debug-tailwind'),
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-static-tailwind-debug-outside-'));
    temporaryDirectories.push(outsideDirectory);
    const linkedDist = path.join(root, 'dist-linked');
    fs.symlinkSync(
      outsideDirectory,
      linkedDist,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(linkedDist, 'debug-tailwind'),
    })).toThrow(/must not traverse symbolic links/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(root, 'dist', 'debug-tailwind'),
    })).not.toThrow();
  });

  it('fails fast when required source paths are missing or have the wrong type', () => {
    const root = createFixture();
    const options = optionsForRoot({ root });
    expect(() => createTwClassVitePlugin({
      ...options,
      sourceRoot: path.join(root, 'missing-source'),
    })).toThrow(/sourceRoot does not exist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      entryModule: path.join(root, 'src'),
    })).toThrow(/entryModule must be a file/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      tailwindCssPath: path.join(root, 'missing.css'),
    })).toThrow(/tailwindCssPath does not exist/u);
  });
});

describe('static Tailwind Vite plugin owner registration', () => {
  it('shares one registration when an owner filename contains the previous delimiter character', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const pipeFeature = path.join(sourceRoot, 'Feature|A.vue');
    fs.renameSync(path.join(sourceRoot, 'FeatureA.vue'), pipeFeature);
    fs.writeFileSync(
      path.join(sourceRoot, 'main.ts'),
      `export const loadA = () => import('./Feature|A.vue');
export const loadB = () => import('./FeatureB.vue');
`,
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'FeatureB.vue'),
      '<template><div tw-class="p-2">B</div></template>\n',
    );
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'build' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const imports = plugin.api.getImportsByModule();
    const pipeImports = imports.get(pipeFeature) ?? [];
    const otherImports = imports.get(path.join(sourceRoot, 'FeatureB.vue')) ?? [];
    expect(pipeImports).toHaveLength(1);
    expect(otherImports).toEqual(pipeImports);
    expect(pipeImports[0]).toMatch(/^virtual:naidan-tailwind-css-module\/[a-f0-9]{64}\.js$/u);
  });
});

describe('static Tailwind Vite plugin source transform gating', () => {
  it('rejects macro use outside the production source-analysis boundary', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const transform = getHookHandler<[string, string], unknown | Promise<unknown>>({
      hook: plugin.transform,
      name: 'transform',
    });
    const macroSource = `import { tw } from 'virtual:naidan-tailwind'; tw('p-2');`;

    expect(() => transform.call({} as never, macroSource, path.join(root, 'shared.ts')))
      .toThrow(/only supported in production source files covered by static analysis/u);
    expect(() => transform.call({} as never, macroSource, path.join(sourceRoot, 'Ignored.test.ts')))
      .toThrow(/only supported in production source files covered by static analysis/u);
    expect(() => transform.call(
      {} as never,
      '<template><div tw-class="p-2" /></template>',
      path.join(root, 'Outside.vue'),
    )).toThrow(/Vue Tailwind attributes are only supported in production source files covered by static analysis/u);
    expect(() => transform.call(
      {} as never,
      '<template><div tw-class="p-2" /></template>',
      path.join(sourceRoot, 'Ignored.test.vue'),
    )).toThrow(/Vue Tailwind attributes are only supported in production source files covered by static analysis/u);
    expect(transform.call(
      {} as never,
      `const fixtureValue = 'virtual:naidan-tailwind';`,
      path.join(root, 'fixture-data.ts'),
    )).toBeNull();
    expect(transform.call(
      {} as never,
      '<template><div>tw-class is only text here</div></template>',
      path.join(root, 'fixture-data.vue'),
    )).toBeNull();
  });

  it('does not parse unrelated modules that have no macro or CSS registration imports', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'disabled',
      maxSplitCssGroups: undefined,
    });
    const transform = getHookHandler<[string, string], unknown | Promise<unknown>>({
      hook: plugin.transform,
      name: 'transform',
    });

    expect(transform.call({} as never, 'const deliberatelyInvalid = <;', path.join(sourceRoot, 'Unrelated.ts'))).toBeNull();
  });

  it('parses JavaScript JSX and TypeScript TSX modules with their matching syntax', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'disabled',
      maxSplitCssGroups: undefined,
    });
    const transform = getHookHandler<[string, string], unknown | Promise<unknown>>({
      hook: plugin.transform,
      name: 'transform',
    });
    const fixtures = [
      {
        filename: path.join(sourceRoot, 'View.jsx'),
        source: `import { tw } from 'virtual:naidan-tailwind';\nexport const view = <div className={tw('p-2')} />;\n`,
        candidate: 'p-2',
      },
      {
        filename: path.join(sourceRoot, 'View.tsx'),
        source: `import { tw } from 'virtual:naidan-tailwind';\nexport const view: JSX.Element = <div className={tw('p-4')} />;\n`,
        candidate: 'p-4',
      },
    ];

    for (const fixture of fixtures) {
      const result = await transform.call({} as never, fixture.source, fixture.filename) as {
        code: string,
      };
      expect(result.code).toContain(JSON.stringify(fixture.candidate));
      expect(result.code).toContain('<div className=');
      expect(result.code).not.toContain('virtual:naidan-tailwind');
    }
  });
});

describe('static Tailwind Vite plugin build diagnostics', () => {
  it('replaces stale debug output with the current analysis and ownership plan', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const debugOutputDirectory = path.join(root, 'dist/debug-tailwind');
    const staleFile = path.join(debugOutputDirectory, 'stale.json');
    fs.mkdirSync(debugOutputDirectory, { recursive: true });
    fs.writeFileSync(staleFile, '{}\n');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory,
      outputMode: 'single',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'build' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    expect(fs.existsSync(staleFile)).toBe(false);
    const writeBundle = getHookHandler<[], void | Promise<void>>({
      hook: plugin.writeBundle,
      name: 'writeBundle',
    });
    await writeBundle.call({} as never);
    const sourceAnalysis = JSON.parse(fs.readFileSync(
      path.join(debugOutputDirectory, 'source-analysis.json'),
      'utf8',
    )) as { candidateOwners: Record<string, string[]> };
    const ownershipPlan = JSON.parse(fs.readFileSync(
      path.join(debugOutputDirectory, 'ownership-plan.json'),
      'utf8',
    )) as { candidates: string[] };
    const groupManifest = JSON.parse(fs.readFileSync(
      path.join(debugOutputDirectory, 'css-groups/groups.json'),
      'utf8',
    )) as { groups: Record<string, unknown> };
    expect(sourceAnalysis.candidateOwners).toHaveProperty('p-2');
    expect(ownershipPlan.candidates).toContain('text-blue-500');
    expect(Object.keys(groupManifest.groups).length).toBeGreaterThan(0);
  });
});

describe('static Tailwind Vite plugin HMR ownership', () => {
  it('retires the private CSS module when a candidate becomes shared', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const beforeImports = plugin.api.getImportsByModule();
    const beforeA = beforeImports.get(featureA) ?? [];
    const beforeB = beforeImports.get(featureB) ?? [];
    const privateA = beforeA.find((id) => !beforeB.includes(id));
    expect(privateA).toBeDefined();
    if (privateA === undefined) {
      throw new TypeError('Expected Feature A to own a private CSS module before the update.');
    }

    fs.writeFileSync(featureB, '<template><div tw-class="text-blue-500"><span tw-class="p-2">B</span></div></template>\n');
    const reloads: unknown[] = [];
    const customMessages: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile(filename: string) {
            return new Set([{ id: filename }]);
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
        },
        hot: { send(message: unknown) {
          customMessages.push(message);
        } },
      },
    };
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    await hotUpdate.call(context as never, {
      file: featureB,
      timestamp: Date.now(),
      modules: [],
    });

    const afterImports = plugin.api.getImportsByModule();
    const shared = (afterImports.get(featureA) ?? []).filter((id) => (afterImports.get(featureB) ?? []).includes(id));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared).not.toContain(privateA);
    expect(customMessages).toContainEqual({
      type: 'custom',
      event: 'naidan-tailwind:retire-css',
      data: { moduleIds: expect.arrayContaining([`\0${privateA}`]) },
    });
    expect(reloads.length).toBeGreaterThan(0);
  });

  it('retires shared and private registrations as ownership shrinks and disappears', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    fs.writeFileSync(featureB, '<template><div tw-class="text-blue-500 p-2">B</div></template>\n');

    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const beforeImports = plugin.api.getImportsByModule();
    const sharedId = (beforeImports.get(featureA) ?? []).find((id) => (
      id.startsWith('virtual:naidan-tailwind-css-module/')
      && (beforeImports.get(featureB) ?? []).includes(id)
    ));
    expect(sharedId).toBeDefined();
    if (sharedId === undefined) throw new TypeError('Expected one shared CSS registration.');

    const customMessages: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile(filename: string) {
            return new Set([{ id: filename }]);
          },
        },
        async reloadModule() {},
        hot: { send(message: unknown) {
          customMessages.push(message);
        } },
      },
    };
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });

    fs.writeFileSync(featureB, '<template><div tw-class="text-blue-500">B</div></template>\n');
    await hotUpdate.call(context as never, {
      file: featureB,
      timestamp: 1001,
      modules: [],
    });
    const privateImports = plugin.api.getImportsByModule();
    const privateA = (privateImports.get(featureA) ?? []).find((id) => (
      id.startsWith('virtual:naidan-tailwind-css-module/')
      && !(privateImports.get(featureB) ?? []).includes(id)
    ));
    expect(privateA).toBeDefined();
    expect(customMessages).toContainEqual({
      type: 'custom',
      event: 'naidan-tailwind:retire-css',
      data: { moduleIds: expect.arrayContaining([`\0${sharedId}`]) },
    });

    if (privateA === undefined) throw new TypeError('Expected one private Feature A CSS registration.');
    fs.writeFileSync(featureA, '<template><div>A</div></template>\n');
    await hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 1002,
      modules: [],
    });
    expect(plugin.api.getImportsByModule().get(featureA) ?? []).not.toContain(privateA);
    expect(customMessages).toContainEqual({
      type: 'custom',
      event: 'naidan-tailwind:retire-css',
      data: { moduleIds: expect.arrayContaining([`\0${privateA}`]) },
    });
  });

  it('does not replay a completed duplicate HMR result after the same registration becomes active again', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    fs.writeFileSync(featureB, '<template><div tw-class="p-2">B</div></template>\n');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const customMessages: { data?: { moduleIds?: string[] } }[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: { send(message: { data?: { moduleIds?: string[] } }) {
          customMessages.push(message);
        } },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5000, modules: [] });
    fs.writeFileSync(featureB, '<template><div tw-class="p-4">B</div></template>\n');
    await hotUpdate.call(context as never, { file: featureB, timestamp: 5001, modules: [] });

    const activeSharedId = (plugin.api.getImportsByModule().get(featureA) ?? []).find((id) => (
      id.startsWith('virtual:naidan-tailwind-css-module/')
      && (plugin.api.getImportsByModule().get(featureB) ?? []).includes(id)
    ));
    expect(activeSharedId).toBeDefined();
    if (activeSharedId === undefined) throw new TypeError('Expected a reactivated shared registration.');

    customMessages.length = 0;
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5000, modules: [] });

    expect(customMessages.flatMap(({ data }) => data?.moduleIds ?? [])).not.toContain(`\0${activeSharedId}`);
  });

  it('replans different files even when Vite reports the same HMR timestamp', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: { send() {} },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 2000, modules: [] });
    fs.writeFileSync(featureB, '<template><div tw-class="m-4">B</div></template>\n');
    await hotUpdate.call(context as never, { file: featureB, timestamp: 2000, modules: [] });

    expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    expect(plugin.api.getPlan()?.candidates).toContain('m-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('text-blue-500');
  });


  it('serializes overlapping HMR replans so an older slow plan cannot overwrite the newest state', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: { send() {} },
      },
    };

    const slowCandidates = Array.from({ length: 240 }, (_, index) => `p-[${index + 1}px]`).join(' ');
    fs.writeFileSync(featureA, `<template><div tw-class="${slowCandidates}">A</div></template>\n`);
    const olderRefresh = hotUpdate.call(context as never, { file: featureA, timestamp: 3000, modules: [] });

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    fs.writeFileSync(featureB, '<template><div tw-class="m-4">B</div></template>\n');
    const newerRefresh = hotUpdate.call(context as never, { file: featureB, timestamp: 3001, modules: [] });
    await Promise.all([olderRefresh, newerRefresh]);

    expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    expect(plugin.api.getPlan()?.candidates).toContain('m-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-[240px]');
    expect(plugin.api.getPlan()?.candidates).not.toContain('text-blue-500');
  });

  it('does not deduplicate distinct same-file edits that share an HMR timestamp', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: { send() {} },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 4000, modules: [] });
    fs.writeFileSync(featureA, '<template><div tw-class="m-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 4000, modules: [] });

    expect(plugin.api.getPlan()?.candidates).toContain('m-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-4');
  });
  it('skips the sequential SSR environment invocation after the client refresh', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const clientReloads: unknown[] = [];
    const clientPayloads: unknown[] = [];
    const clientContext = createHotUpdateContext({
      environmentName: 'client',
      reloads: clientReloads,
      sentPayloads: clientPayloads,
      onSend: undefined,
    });
    const ssrReloads: unknown[] = [];
    const ssrPayloads: unknown[] = [];
    const ssrContext = createHotUpdateContext({
      environmentName: 'ssr',
      reloads: ssrReloads,
      sentPayloads: ssrPayloads,
      onSend: undefined,
    });

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    const options = { file: featureA, timestamp: 5000, modules: [] };
    await hotUpdate.call(clientContext as never, options);
    const planAfterClientRefresh = plugin.api.getPlan();
    await hotUpdate.call(ssrContext as never, options);

    expect(plugin.api.getPlan()).toBe(planAfterClientRefresh);
    expect(ssrReloads).toEqual([]);
    expect(ssrPayloads).toEqual([]);
  });

  it('skips source files outside the static Tailwind analysis boundary', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const ignoredFile = path.join(sourceRoot, 'test-tmp', 'Ignored.vue');
    const reloads: unknown[] = [];
    const sentPayloads: unknown[] = [];
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads,
      sentPayloads,
      onSend: undefined,
    });
    const planBeforeIgnoredChange = plugin.api.getPlan();

    fs.mkdirSync(path.dirname(ignoredFile), { recursive: true });
    fs.writeFileSync(ignoredFile, '<template><div tw-class="p-8">ignored</div></template>\n');
    await hotUpdate.call(context as never, { file: ignoredFile, timestamp: 5001, modules: [] });

    expect(plugin.api.getPlan()).toBe(planBeforeIgnoredChange);
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-8');
    expect(reloads).toEqual([]);
    expect(sentPayloads).toEqual([]);
  });

  it('replans when a local stylesheet dependency changes', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'theme.css');
    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./theme.css";
`);
    fs.writeFileSync(themePath, '.local-theme-marker { color: red; }\n');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const initialPlan = plugin.api.getPlan();
    const reloads: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
        },
        hot: { send() {} },
      },
    };

    fs.writeFileSync(themePath, '.local-theme-marker { color: blue; }\n');
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5009, modules: [] });

    expect(plugin.api.getPlan()).not.toBe(initialPlan);
    expect(plugin.api.getPlan()?.baselineCss).not.toBe(initialPlan?.baselineCss);
    expect(reloads.length).toBeGreaterThan(0);
  });

  it('records local stylesheet dependencies and skips unchanged dependency events', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'theme.css');
    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./theme.css";
`);
    fs.writeFileSync(themePath, '.local-theme-marker { color: red; }\n');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const initialPlan = plugin.api.getPlan();

    expect(initialPlan?.stylesheetDependencies).toContain(themePath);
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5017, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);

    const touchedAt = new Date(Date.now() + 1000);
    fs.utimesSync(themePath, touchedAt, touchedAt);
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5018, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);
  });

  it('skips companion stylesheet events after the entry stylesheet already applied them', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'theme.css');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const initialPlan = plugin.api.getPlan();

    fs.writeFileSync(themePath, '.local-theme-marker { color: red; }\n');
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5019, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);

    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./theme.css";
`);
    await hotUpdate.call(context as never, { file: stylePath, timestamp: 5020, modules: [] });
    const planWithTheme = plugin.api.getPlan();
    expect(planWithTheme).not.toBe(initialPlan);
    expect(planWithTheme?.stylesheetDependencies).toContain(themePath);

    await hotUpdate.call(context as never, { file: themePath, timestamp: 5021, modules: [] });
    expect(plugin.api.getPlan()).toBe(planWithTheme);

    fs.writeFileSync(stylePath, '@import "tailwindcss" source(none);\n');
    fs.rmSync(themePath);
    await hotUpdate.call(context as never, { file: stylePath, timestamp: 5022, modules: [] });
    const planWithoutTheme = plugin.api.getPlan();
    expect(planWithoutTheme).not.toBe(planWithTheme);
    expect(planWithoutTheme?.stylesheetDependencies).not.toContain(themePath);

    await hotUpdate.call(context as never, { file: themePath, timestamp: 5023, modules: [] });
    expect(plugin.api.getPlan()).toBe(planWithoutTheme);
  });

  it('recovers when a missing stylesheet dependency is created after the entry update fails', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'late-theme.css');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const validPlan = plugin.api.getPlan();

    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./late-theme.css";
`);
    await expect(hotUpdate.call(context as never, {
      file: stylePath,
      timestamp: 5027,
      modules: [],
    })).rejects.toThrow(/late-theme\.css/u);
    expect(plugin.api.getPlan()).toBe(validPlan);

    fs.writeFileSync(themePath, '.late-theme-marker { color: purple; }\n');
    await expect(hotUpdate.call(context as never, {
      file: themePath,
      timestamp: 5028,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).not.toBe(validPlan);
    expect(plugin.api.getPlan()?.stylesheetDependencies).toContain(themePath);
    const recoveredPlan = plugin.api.getPlan();

    const unrelatedStylesheet = path.join(sourceRoot, 'unrelated-after-recovery.css');
    fs.writeFileSync(unrelatedStylesheet, '.unrelated { color: orange; }\n');
    await expect(hotUpdate.call(context as never, {
      file: unrelatedStylesheet,
      timestamp: 5029,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).toBe(recoveredPlan);
  });

  it('skips same-content saves and mtime-only changes after a successful plan', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const initialPlan = plugin.api.getPlan();

    fs.writeFileSync(featureA, '<template><div tw-class="p-2">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5010, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);

    const touchedAt = new Date(Date.now() + 1000);
    fs.utimesSync(featureA, touchedAt, touchedAt);
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5011, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);
  });

  it('runs a trailing refresh when a source reverts while an older refresh is active', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const slowCandidates = Array.from({ length: 240 }, (_, index) => `p-[${index + 1}px]`).join(' ');

    fs.writeFileSync(featureA, `<template><div tw-class="${slowCandidates}">A</div></template>\n`);
    const olderRefresh = hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5004,
      modules: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    fs.writeFileSync(featureA, '<template><div tw-class="p-2">A</div></template>\n');
    const revertingRefresh = hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5005,
      modules: [],
    });
    await Promise.all([olderRefresh, revertingRefresh]);

    expect(plugin.api.getPlan()?.candidates).toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-[240px]');
  });

  it('coalesces a synchronous deletion burst and applies the retirement result once', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const reloads: unknown[] = [];
    const sentPayloads: unknown[] = [];
    let planWhenRetirementWasSent: ReturnType<typeof plugin.api.getPlan>;
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads,
      sentPayloads,
      onSend() {
        planWhenRetirementWasSent = plugin.api.getPlan();
      },
    });

    fs.rmSync(featureA);
    const firstUpdate = hotUpdate.call(context as never, { file: featureA, timestamp: 5002, modules: [] });
    fs.rmSync(featureB);
    const secondUpdate = hotUpdate.call(context as never, { file: featureB, timestamp: 5003, modules: [] });
    await Promise.all([firstUpdate, secondUpdate]);

    expect(sentPayloads).toHaveLength(1);
    expect(plugin.api.getPlan()).toBe(planWhenRetirementWasSent);
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('text-blue-500');
  });

  it('converges to the renamed source file after delete and create notifications', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const previousFile = path.join(sourceRoot, 'FeatureA.vue');
    const renamedFile = path.join(sourceRoot, 'FeatureRenamed.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });

    fs.renameSync(previousFile, renamedFile);
    await Promise.all([
      hotUpdate.call(context as never, { file: previousFile, timestamp: 5012, modules: [] }),
      hotUpdate.call(context as never, { file: renamedFile, timestamp: 5013, modules: [] }),
    ]);

    expect(plugin.api.getPlan()?.candidates).toContain('p-2');
    expect(plugin.api.getImportsByModule().has(previousFile)).toBe(false);
    expect(plugin.api.getImportsByModule().has(renamedFile)).toBe(true);
  });

  it('keeps the last valid plan after a failed refresh and recovers on the next change', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const validPlan = plugin.api.getPlan();

    fs.writeFileSync(featureA, '<template><div tw-class="bg-reed-500">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5014,
      modules: [],
    })).rejects.toThrow(/bg-reed-500/u);
    expect(plugin.api.getPlan()).toBe(validPlan);

    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5015,
      modules: [],
    })).rejects.toThrow(/bg-reed-500/u);
    expect(plugin.api.getPlan()).toBe(validPlan);

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5016,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).not.toBe(validPlan);
    expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-2');
  });

  it('retries HMR application after a reload failure before committing the new input state', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const expectedError = new Error('reload failed');
    const reloads: unknown[] = [];
    let shouldFail = true;
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
          if (shouldFail) {
            shouldFail = false;
            throw expectedError;
          }
        },
        hot: { send() {} },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5024,
      modules: [],
    })).rejects.toBe(expectedError);
    const reloadCountAfterFailure = reloads.length;
    expect(plugin.api.getPlan()?.candidates).toContain('p-4');

    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5025,
      modules: [],
    })).resolves.toEqual([]);
    expect(reloads.length).toBeGreaterThan(reloadCountAfterFailure);
    const appliedPlan = plugin.api.getPlan();
    const reloadCountAfterRecovery = reloads.length;

    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5026,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).toBe(appliedPlan);
    expect(reloads).toHaveLength(reloadCountAfterRecovery);
  });

  it('reloads the global stylesheet when single-asset candidate CSS changes', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: stylePath,
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      outputMode: 'single',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    const styleModule = { id: stylePath };
    const reloads: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile(filename: string) {
            return filename === stylePath ? new Set([styleModule]) : undefined;
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
        },
        hot: { send() {} },
      },
    };
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    await hotUpdate.call(context as never, {
      file: featureA,
      timestamp: Date.now(),
      modules: [],
    });

    expect(reloads).toContain(styleModule);
  });
});

describe('static Tailwind production bundle integrity', () => {
  const projectRoot = '/fixture';
  const entryModule = '/fixture/src/main.ts';
  const lazyModule = '/fixture/src/Lazy.vue';
  const registrationPublicId = 'virtual:naidan-tailwind-css-module/group.js';
  const registrationResolvedId = `\0${registrationPublicId}`;
  const initialRegistrationResolvedId = '\0virtual:naidan-tailwind-css-module/initial.js';
  const runtimeResolvedId = '\0virtual:naidan-tailwind-css-runtime';
  const moduleSourceByResolvedId = new Map([[registrationResolvedId, 'registration source']]);
  const registrationDependenciesByResolvedId = new Map<string, string[]>();

  function bundleWith({
    includeRegistration,
    includeRuntime,
    duplicateRegistration = false,
    registrationInOrphanChunk = false,
  }: {
    includeRegistration: boolean,
    includeRuntime: boolean,
    duplicateRegistration?: boolean,
    registrationInOrphanChunk?: boolean,
  }) {
    const entryModules: Record<string, unknown> = { [entryModule]: {} };
    const lazyModules: Record<string, unknown> = { [lazyModule]: {} };
    if (includeRegistration) lazyModules[registrationResolvedId] = {};
    if (includeRuntime) lazyModules[runtimeResolvedId] = {};
    const bundle: Record<string, {
      type: string,
      fileName: string,
      imports: string[],
      dynamicImports?: string[],
      isEntry?: boolean,
      modules: Record<string, unknown>,
    }> = {
      'entry.js': {
        type: 'chunk',
        fileName: 'entry.js',
        imports: [],
        dynamicImports: ['lazy.js'],
        isEntry: true,
        modules: entryModules,
      },
      'lazy.js': {
        type: 'chunk',
        fileName: 'lazy.js',
        imports: [],
        modules: lazyModules,
      },
    };
    if (registrationInOrphanChunk) {
      delete lazyModules[registrationResolvedId];
      delete lazyModules[runtimeResolvedId];
      bundle['orphan.js'] = {
        type: 'chunk',
        fileName: 'orphan.js',
        imports: [],
        modules: {
          ...(includeRegistration ? { [registrationResolvedId]: {} } : {}),
          ...(includeRuntime ? { [runtimeResolvedId]: {} } : {}),
        },
      };
    }
    if (duplicateRegistration) {
      bundle['duplicate.js'] = {
        type: 'chunk',
        fileName: 'duplicate.js',
        imports: [],
        modules: { [registrationResolvedId]: {} },
      };
    }
    return bundle;
  }

  it('accepts one retained registration for each emitted owner module', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: true }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('treats a registration dependency as required by the same emitted owner graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'broker.js': {
          type: 'chunk',
          fileName: 'broker.js',
          imports: [],
          isEntry: true,
          modules: {
            [lazyModule]: {},
            [registrationResolvedId]: {},
            [initialRegistrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId: new Map([
        [registrationResolvedId, 'registration source'],
        [initialRegistrationResolvedId, 'initial source'],
      ]),
      registrationDependenciesByResolvedId: new Map([
        [registrationResolvedId, [initialRegistrationResolvedId]],
        [initialRegistrationResolvedId, []],
      ]),
    })).not.toThrow();
  });


  it('accepts registration modules promoted into the initial graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: {
            [entryModule]: {},
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: [],
          modules: { [lazyModule]: {} },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('accepts registration modules in a statically imported shared chunk', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: { [entryModule]: {} },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: ['./shared.js'],
          modules: { '/src/Lazy.vue?vue&type=script': {} },
        },
        'shared.js': {
          type: 'chunk',
          fileName: 'shared.js',
          imports: [],
          modules: {
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('does not treat another HTML entry as initial CSS for an unrelated owner graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'app.js': {
          type: 'chunk',
          fileName: 'app.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: { [entryModule]: {} },
        },
        'broker.js': {
          type: 'chunk',
          fileName: 'broker.js',
          imports: [],
          isEntry: true,
          modules: {
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: [],
          modules: { [lazyModule]: {} },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/not loaded with their owners/u);
  });

  it('rejects registration modules that are emitted outside the owner load graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({
        includeRegistration: true,
        includeRuntime: true,
        registrationInOrphanChunk: true,
      }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/not loaded with their owners/u);
  });

  it('does not match an absolute module outside the project by a shared path suffix', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: { [entryModule]: {} },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: [],
          modules: {
            '/other-project/src/Lazy.vue': {},
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/unexpected registrations/u);
  });

  it('ignores planned registrations whose owner module was tree-shaken', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': { type: 'chunk', modules: { [entryModule]: {} } },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('rejects registrations absent from the active plan and misplaced runtime modules', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: true }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId: new Map(),
      registrationDependenciesByResolvedId,
    })).toThrow(/missing from the active plan/u);

    const bundle = bundleWith({ includeRegistration: true, includeRuntime: false });
    bundle['orphan-runtime.js'] = {
      type: 'chunk',
      fileName: 'orphan-runtime.js',
      imports: [],
      modules: { [runtimeResolvedId]: {} },
    };
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle,
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/virtual:naidan-tailwind-css-runtime.*not loaded with lazy\.js/u);
  });

  it('rejects runtime emission when no retained registration requires it', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          isEntry: true,
          modules: { [entryModule]: {}, [runtimeResolvedId]: {} },
        },
      },
      projectRoot,
      importsByModule: new Map(),
      moduleSourceByResolvedId: new Map(),
      registrationDependenciesByResolvedId,
    })).toThrow(/runtime module emission count was 1, expected 0/u);
  });

  it('rejects missing, duplicated, and runtime-less production registrations', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: false, includeRuntime: false }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/missing registrations/u);

    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: true, duplicateRegistration: true }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/not emitted exactly once/u);

    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: false }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/runtime module emission count/u);
  });
});
