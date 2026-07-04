import { describe, expect, it } from 'vitest';
import type { OutputAsset, OutputBundle, OutputChunk } from 'rolldown';
import type { ResolvedConfig } from 'vite';

import {
  assertSupportedFileProtocolSystemJsConfig,
  collectFileProtocolSystemJsOutputReferences,
  fileProtocolSystemJs,
  validateFileProtocolSystemJsSourceMap,
} from './file-protocol-systemjs';

function resolvedConfigFixture({
  base,
  modulePreload,
  minify,
  ssr,
  lib,
  write,
  pluginInstanceCount,
}: {
  base: string,
  modulePreload: false | Readonly<Record<string, unknown>>,
  minify: false | 'oxc' | 'terser',
  ssr: boolean | string,
  lib: false | Readonly<Record<string, unknown>>,
  write: boolean,
  pluginInstanceCount: number,
}): ResolvedConfig {
  return {
    base,
    build: {
      modulePreload,
      minify,
      ssr,
      lib,
      write,
    },
    plugins: Array.from({ length: pluginInstanceCount }, () => ({
      name: 'file-protocol-systemjs-transform',
    })),
  } as unknown as ResolvedConfig;
}

function outputChunkFixture(): OutputChunk {
  return {
    type: 'chunk',
    code: 'System.register([], function () {});',
    name: 'entry',
    isEntry: true,
    isDynamicEntry: false,
    exports: [],
    fileName: 'assets/entry.js',
    modules: {},
    moduleIds: [],
    imports: ['assets/static.js'],
    dynamicImports: ['assets/lazy.js'],
    facadeModuleId: '/src/main.ts',
    map: null,
    sourcemapFileName: null,
    preliminaryFileName: 'assets/entry.js',
    viteMetadata: {
      importedAssets: new Set(['assets/image.svg']),
      importedCss: new Set(['assets/style.css']),
      __modules: undefined,
    },
  } as unknown as OutputChunk;
}

function sourceMapAsset({ source }: { source: unknown }): OutputAsset {
  return {
    type: 'asset',
    fileName: 'assets/entry.js.map',
    source: JSON.stringify(source),
    originalFileName: null,
    originalFileNames: [],
    name: undefined,
    names: [],
  } as unknown as OutputAsset;
}

describe('fileProtocolSystemJs', () => {
  it('requires the deterministic standalone Vite configuration', () => {
    const validArguments = {
      base: './',
      modulePreload: false as const,
      minify: 'oxc' as const,
      ssr: false as const,
      lib: false as const,
      write: true,
      pluginInstanceCount: 1,
    };
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture(validArguments),
    })).not.toThrow();
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, minify: false }),
    })).not.toThrow();
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, base: '/' }),
    })).toThrow("Vite base must be './' or ''");
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, modulePreload: {} }),
    })).toThrow('build.modulePreload must be false');
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, minify: 'terser' }),
    })).toThrow("build.minify must be false or 'oxc'");
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, ssr: true }),
    })).toThrow('SSR builds are unsupported');
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, lib: {} }),
    })).toThrow('Library mode is unsupported');
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, write: false }),
    })).toThrow('build.write=false is unsupported');
    expect(() => assertSupportedFileProtocolSystemJsConfig({
      config: resolvedConfigFixture({ ...validArguments, pluginInstanceCount: 2 }),
    })).toThrow('Expected exactly one plugin instance; found 2');
  });

  it('collects chunk, lazy, CSS, and asset references exactly once', () => {
    expect(collectFileProtocolSystemJsOutputReferences({
      chunk: outputChunkFixture(),
    })).toEqual([
      'assets/image.svg',
      'assets/lazy.js',
      'assets/static.js',
      'assets/style.css',
    ]);
  });

  it('validates complete emitted source maps', () => {
    const chunk = outputChunkFixture();
    const validMap = {
      version: 3,
      file: 'entry.js',
      sources: ['../../src/main.ts'],
      sourcesContent: ['export const value = 1'],
      names: [],
      mappings: 'AAAA',
    };
    expect(validateFileProtocolSystemJsSourceMap({
      bundle: {
        [chunk.fileName]: chunk,
        [`${chunk.fileName}.map`]: sourceMapAsset({ source: validMap }),
      } as OutputBundle,
      chunk,
    })).toEqual({
      sourceMapFileName: 'assets/entry.js.map',
      sourceMapSources: 1,
    });

    expect(() => validateFileProtocolSystemJsSourceMap({
      bundle: { [chunk.fileName]: chunk } as OutputBundle,
      chunk,
    })).toThrow('is missing emitted source map');
    expect(() => validateFileProtocolSystemJsSourceMap({
      bundle: {
        [chunk.fileName]: chunk,
        [`${chunk.fileName}.map`]: sourceMapAsset({
          source: { ...validMap, sourcesContent: [] },
        }),
      } as OutputBundle,
      chunk,
    })).toThrow('must embed sourcesContent for every source');
  });

  it('requires the caller to choose diagnostic emission explicitly', () => {
    expect(fileProtocolSystemJs({ emitDiagnostics: false }).name)
      .toBe('file-protocol-systemjs-transform');
    expect(fileProtocolSystemJs({ emitDiagnostics: true }).name)
      .toBe('file-protocol-systemjs-transform');
  });
});
