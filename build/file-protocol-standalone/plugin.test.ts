import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';

import { createNaidanStandalonePlugin } from './plugin.js';

const require = createRequire(import.meta.url);

function createOptions() {
  return {
    workers: [{
      name: 'test-worker',
      entry: '/tmp/naidan-test-worker.ts',
      virtualId: 'virtual:file-protocol-standalone/worker/test-worker',
    }],
    systemRuntimePath: '/tmp/system.min.js',
    sourceAudit: {
      mode: 'external' as const,
      evidence: 'focused test evidence',
    },
  };
}


function findPlugin(value: ReturnType<typeof createNaidanStandalonePlugin>, name: string): Plugin {
  const plugin = (value as Plugin[]).find(candidate => candidate.name === name);
  if (plugin === undefined) throw new Error(`Expected plugin: ${name}`);
  return plugin;
}

async function runBuildStart(plugin: Plugin): Promise<void> {
  const hook = plugin.buildStart;
  if (typeof hook !== 'function') throw new Error(`Expected buildStart hook on ${plugin.name}`);
  await hook.call({} as never, {} as never);
}


function runConfigResolved(plugin: Plugin, config: unknown): void {
  const hook = plugin.configResolved;
  if (typeof hook !== 'function') throw new Error(`Expected configResolved hook on ${plugin.name}`);
  hook.call({} as never, config as never);
}

async function runTransform(plugin: Plugin, code: string, id: string): Promise<void> {
  const hook = plugin.transform;
  if (typeof hook !== 'function') throw new Error(`Expected transform hook on ${plugin.name}`);
  await hook.call({} as never, code, id);
}

async function runGenerateBundle(plugin: Plugin, bundle: unknown): Promise<void> {
  const hook = plugin.generateBundle;
  if (typeof hook !== 'function') throw new Error(`Expected generateBundle hook on ${plugin.name}`);
  await hook.call({} as never, {} as never, bundle as never, false);
}

type WorkerCssModuleInfoFixture = Readonly<{
  isEntry: boolean;
  importedIds: string[];
  dynamicallyImportedIds: string[];
}>;

async function runWorkerCssGenerateBundle({
  moduleInfoEntries,
  bundle,
  diagnostics,
  allowWorkerOnlyCssAssets,
}: Readonly<{
  moduleInfoEntries: readonly (readonly [string, WorkerCssModuleInfoFixture])[];
  bundle: unknown;
  diagnostics: Record<string, unknown> | undefined;
  allowWorkerOnlyCssAssets: boolean;
}>): Promise<void> {
  const workerCssPolicy = findPlugin(
    createNaidanStandalonePlugin({
      ...createOptions(),
      diagnostics,
      policies: { allowWorkerOnlyCssAssets },
    }),
    'naidan-file-protocol-standalone-worker-css-guard',
  );
  const hook = workerCssPolicy.generateBundle;
  if (typeof hook !== 'function') throw new Error('Expected Worker CSS generateBundle hook');
  const moduleInfo = new Map<string, WorkerCssModuleInfoFixture>(moduleInfoEntries);
  await hook.call({
    getModuleIds: () => moduleInfo.keys(),
    getModuleInfo: (id: string) => moduleInfo.get(id) ?? null,
  } as never, {} as never, bundle as never, false);
}

function pluginNames(value: ReturnType<typeof createNaidanStandalonePlugin>): string[] {
  const plugins = value as Plugin[];
  return plugins.map(plugin => plugin.name);
}

