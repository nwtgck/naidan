import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';

import {
  createNaidanStandalonePlugin,
  naidanStandaloneWorkerProtocol,
} from './plugin.js';

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

describe('naidanStandaloneWorkerProtocol', () => {
  it('keeps the public Worker handshake protocol stable and immutable', () => {
    expect(naidanStandaloneWorkerProtocol).toEqual({
      initMessageType: '__naidanStandaloneWorkerInitV1',
      readyMessageType: '__naidanStandaloneWorkerReadyV1',
      errorMessageType: '__naidanStandaloneWorkerErrorV1',
    });
    expect(Object.isFrozen(naidanStandaloneWorkerProtocol)).toBe(true);
  });
});

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

  it('keeps the external-audit plugin topology and critical hook ordering explicit', () => {
    const plugins = createNaidanStandalonePlugin({
      ...createOptions(),
      releaseValidation: {
        outputDirectory: '/tmp/naidan-standalone-output',
        omitFileNames: ['robots.txt'],
        debugReportFile: '/tmp/naidan-standalone-debug.json',
        releaseReportFile: '/tmp/naidan-standalone-release.json',
      },
    }) as Plugin[];

    expect(plugins.map(plugin => plugin.name)).toEqual([
      'naidan-file-protocol-standalone-build-config',
      'naidan-file-protocol-standalone-systemjs-runtime-validation',
      'naidan-file-protocol-standalone-worker-entries',
      'naidan-file-protocol-standalone-vite-worker-query-policy',
      'naidan-file-protocol-standalone-importscripts-assets',
      'naidan-file-protocol-standalone-raw-worker-constructor-policy',
      'naidan-file-protocol-standalone-commonjs-compatibility',
      'naidan-file-protocol-standalone-worker-css-guard',
      'naidan-file-protocol-standalone-external-wasm-guard',
      'naidan-file-protocol-standalone-vite-preload-helper-compatibility',
      'naidan-file-protocol-standalone-empty-css-pruning',
      'naidan-file-protocol-standalone-systemjs-output',
      'naidan-file-protocol-standalone-release-validation',
    ]);

    expect(findPlugin(plugins, 'naidan-file-protocol-standalone-worker-entries').enforce).toBe('pre');
    expect(findPlugin(plugins, 'naidan-file-protocol-standalone-vite-worker-query-policy').enforce).toBe('pre');
    expect(findPlugin(plugins, 'naidan-file-protocol-standalone-importscripts-assets').enforce).toBe('pre');
    expect(findPlugin(plugins, 'naidan-file-protocol-standalone-raw-worker-constructor-policy').enforce).toBe('pre');
    expect(findPlugin(plugins, 'naidan-file-protocol-standalone-commonjs-compatibility').enforce).toBe('pre');
    expect(findPlugin(plugins, 'naidan-file-protocol-standalone-vite-preload-helper-compatibility').enforce).toBe('post');
    expect(findPlugin(plugins, 'naidan-file-protocol-standalone-empty-css-pruning').enforce).toBe('post');

    const systemJsOutput = findPlugin(plugins, 'naidan-file-protocol-standalone-systemjs-output');
    expect(systemJsOutput.enforce).toBe('post');
    if (typeof systemJsOutput.generateBundle !== 'object' || systemJsOutput.generateBundle === null) {
      throw new Error('Expected ordered SystemJS generateBundle hook');
    }
    expect(systemJsOutput.generateBundle.order).toBe('post');

    const releaseValidation = findPlugin(plugins, 'naidan-file-protocol-standalone-release-validation');
    expect(typeof releaseValidation.writeBundle).toBe('function');
  });

  it('inserts only the Worker-realm global guard when switching from external to inline source audit', () => {
    const externalNames = pluginNames(createNaidanStandalonePlugin(createOptions()));
    const inlineNames = pluginNames(createNaidanStandalonePlugin({
      ...createOptions(),
      sourceAudit: { mode: 'inline' },
    }));

    expect(inlineNames).toEqual([
      ...externalNames.slice(0, 5),
      'naidan-file-protocol-standalone-worker-realm-global-guard',
      ...externalNames.slice(5),
    ]);
    expect(findPlugin(
      createNaidanStandalonePlugin({
        ...createOptions(),
        sourceAudit: { mode: 'inline' },
      }),
      'naidan-file-protocol-standalone-worker-realm-global-guard',
    ).enforce).toBe('pre');
  });

  it('keeps the default source audit inline when the option is omitted', () => {
    const names = pluginNames(createNaidanStandalonePlugin({
      workers: createOptions().workers,
      systemRuntimePath: createOptions().systemRuntimePath,
    }));

    expect(names).toContain('naidan-file-protocol-standalone-worker-realm-global-guard');
  });

  it('updates the caller-provided diagnostics object in place across plugin hooks', () => {
    const diagnostics: Record<string, unknown> = { sentinel: 'preserved' };
    const plugins = createNaidanStandalonePlugin({
      ...createOptions(),
      diagnostics,
    });

    expect(diagnostics).toMatchObject({
      sentinel: 'preserved',
      format: 'naidan-file-protocol-standalone-worker-build-v1',
      sourceAudit: {
        mode: 'external',
        evidence: 'focused test evidence',
      },
      chunks: [],
      classicScriptAssets: [],
      virtualModules: [],
      html: [],
      rawWorkerSourceCandidates: [],
      rawWorkerConstructors: [],
      viteWorkerQueryImports: [],
      workerRealmGlobalReferences: [],
    });

    runConfigResolved(
      findPlugin(plugins, 'naidan-file-protocol-standalone-build-config'),
      {
        base: './',
        build: { modulePreload: false, cssCodeSplit: true },
      },
    );

    expect(diagnostics).toMatchObject({
      modulePreloadDisabled: true,
      cssCodeSplitEnabled: true,
      lazyCssDependencyMetadataEnabled: true,
    });
  });

  it('normalizes Worker entries without mutating caller-owned definitions', () => {
    const worker = {
      name: 'relative-worker',
      entry: './relative-worker.ts',
      virtualId: 'virtual:file-protocol-standalone/worker/relative-worker',
    } as const;

    createNaidanStandalonePlugin({
      workers: [worker],
      systemRuntimePath: '/tmp/system.min.js',
      sourceAudit: {
        mode: 'external',
        evidence: 'focused test evidence',
      },
    });

    expect(worker).toEqual({
      name: 'relative-worker',
      entry: './relative-worker.ts',
      virtualId: 'virtual:file-protocol-standalone/worker/relative-worker',
    });
  });


  it('keeps mutable diagnostics state isolated between plugin factory instances', () => {
    const firstDiagnostics: Record<string, unknown> = {};
    const secondDiagnostics: Record<string, unknown> = {};

    createNaidanStandalonePlugin({
      ...createOptions(),
      diagnostics: firstDiagnostics,
    });
    createNaidanStandalonePlugin({
      ...createOptions(),
      diagnostics: secondDiagnostics,
    });

    const firstChunks = firstDiagnostics.chunks;
    const secondChunks = secondDiagnostics.chunks;
    if (!Array.isArray(firstChunks) || !Array.isArray(secondChunks)) {
      throw new Error('Expected diagnostics chunk arrays');
    }
    expect(firstChunks).not.toBe(secondChunks);

    firstChunks.push({ sentinel: 'first-build-only' });
    expect(secondChunks).toEqual([]);
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


  it('emits the complete static importScripts asset graph with stable output names', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naidan-importscripts-policy-'));
    try {
      await fs.mkdir(path.join(root, 'classic'));
      await fs.writeFile(
        path.join(root, 'classic', 'entry.js'),
        `\
importScripts('./nested.js');
self.classicEntry = true;
`,
      );
      await fs.writeFile(path.join(root, 'nested.js'), 'self.nestedClassicAsset = true;');

      const diagnostics: Record<string, unknown> = {};
      const importScriptsPolicy = findPlugin(
        createNaidanStandalonePlugin({
          workers: [{
            name: 'test-worker',
            entry: path.join(root, 'worker.ts'),
            virtualId: 'virtual:file-protocol-standalone/worker/test-worker',
          }],
          systemRuntimePath: '/tmp/system.min.js',
          diagnostics,
          sourceAudit: {
            mode: 'external',
            evidence: 'focused test evidence',
          },
        }),
        'naidan-file-protocol-standalone-importscripts-assets',
      );
      if (typeof importScriptsPolicy.transform !== 'function') {
        throw new Error('Expected importScripts transform hook');
      }

      const emittedAssets: Array<Readonly<{type: string; fileName?: string; source?: unknown}>> = [];
      let nextReferenceId = 0;
      await importScriptsPolicy.transform.call({
        emitFile(asset: Readonly<{type: string; fileName?: string; source?: unknown}>) {
          emittedAssets.push(asset);
          nextReferenceId += 1;
          return `reference-${nextReferenceId}`;
        },
      } as never, `importScripts('./classic/entry.js');`, path.join(root, 'worker.ts'));

      expect(emittedAssets).toEqual([
        {
          type: 'asset',
          fileName: 'assets/chunks/classic/entry.js',
          source: `\
importScripts('./nested.js');
self.classicEntry = true;
`,
        },
        {
          type: 'asset',
          fileName: 'assets/chunks/nested.js',
          source: 'self.nestedClassicAsset = true;',
        },
      ]);
      expect(diagnostics.classicScriptAssets).toEqual([
        {
          sourcePath: path.join(root, 'classic', 'entry.js'),
          outputFileName: 'assets/chunks/classic/entry.js',
        },
        {
          sourcePath: path.join(root, 'nested.js'),
          outputFileName: 'assets/chunks/nested.js',
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves Raw Worker alias and Reflect.construct classification in final-output diagnostics', async () => {
    const diagnostics: Record<string, unknown> = {};
    const rawWorkerPolicy = findPlugin(
      createNaidanStandalonePlugin({
        ...createOptions(),
        diagnostics,
        policies: {
          allowRawWorkerConstructor: () => true,
        },
      }),
      'naidan-file-protocol-standalone-raw-worker-constructor-policy',
    );

    await runGenerateBundle(rawWorkerPolicy, {
      'assets/app.js': {
        type: 'chunk',
        fileName: 'assets/app.js',
        code: `\
const WorkerAlias = Worker;
new WorkerAlias(new URL('./worker-a.js', import.meta.url));
const SharedAlias = SharedWorker;
Reflect.construct(SharedAlias, ['./worker-b.js']);
`,
        facadeModuleId: '/tmp/app.ts',
        modules: { '/tmp/app.ts': {} },
      },
    });

    expect(diagnostics.rawWorkerConstructors).toMatchObject([
      {
        stage: 'output',
        kind: 'Worker',
        calleeForm: 'alias',
        argumentKind: 'vite-new-url-import-meta',
        allowed: true,
      },
      {
        stage: 'output',
        kind: 'SharedWorker',
        calleeForm: 'Reflect.construct:alias',
        argumentKind: 'static-url',
        invocationKind: 'Reflect.construct',
        allowed: true,
      },
    ]);
  });

  it('distinguishes top-level Worker-realm globals from guarded and deferred accesses', async () => {
    const diagnostics: Record<string, unknown> = {};
    const workerRealmPolicy = findPlugin(
      createNaidanStandalonePlugin({
        ...createOptions(),
        diagnostics,
        workers: [{
          name: 'test-worker',
          entry: '/tmp/worker.ts',
          virtualId: 'virtual:file-protocol-standalone/worker/test-worker',
        }],
        sourceAudit: { mode: 'inline' },
      }),
      'naidan-file-protocol-standalone-worker-realm-global-guard',
    );

    await runTransform(
      workerRealmPolicy,
      `\
document.body;
if (typeof window !== 'undefined') window.location.href;
function deferredAccess() {
  return localStorage.length;
}
`,
      '/tmp/shared.ts',
    );

    await expect(runGenerateBundle(workerRealmPolicy, {
      'assets/worker.js': {
        type: 'chunk',
        fileName: 'assets/worker.js',
        code: '',
        isEntry: true,
        facadeModuleId: '/tmp/worker.ts',
        imports: ['assets/shared.js'],
        dynamicImports: [],
        modules: { '/tmp/worker.ts': {} },
      },
      'assets/shared.js': {
        type: 'chunk',
        fileName: 'assets/shared.js',
        code: '',
        isEntry: false,
        facadeModuleId: null,
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/shared.ts': {} },
      },
    })).rejects.toThrow('UI-only globals are evaluated by Worker-reachable modules');

    expect(diagnostics.workerRealmGlobalReferences).toMatchObject([
      {
        moduleId: '/tmp/shared.ts',
        name: 'document',
        accessKind: 'unbound-identifier',
        workerReachable: true,
        allowed: false,
      },
    ]);
  });

  it('keeps source-level CommonJS rejection for dynamic require and Node builtins', async () => {
    const commonJsPolicy = findPlugin(
      createNaidanStandalonePlugin(createOptions()),
      'naidan-file-protocol-standalone-commonjs-compatibility',
    );

    await expect(runTransform(
      commonJsPolicy,
      `const name = './dependency.cjs'; require(name);`,
      '/tmp/dynamic.cjs',
    )).rejects.toThrow('Dynamic CommonJS require() is unsupported');

    await expect(runTransform(
      commonJsPolicy,
      `const fs = require('node:fs');`,
      '/tmp/builtin.cjs',
    )).rejects.toThrow('Node.js builtin "node:fs" is unsupported');
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
