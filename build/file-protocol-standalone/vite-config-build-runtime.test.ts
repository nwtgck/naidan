import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { loadConfigFromFile, type Plugin, type PluginOption } from 'vite';

function collectPlugins(options: readonly PluginOption[]): Plugin[] {
  const plugins: Plugin[] = [];
  for (const option of options) {
    if (Array.isArray(option)) {
      plugins.push(...collectPlugins(option));
    } else if (option && typeof option === 'object' && 'name' in option) {
      plugins.push(option as Plugin);
    }
  }
  return plugins;
}

function requirePlugin(plugins: readonly Plugin[], name: string): Plugin {
  const plugin = plugins.find(candidate => candidate.name === name);
  if (plugin === undefined) throw new Error(`Expected plugin: ${name}`);
  return plugin;
}

async function loadStandalonePlugins(): Promise<Plugin[]> {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'standalone' },
    undefined,
    process.cwd(),
  );
  if (loaded === null) throw new Error('Expected Vite config to load');
  return collectPlugins(loaded.config.plugins ?? []);
}

async function createSystemJsOutputHarness(): Promise<Readonly<{
  generateBundle: (bundle: unknown) => Promise<void>;
}>> {
  const plugins = await loadStandalonePlugins();
  const pruningPlugin = requirePlugin(
    plugins,
    'naidan-file-protocol-standalone-empty-css-pruning',
  );
  const plugin = requirePlugin(
    plugins,
    'naidan-file-protocol-standalone-systemjs-output',
  );
  const pruningGenerateBundle = pruningPlugin.generateBundle;
  const buildStart = plugin.buildStart;
  const generateBundleHook = plugin.generateBundle;
  const generateBundle = typeof generateBundleHook === 'function'
    ? generateBundleHook
    : generateBundleHook?.handler;
  if (typeof pruningGenerateBundle !== 'function') throw new Error('Expected empty CSS pruning generateBundle hook');
  if (typeof buildStart !== 'function') throw new Error('Expected SystemJS buildStart hook');
  if (typeof generateBundle !== 'function') throw new Error('Expected SystemJS generateBundle hook');

  const emittedFiles = new Map<string, string>();
  let nextReference = 0;
  const context = {
    emitFile(asset: { fileName?: string }) {
      const referenceId = `reference-${++nextReference}`;
      emittedFiles.set(referenceId, asset.fileName ?? referenceId);
      return referenceId;
    },
    getFileName(referenceId: string) {
      const fileName = emittedFiles.get(referenceId);
      if (fileName === undefined) throw new Error(`Unknown emitted reference: ${referenceId}`);
      return fileName;
    },
  };

  await buildStart.call(context as never, {} as never);
  return {
    async generateBundle(bundle: unknown): Promise<void> {
      await pruningGenerateBundle.call(context as never, {} as never, bundle as never, false);
      await generateBundle.call(context as never, {} as never, bundle as never, false);
    },
  };
}