describe('createNaidanStandalonePlugin', () => {
  it('exposes one factory while composing the release gate internally', () => {
    const names = pluginNames(createNaidanStandalonePlugin({
      ...createOptions(),
      releaseValidation: {
        outputDirectory: '/tmp/naidan-standalone-output',
        omitFileNames: ['robots.txt'],
        debugReportFile: '/tmp/naidan-standalone-debug.json',
        releaseReportFile: '/tmp/naidan-standalone-release.json',
      },
    }));

    expect(names).toContain('naidan-file-protocol-standalone-release-validation');
    expect(names.filter(name => name === 'naidan-file-protocol-standalone-release-validation')).toHaveLength(1);
  });

  it('rejects a non-relative Vite base before standalone output is generated', () => {
    const buildConfigPlugin = findPlugin(
      createNaidanStandalonePlugin(createOptions()),
      'naidan-file-protocol-standalone-build-config',
    );

    expect(() => runConfigResolved(buildConfigPlugin, {
      base: '/app/',
      build: { modulePreload: false, cssCodeSplit: true },
    })).toThrow('require a relative Vite base');
  });

  it('requires the Vite settings that keep file-protocol loading deterministic', () => {
    const buildConfigPlugin = findPlugin(
      createNaidanStandalonePlugin(createOptions()),
      'naidan-file-protocol-standalone-build-config',
    );

    expect(() => runConfigResolved(buildConfigPlugin, {
      base: './',
      build: { modulePreload: true, cssCodeSplit: true },
    })).toThrow('require build.modulePreload=false');

    expect(() => runConfigResolved(buildConfigPlugin, {
      base: './',
      build: { modulePreload: false, cssCodeSplit: false },
    })).toThrow('require build.cssCodeSplit=true');

    expect(() => runConfigResolved(buildConfigPlugin, {
      base: './',
      build: { modulePreload: false, cssCodeSplit: true },
    })).not.toThrow();
  });

  it('always composes SystemJS runtime validation into the standalone build', () => {
    const names = pluginNames(createNaidanStandalonePlugin(createOptions()));

    expect(names.filter(name => name === 'naidan-file-protocol-standalone-systemjs-runtime-validation')).toHaveLength(1);
  });

  it('validates the bundled SystemJS runtime and its exact source map before building', async () => {
    const plugins = createNaidanStandalonePlugin({
      ...createOptions(),
      systemRuntimePath: require.resolve('systemjs/dist/system.min.js'),
      systemRuntimeSourceMapPath: require.resolve('systemjs/dist/system.min.js.map'),
    });
    const validationPlugin = findPlugin(plugins, 'naidan-file-protocol-standalone-systemjs-runtime-validation');

    await expect(runBuildStart(validationPlugin)).resolves.toBeUndefined();
  });

  it('rejects release reports inside the standalone runtime output directory', () => {
    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      releaseValidation: {
        outputDirectory: '/tmp/naidan-standalone-output',
        debugReportFile: '/tmp/naidan-standalone-output/debug.json',
        releaseReportFile: '/tmp/naidan-release.json',
      },
    })).toThrow('debugReportFile must live outside');
  });

  it('does not create a release gate when release validation is not requested', () => {
    const names = pluginNames(createNaidanStandalonePlugin(createOptions()));

    expect(names).not.toContain('naidan-file-protocol-standalone-release-validation');
  });

  it('requires at least one Worker definition', () => {
    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      workers: [],
    })).toThrow('workers must be a non-empty array');
  });

  it('rejects incomplete and duplicate Worker definitions before Vite starts', () => {
    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      workers: [{ name: '', entry: '/tmp/worker.ts', virtualId: 'virtual:worker' }],
    })).toThrow('Each Worker requires name, entry, and virtualId');

    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      workers: [
        { name: 'duplicate', entry: '/tmp/worker-a.ts', virtualId: 'virtual:worker-a' },
        { name: 'duplicate', entry: '/tmp/worker-b.ts', virtualId: 'virtual:worker-b' },
      ],
    })).toThrow('Duplicate Worker name');

    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      workers: [
        { name: 'worker-a', entry: '/tmp/worker-a.ts', virtualId: 'virtual:duplicate' },
        { name: 'worker-b', entry: '/tmp/worker-b.ts', virtualId: 'virtual:duplicate' },
      ],
    })).toThrow('Duplicate Worker virtualId');


    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      workers: [
        { name: 'worker-a', entry: '/tmp/duplicate-entry.ts', virtualId: 'virtual:worker-a' },
        { name: 'worker-b', entry: '/tmp/duplicate-entry.ts', virtualId: 'virtual:worker-b' },
      ],
    })).toThrow('Duplicate Worker entry');
  });

  it('rejects invalid standalone startup options before Vite starts', () => {
    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      systemRuntimePath: '',
    })).toThrow('systemRuntimePath is required');

    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      startupSlowNoticeDelayMs: -1,
    })).toThrow('startupSlowNoticeDelayMs must be a non-negative finite number');

    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      startupSlowNoticeDelayMs: Number.NaN,
    })).toThrow('startupSlowNoticeDelayMs must be a non-negative finite number');
  });

  it('requires external source-audit evidence', () => {
    expect(() => createNaidanStandalonePlugin({
      ...createOptions(),
      sourceAudit: {
        mode: 'external',
        evidence: '   ',
      },
    })).toThrow('sourceAudit.evidence is required');
  });
  it('keeps cheap source-policy guards enabled with external audit evidence', () => {
    const names = pluginNames(createNaidanStandalonePlugin(createOptions()));

    expect(names).toContain('naidan-file-protocol-standalone-vite-worker-query-policy');
    expect(names).toContain('naidan-file-protocol-standalone-importscripts-assets');
    expect(names).not.toContain('naidan-file-protocol-standalone-worker-realm-global-guard');
  });

  it('adds the Worker-realm source audit only in inline mode', () => {
    const names = pluginNames(createNaidanStandalonePlugin({
      ...createOptions(),
      sourceAudit: { mode: 'inline' },
    }));

    expect(names).toContain('naidan-file-protocol-standalone-vite-worker-query-policy');
    expect(names).toContain('naidan-file-protocol-standalone-importscripts-assets');
    expect(names).toContain('naidan-file-protocol-standalone-worker-realm-global-guard');
  });

  it('enforces cheap source guards even when the expensive audit is external', async () => {
    const plugins = createNaidanStandalonePlugin(createOptions());
    const workerQueryPolicy = findPlugin(plugins, 'naidan-file-protocol-standalone-vite-worker-query-policy');
    const importScriptsPolicy = findPlugin(plugins, 'naidan-file-protocol-standalone-importscripts-assets');

    await expect(runTransform(
      workerQueryPolicy,
      `import WorkerFactory from './worker.ts?worker';`,
      '/tmp/source.ts',
    )).rejects.toThrow('Vite Worker query import is unsupported');

    await expect(runTransform(
      importScriptsPolicy,
      `const source = './classic.js'; importScripts(source);`,
      '/tmp/source.ts',
    )).rejects.toThrow('Dynamic importScripts() URL is unsupported');
  });


  it('keeps final-output Raw Worker rejection active with external source audit evidence', async () => {
    const rawWorkerPolicy = findPlugin(
      createNaidanStandalonePlugin(createOptions()),
      'naidan-file-protocol-standalone-raw-worker-constructor-policy',
    );

    await expect(runGenerateBundle(rawWorkerPolicy, {
      'assets/app.js': {
        type: 'chunk',
        fileName: 'assets/app.js',
        code: `new Worker('./worker.js');`,
        facadeModuleId: '/tmp/app.ts',
        modules: { '/tmp/app.ts': {} },
      },
    })).rejects.toThrow('Raw Worker constructors survive tree-shaking');
  });


  it('rejects Worker-only stylesheet side effects before packaging', async () => {
    await expect(runWorkerCssGenerateBundle({
      moduleInfoEntries: [
        ['/tmp/naidan-test-worker.ts', { isEntry: true, importedIds: [], dynamicallyImportedIds: ['/tmp/worker-only.scss'] }],
        ['/tmp/ui.ts', { isEntry: true, importedIds: [], dynamicallyImportedIds: [] }],
        ['/tmp/worker-only.scss', { isEntry: false, importedIds: [], dynamicallyImportedIds: [] }],
      ],
      bundle: {
        'assets/worker-only.css': {
          type: 'asset',
          fileName: 'assets/worker-only.css',
          source: '.worker-only {}',
        },
      },
      diagnostics: undefined,
      allowWorkerOnlyCssAssets: false,
    })).rejects.toThrow('Worker-only CSS side effects cannot be applied in a Dedicated Worker');
  });

  it('rejects Worker-only Vue SFC style virtual modules before packaging', async () => {
    const styleModuleId = '/tmp/WorkerPanel.vue?vue&type=style&index=0&scoped=abc123&lang.css';
    await expect(runWorkerCssGenerateBundle({
      moduleInfoEntries: [
        ['/tmp/naidan-test-worker.ts', { isEntry: true, importedIds: [styleModuleId], dynamicallyImportedIds: [] }],
        ['/tmp/ui.ts', { isEntry: true, importedIds: [], dynamicallyImportedIds: [] }],
        [styleModuleId, { isEntry: false, importedIds: [], dynamicallyImportedIds: [] }],
      ],
      bundle: {
        'assets/worker-panel.css': {
          type: 'asset',
          fileName: 'assets/worker-panel.css',
          source: '.worker-panel {}',
        },
      },
      diagnostics: undefined,
      allowWorkerOnlyCssAssets: false,
    })).rejects.toThrow('Worker-only CSS side effects cannot be applied in a Dedicated Worker');
  });

  it('allows a stylesheet shared by the UI and a Worker and records its ownership', async () => {
    const diagnostics: Record<string, unknown> = {};
    await expect(runWorkerCssGenerateBundle({
      moduleInfoEntries: [
        ['/tmp/naidan-test-worker.ts', { isEntry: true, importedIds: ['/tmp/shared.css'], dynamicallyImportedIds: [] }],
        ['/tmp/ui.ts', { isEntry: true, importedIds: ['/tmp/shared.css'], dynamicallyImportedIds: [] }],
        ['/tmp/shared.css', { isEntry: false, importedIds: [], dynamicallyImportedIds: [] }],
      ],
      bundle: {
        'assets/shared.css': { type: 'asset', fileName: 'assets/shared.css', source: '.shared {}' },
      },
      diagnostics,
      allowWorkerOnlyCssAssets: false,
    })).resolves.toBeUndefined();
    expect(diagnostics.workerCss).toMatchObject({
      classificationBasis: 'source-module-graph',
      workerCss: ['/tmp/shared.css'],
      uiCss: ['/tmp/shared.css'],
      workerOnlyCss: [],
      emittedCssAssets: ['assets/shared.css'],
    });
  });

  it('allows UI-only stylesheet side effects and records them without Worker ownership', async () => {
    const diagnostics: Record<string, unknown> = {};
    await expect(runWorkerCssGenerateBundle({
      moduleInfoEntries: [
        ['/tmp/naidan-test-worker.ts', { isEntry: true, importedIds: [], dynamicallyImportedIds: [] }],
        ['/tmp/ui.ts', { isEntry: true, importedIds: ['/tmp/ui-only.css'], dynamicallyImportedIds: [] }],
        ['/tmp/ui-only.css', { isEntry: false, importedIds: [], dynamicallyImportedIds: [] }],
      ],
      bundle: {
        'assets/ui-only.css': { type: 'asset', fileName: 'assets/ui-only.css', source: '.ui-only {}' },
      },
      diagnostics,
      allowWorkerOnlyCssAssets: false,
    })).resolves.toBeUndefined();
    expect(diagnostics.workerCss).toMatchObject({
      workerCss: [],
      uiCss: ['/tmp/ui-only.css'],
      workerOnlyCss: [],
      emittedCssAssets: ['assets/ui-only.css'],
    });
  });

  it('honors an explicit Worker-only stylesheet policy override while preserving diagnostics', async () => {
    const diagnostics: Record<string, unknown> = {};
    await expect(runWorkerCssGenerateBundle({
      moduleInfoEntries: [
        ['/tmp/naidan-test-worker.ts', { isEntry: true, importedIds: ['/tmp/worker-only.css'], dynamicallyImportedIds: [] }],
        ['/tmp/ui.ts', { isEntry: true, importedIds: [], dynamicallyImportedIds: [] }],
        ['/tmp/worker-only.css', { isEntry: false, importedIds: [], dynamicallyImportedIds: [] }],
      ],
      bundle: {
        'assets/worker-only.css': { type: 'asset', fileName: 'assets/worker-only.css', source: '.worker-only {}' },
      },
      diagnostics,
      allowWorkerOnlyCssAssets: true,
    })).resolves.toBeUndefined();
    expect(diagnostics.workerCss).toMatchObject({
      workerCss: ['/tmp/worker-only.css'],
      uiCss: [],
      workerOnlyCss: ['/tmp/worker-only.css'],
      emittedCssAssets: ['assets/worker-only.css'],
    });
  });

  it('does not misclassify raw, inline, or URL stylesheet imports as Worker CSS side effects', async () => {
    const diagnostics: Record<string, unknown> = {};
    const dataImports = [
      '/tmp/raw.css?raw',
      '/tmp/inline.scss?inline',
      '/tmp/url.css?url',
      '/tmp/CustomElement.vue?vue&type=style&index=0&inline&lang.css',
    ];
    await expect(runWorkerCssGenerateBundle({
      moduleInfoEntries: [
        ['/tmp/naidan-test-worker.ts', { isEntry: true, importedIds: dataImports, dynamicallyImportedIds: [] }],
        ['/tmp/ui.ts', { isEntry: true, importedIds: [], dynamicallyImportedIds: [] }],
        ...dataImports.map((moduleId): readonly [string, WorkerCssModuleInfoFixture] => [
          moduleId,
          { isEntry: false, importedIds: [], dynamicallyImportedIds: [] },
        ]),
      ],
      bundle: {},
      diagnostics,
      allowWorkerOnlyCssAssets: false,
    })).resolves.toBeUndefined();
    expect(diagnostics.workerCss).toMatchObject({
      workerCss: [],
      uiCss: [],
      workerOnlyCss: [],
    });
  });

  it('keeps final-output CommonJS and WebAssembly guards active', async () => {
    const plugins = createNaidanStandalonePlugin(createOptions());
    const commonJsPolicy = findPlugin(plugins, 'naidan-file-protocol-standalone-commonjs-compatibility');
    const wasmPolicy = findPlugin(plugins, 'naidan-file-protocol-standalone-external-wasm-guard');

    await expect(runGenerateBundle(commonJsPolicy, {
      'assets/app.js': {
        type: 'chunk',
        fileName: 'assets/app.js',
        code: '',
        facadeModuleId: '/tmp/app.ts',
        modules: { '\0vite-browser-external:node:fs': {} },
      },
    })).rejects.toThrow('Browser-external stub modules are unsupported');

    await expect(runGenerateBundle(wasmPolicy, {
      'assets/model.wasm': {
        type: 'asset',
        fileName: 'assets/model.wasm',
        source: new Uint8Array([0]),
      },
    })).rejects.toThrow('External WebAssembly assets cannot be loaded');
  });

});
