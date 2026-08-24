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

describe('file protocol standalone Vite config Babel interop', () => {
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
      '/tmp/standalone-worker-babel-interop.ts',
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

  it('runs the SystemJS Babel transforms through Vite config loading', async () => {
    const plugin = requirePlugin(
      await loadStandalonePlugins(),
      'naidan-file-protocol-standalone-systemjs-output',
    );
    if (typeof plugin.buildStart !== 'function') throw new Error('Expected SystemJS buildStart hook');
    if (typeof plugin.generateBundle !== 'function') throw new Error('Expected SystemJS generateBundle hook');

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

    await plugin.buildStart.call(context as never, {} as never);
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

    await expect(plugin.generateBundle.call(
      context as never,
      {} as never,
      bundle as never,
      false,
    )).rejects.toThrow('requires exactly one HTML entry; found 0');
    expect(bundle['assets/probe.js'].code).toContain('System.register(');
    expect(bundle['assets/probe.js'].code).toContain('_context.import("./dependency.js")');
  });

});