describe('file protocol standalone Vite config build-runtime interop', () => {
  it('runs the Raw Worker AST policy through Vite config loading', async () => {
    const plugin = requirePlugin(
      await loadStandalonePlugins(),
      'naidan-file-protocol-standalone-raw-worker-constructor-policy',
    );
    if (typeof plugin.transform !== 'function') throw new Error('Expected Raw Worker transform hook');
    if (typeof plugin.generateBundle !== 'function') throw new Error('Expected Raw Worker generateBundle hook');

    expect(plugin.transform.call(
      {} as never,
      'const worker = new Worker("worker.js");',
      '/tmp/standalone-worker-interop.ts',
    )).toBeNull();

    await plugin.generateBundle.call(
      {} as never,
      {} as never,
      {
        'assets/probe.js': {
          type: 'chunk',
          fileName: 'assets/probe.js',
          name: 'probe',
          isEntry: true,
          facadeModuleId: '/tmp/probe.ts',
          imports: [],
          dynamicImports: [],
          modules: { '/tmp/probe.ts': {} },
          code: 'const value = 1;',
          map: null,
        },
      } as never,
      false,
    );
  });

  it('runs the SystemJS transform through Vite config loading', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'assets/probe.js': {
        type: 'chunk',
        fileName: 'assets/probe.js',
        name: 'probe',
        isEntry: true,
        facadeModuleId: '/tmp/probe.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/probe.ts': {} },
        code: 'export async function probe() { return import("./dependency.js"); }',
        map: null,
      },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('requires exactly one HTML entry; found 0');
    expect(bundle['assets/probe.js'].code).toContain('System.register(');
    expect(bundle['assets/probe.js'].code).toContain('_context.import("./dependency.js")');
  });




  it('uses parsed HTML semantics for an unquoted, reordered Vite application entry', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script crossorigin src=./assets/index.js type=module></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
        viteMetadata: { importedCss: new Set<string>() },
      },
    };

    await generateBundle(bundle);

    const html = bundle['index.html'].source;
    expect(html).not.toContain('type=module');
    expect(html).not.toContain('assets/index.js type=module');
    expect(html).not.toContain('crossorigin');
    expect(html).toContain('file-protocol-standalone-systemjs-runtime');
  });

  it('fails closed when Vite changes the importedCss metadata shape', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
        viteMetadata: { importedCss: ['assets/index.css'] },
      },
      'assets/index.css': {
        type: 'asset',
        fileName: 'assets/index.css',
        source: '.index {}',
      },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('Unexpected Vite importedCss metadata shape for assets/index.js');
  });

  it('fails closed when Vite changes importedAssets metadata used by empty-CSS pruning', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset', fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type=module src=./assets/index.js></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk', fileName: 'assets/index.js', name: 'index', isEntry: true, facadeModuleId: '/tmp/index.ts',
        imports: [], dynamicImports: [], modules: { '/tmp/index.ts': {} }, code: 'export {};', map: null,
        viteMetadata: { importedCss: new Set(['assets/empty.css']), importedAssets: ['assets/empty.css'] },
      },
      'assets/empty.css': { type: 'asset', fileName: 'assets/empty.css', source: '' },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('Unexpected Vite importedAssets metadata shape for assets/index.js');
  });

  it('does not couple non-empty CSS output to unused importedAssets metadata', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset', fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type=module src=./assets/index.js></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk', fileName: 'assets/index.js', name: 'index', isEntry: true, facadeModuleId: '/tmp/index.ts',
        imports: [], dynamicImports: [], modules: { '/tmp/index.ts': {} }, code: 'export {};', map: null,
        viteMetadata: { importedCss: new Set(['assets/index.css']), importedAssets: ['unused-in-this-path'] },
      },
      'assets/index.css': { type: 'asset', fileName: 'assets/index.css', source: '.index {}' },
    };

    await generateBundle(bundle);

    expect(bundle['assets/index.css']).toBeDefined();
  });

  it('fails closed when Vite importedAssets metadata contains a non-string entry', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset', fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type=module src=./assets/index.js></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk', fileName: 'assets/index.js', name: 'index', isEntry: true, facadeModuleId: '/tmp/index.ts',
        imports: [], dynamicImports: [], modules: { '/tmp/index.ts': {} }, code: 'export {};', map: null,
        viteMetadata: { importedCss: new Set(['assets/empty.css']), importedAssets: new Set([42]) },
      },
      'assets/empty.css': { type: 'asset', fileName: 'assets/empty.css', source: '' },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('Unexpected Vite importedAssets metadata entry for assets/index.js: 42');
  });

  it('fails closed when UI CSS metadata references a missing output asset', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/missing.css']) },
      },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('UI stylesheet metadata references a missing output asset: assets/missing.css');
  });

  it('fails closed when standalone HTML links the same stylesheet output more than once', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: `\
<!doctype html><html><head><link rel="stylesheet" href="./assets/index.css"><link rel="stylesheet" href="assets/index.css"></head><body><script type="module" src="./assets/index.js"></script></body></html>`,
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/index.css']) },
      },
      'assets/index.css': {
        type: 'asset',
        fileName: 'assets/index.css',
        source: '.index {}',
      },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('Standalone HTML links stylesheet output more than once: assets/index.css');
  });

  it('drops empty Vite CSS assets after split runtime CSS moved into JavaScript registrations', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const importedCss = new Set(['assets/index.css']);
    const workerImportedCss = new Set(['assets/index.css']);
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head><link rel="stylesheet" href="./assets/index.css"></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
        viteMetadata: { importedCss },
      },
      'assets/worker.js': {
        type: 'chunk',
        fileName: 'assets/worker.js',
        name: 'worker',
        isEntry: true,
        facadeModuleId: '/tmp/worker.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/worker.ts': {} },
        code: 'export const worker = true;',
        map: null,
        viteMetadata: { importedCss: workerImportedCss },
      },
      'assets/index.css': {
        type: 'asset',
        fileName: 'assets/index.css',
        source: '\n',
      },
    };

    await generateBundle(bundle);

    expect(bundle).not.toHaveProperty('assets/index.css');
    expect(importedCss).toEqual(new Set());
    expect(workerImportedCss).toEqual(new Set());
    expect(bundle['index.html'].source).not.toContain('assets/index.css');
  });

  it('preserves empty CSS assets when JavaScript imports the file URL as data', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const importedAssets = new Set(['assets/empty.css']);
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const assetUrl = "./empty.css";',
        map: null,
        viteMetadata: {
          importedCss: new Set<string>(),
          importedAssets,
        },
      },
      'assets/empty.css': {
        type: 'asset',
        fileName: 'assets/empty.css',
        source: '',
      },
    };

    await generateBundle(bundle);

    expect(bundle).toHaveProperty('assets/empty.css');
    expect(importedAssets).toEqual(new Set(['assets/empty.css']));
  });

  it('keeps mixed-use empty CSS as data while removing effect-free stylesheet metadata', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const importedCss = new Set(['assets/empty.css']);
    const importedAssets = new Set(['assets/empty.css']);
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head><link rel=stylesheet href=./assets/empty.css></head><body><script type=module src=./assets/index.js></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const assetUrl = "./empty.css";',
        map: null,
        viteMetadata: { importedCss, importedAssets },
      },
      'assets/empty.css': {
        type: 'asset',
        fileName: 'assets/empty.css',
        source: '',
      },
    };

    await generateBundle(bundle);

    expect(bundle).toHaveProperty('assets/empty.css');
    expect(importedAssets).toEqual(new Set(['assets/empty.css']));
    expect(importedCss).toEqual(new Set());
    expect(bundle['index.html'].source).not.toContain('empty.css');
  });

  it('links only the initial UI CSS closure and leaves dynamic-only CSS lazy', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: `\
<!doctype html><html><head><link rel=stylesheet media=print href=./public-theme.css><link crossorigin rel=stylesheet href=./assets/base.css></head><body><script type="module" crossorigin src="./assets/index.js"></script></body></html>`,
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: ['assets/lazy.js'],
        modules: { '/tmp/index.ts': {} },
        code: 'export async function load() { return import("./lazy.js"); }',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/base.css']) },
      },
      'assets/lazy.js': {
        type: 'chunk',
        fileName: 'assets/lazy.js',
        name: 'lazy',
        isEntry: false,
        facadeModuleId: '/tmp/lazy.ts',
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/nested.js'],
        modules: { '/tmp/lazy.ts': {} },
        code: 'export async function lazy() { return import("./nested.js"); }',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/lazy.css']) },
      },
      'assets/shared.js': {
        type: 'chunk',
        fileName: 'assets/shared.js',
        name: 'shared',
        isEntry: false,
        facadeModuleId: '/tmp/shared.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/shared.ts': {} },
        code: 'export const shared = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/shared.css']) },
      },
      'assets/nested.js': {
        type: 'chunk',
        fileName: 'assets/nested.js',
        name: 'nested',
        isEntry: false,
        facadeModuleId: '/tmp/nested.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/nested.ts': {} },
        code: 'export const nested = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/nested # % 日本語.css']) },
      },
      'assets/worker.js': {
        type: 'chunk',
        fileName: 'assets/worker.js',
        name: 'worker',
        isEntry: true,
        facadeModuleId: '/tmp/worker.ts',
        imports: ['assets/shared.js'],
        dynamicImports: [],
        modules: { '/tmp/worker.ts': {} },
        code: 'export const worker = true;',
        map: null,
        viteMetadata: { importedCss: new Set<string>() },
      },
      'assets/base.css': {
        type: 'asset',
        fileName: 'assets/base.css',
        source: 'body { color: black; }',
      },
      'assets/lazy.css': {
        type: 'asset',
        fileName: 'assets/lazy.css',
        source: '.lazy { display: block; }',
      },
      'assets/shared.css': {
        type: 'asset',
        fileName: 'assets/shared.css',
        source: '.shared { display: block; }',
      },
      'assets/nested # % 日本語.css': {
        type: 'asset',
        fileName: 'assets/nested # % 日本語.css',
        source: '.nested { display: block; }',
      },
    };

    await generateBundle(bundle);

    const html = bundle['index.html'].source;
    const dom = new JSDOM(html);
    try {
      const stylesheetLinks = Array.from(dom.window.document.querySelectorAll<HTMLLinkElement>('link[rel]'))
        .filter(link => (link.getAttribute('rel') ?? '').split(/\s+/u).includes('stylesheet'));
      expect(stylesheetLinks.map(link => link.getAttribute('href'))).toEqual([
        './public-theme.css',
        './assets/base.css',
      ]);
      expect(stylesheetLinks.every(link => !link.hasAttribute('crossorigin'))).toBe(true);
    } finally {
      dom.window.close();
    }
    expect(html).not.toContain('rel="modulepreload"');
  });


  it('preserves Vite importedCss insertion order for the initial static closure without eager dynamic CSS', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: ['assets/z-lazy.js', 'assets/a-lazy.js'],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/z-entry.css', 'assets/a-entry.css']) },
      },
      'assets/z-lazy.js': {
        type: 'chunk',
        fileName: 'assets/z-lazy.js',
        name: 'z-lazy',
        isEntry: false,
        facadeModuleId: '/tmp/z-lazy.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/z-lazy.ts': {} },
        code: 'export const z = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/z-first.css', 'assets/a-second.css']) },
      },
      'assets/a-lazy.js': {
        type: 'chunk',
        fileName: 'assets/a-lazy.js',
        name: 'a-lazy',
        isEntry: false,
        facadeModuleId: '/tmp/a-lazy.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/a-lazy.ts': {} },
        code: 'export const a = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/middle.css']) },
      },
      'assets/z-entry.css': { type: 'asset', fileName: 'assets/z-entry.css', source: '.z-entry {}' },
      'assets/a-entry.css': { type: 'asset', fileName: 'assets/a-entry.css', source: '.a-entry {}' },
      'assets/z-first.css': { type: 'asset', fileName: 'assets/z-first.css', source: '.z-first {}' },
      'assets/a-second.css': { type: 'asset', fileName: 'assets/a-second.css', source: '.a-second {}' },
      'assets/middle.css': { type: 'asset', fileName: 'assets/middle.css', source: '.middle {}' },
    };

    await generateBundle(bundle);

    const dom = new JSDOM(bundle['index.html'].source);
    try {
      expect(Array.from(dom.window.document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
        .map(link => link.getAttribute('href'))).toEqual([
        './assets/z-entry.css',
        './assets/a-entry.css',
      ]);
    } finally {
      dom.window.close();
    }
  });

  it('rejects a conditional link when it is the only existing owner of UI CSS', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head><link rel=stylesheet media=print href=./assets/base.css></head><body><script type=module src=./assets/index.js></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk', fileName: 'assets/index.js', name: 'index', isEntry: true, facadeModuleId: '/tmp/index.ts',
        imports: [], dynamicImports: [], modules: { '/tmp/index.ts': {} }, code: 'export {};', map: null,
        viteMetadata: { importedCss: new Set(['assets/base.css']) },
      },
      'assets/base.css': { type: 'asset', fileName: 'assets/base.css', source: '.base {}' },
    };

    await expect(generateBundle(bundle)).rejects.toThrow(
      'UI-owned stylesheet links must apply unconditionally from <head>: assets/base.css',
    );
  });

  it('rejects an existing UI-owned stylesheet outside head because generated CSS would precede it', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><link rel=stylesheet href=./assets/base.css><script type=module src=./assets/index.js></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk', fileName: 'assets/index.js', name: 'index', isEntry: true, facadeModuleId: '/tmp/index.ts',
        imports: [], dynamicImports: [], modules: { '/tmp/index.ts': {} }, code: 'export {};', map: null,
        viteMetadata: { importedCss: new Set(['assets/base.css']) },
      },
      'assets/base.css': { type: 'asset', fileName: 'assets/base.css', source: '.base {}' },
    };

    await expect(generateBundle(bundle)).rejects.toThrow(
      'UI-owned stylesheet links must apply unconditionally from <head>: assets/base.css',
    );
  });

  it('fails closed when dynamic-only UI CSS is linked from initial HTML', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head><link rel="stylesheet" href="./assets/lazy.css"></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: ['assets/lazy.js'],
        modules: { '/tmp/index.ts': {} },
        code: 'export async function load() { return import("./lazy.js"); }',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/base.css']) },
      },
      'assets/lazy.js': {
        type: 'chunk',
        fileName: 'assets/lazy.js',
        name: 'lazy',
        isEntry: false,
        facadeModuleId: '/tmp/lazy.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/lazy.ts': {} },
        code: 'export const lazy = true;',
        map: null,
        viteMetadata: { importedCss: new Set(['assets/lazy.css']) },
      },
      'assets/base.css': { type: 'asset', fileName: 'assets/base.css', source: '.base {}' },
      'assets/lazy.css': { type: 'asset', fileName: 'assets/lazy.css', source: '.lazy {}' },
    };

    await expect(generateBundle(bundle)).rejects.toThrow(
      'Dynamic-only UI stylesheets must not be linked from initial HTML: assets/lazy.css',
    );
  });

  it('fails closed when the UI dynamic closure references a missing emitted chunk', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: ['assets/missing.js'],
        modules: { '/tmp/index.ts': {} },
        code: 'export async function load() { return import("./missing.js"); }',
        map: null,
        viteMetadata: { importedCss: new Set<string>() },
      },
    };

    await expect(generateBundle(bundle)).rejects.toThrow(
      'UI chunk graph references a missing emitted chunk: assets/missing.js',
    );
  });

  it('fails closed when a UI chunk no longer exposes Vite importedCss metadata', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
      },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('Missing Vite importedCss metadata for assets/index.js');
  });

  it('fails closed when Vite importedCss metadata contains a non-string entry', async () => {
    const { generateBundle } = await createSystemJsOutputHarness();
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<!doctype html><html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
      },
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        name: 'index',
        isEntry: true,
        facadeModuleId: '/tmp/index.ts',
        imports: [],
        dynamicImports: [],
        modules: { '/tmp/index.ts': {} },
        code: 'export const value = true;',
        map: null,
        viteMetadata: { importedCss: new Set([42]) },
      },
    };

    await expect(generateBundle(bundle)).rejects.toThrow('Unexpected Vite importedCss metadata entry for assets/index.js: 42');
  });


});
