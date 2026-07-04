import { transformAsync } from '@babel/core';
import type { TransformOptions } from '@babel/core';
import transformDynamicImport from '@babel/plugin-transform-dynamic-import';
import transformModulesSystemjs from '@babel/plugin-transform-modules-systemjs';
import type {
  ExistingRawSourceMap,
  SourceMap,
  OutputAsset,
  OutputBundle,
  OutputChunk,
  RenderedChunk,
  SourceMapInput,
} from 'rolldown';
import type { Plugin, ResolvedConfig } from 'vite';

import { assertFileProtocolStandaloneClassicScript } from './file-protocol-standalone/javascript-validation';

const pluginName = 'file-protocol-systemjs-transform';

export type FileProtocolSystemJsOptions = Readonly<{
  emitDiagnostics: boolean,
}>;

type FileProtocolSystemJsTiming = {
  chunks: number,
  babelMs: number,
  inputBytes: number,
  outputBytesBeforeMinify: number,
};

function createEmptyTiming(): FileProtocolSystemJsTiming {
  return {
    chunks: 0,
    babelMs: 0,
    inputBytes: 0,
    outputBytesBeforeMinify: 0,
  };
}

function normalizeSourceMap({ map }: { map: unknown }): ExistingRawSourceMap | undefined {
  if (map === undefined || map === null) {
    return undefined;
  }
  if (typeof map === 'string') {
    return JSON.parse(map) as ExistingRawSourceMap;
  }
  if (typeof map !== 'object') {
    throw new Error(`[${pluginName}] Expected a source-map object or string.`);
  }
  if (!('version' in map) && 'toString' in map && typeof map.toString === 'function') {
    return JSON.parse(map.toString()) as ExistingRawSourceMap;
  }
  return map as ExistingRawSourceMap;
}

/** @internal Exported for focused plugin tests. */
export function assertSupportedFileProtocolSystemJsConfig({ config }: {
  config: ResolvedConfig,
}): void {
  if (config.base !== './' && config.base !== '') {
    throw new Error(`[${pluginName}] Vite base must be './' or '' for file:// output; received ${JSON.stringify(config.base)}.`);
  }
  if (config.build.modulePreload !== false) {
    throw new Error(`[${pluginName}] build.modulePreload must be false so no fetch-based preload runtime is emitted.`);
  }
  if (config.build.ssr) {
    throw new Error(`[${pluginName}] SSR builds are unsupported.`);
  }
  if (config.build.lib) {
    throw new Error(`[${pluginName}] Library mode is unsupported; an HTML application entry is required.`);
  }
  if (config.build.write === false) {
    throw new Error(`[${pluginName}] build.write=false is unsupported because final output must be validated.`);
  }
  if (config.build.minify !== false && config.build.minify !== 'oxc') {
    throw new Error(`[${pluginName}] build.minify must be false or 'oxc'; received ${JSON.stringify(config.build.minify)}.`);
  }
  const pluginInstances = config.plugins.filter((plugin) => plugin.name === pluginName).length;
  if (pluginInstances !== 1) {
    throw new Error(`[${pluginName}] Expected exactly one plugin instance; found ${pluginInstances}.`);
  }
}

/** @internal Exported for focused plugin tests. */
export function collectFileProtocolSystemJsOutputReferences({ chunk }: {
  chunk: OutputChunk,
}): readonly string[] {
  return [...new Set([
    ...chunk.imports,
    ...chunk.dynamicImports,
    ...chunk.viteMetadata?.importedAssets ?? [],
    ...chunk.viteMetadata?.importedCss ?? [],
  ])].sort();
}

function readJsonAsset({ asset, fileName }: {
  asset: OutputAsset,
  fileName: string,
}): unknown {
  const source = typeof asset.source === 'string'
    ? asset.source
    : Buffer.from(asset.source).toString('utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${pluginName}] ${fileName} is not valid JSON: ${message}.`);
  }
}

function readStringArray({ value, label }: {
  value: unknown,
  label: string,
}): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`[${pluginName}] ${label} must be an array of strings.`);
  }
  return value as readonly string[];
}

/** @internal Exported for focused plugin tests. */
export function validateFileProtocolSystemJsSourceMap({ bundle, chunk }: {
  bundle: OutputBundle,
  chunk: OutputChunk,
}): Readonly<{
  sourceMapFileName: string,
  sourceMapSources: number,
}> {
  const mapFileName = `${chunk.fileName}.map`;
  const mapOutput = bundle[mapFileName];
  const mapAsset = (() => {
    switch (mapOutput?.type) {
    case 'asset':
      return mapOutput;
    case 'chunk':
      throw new Error(`[${pluginName}] ${mapFileName} must be an asset, not a chunk.`);
    case undefined:
      throw new Error(`[${pluginName}] ${chunk.fileName} is missing emitted source map ${mapFileName}.`);
    default: {
      const _ex: never = mapOutput;
      throw new Error(`[${pluginName}] Unhandled source-map output: ${String(_ex)}`);
    }
    }
  })();
  const map = readJsonAsset({ asset: mapAsset, fileName: mapFileName });
  if (typeof map !== 'object' || map === null) {
    throw new Error(`[${pluginName}] ${mapFileName} must contain a source-map object.`);
  }
  const record = map as Record<string, unknown>;
  if (record.version !== 3) {
    throw new Error(`[${pluginName}] ${mapFileName} must use source map version 3.`);
  }
  const sources = readStringArray({ value: record.sources, label: `${mapFileName} sources` });
  if (sources.length === 0) {
    throw new Error(`[${pluginName}] ${mapFileName} has no sources.`);
  }
  const sourcesContent = readStringArray({ value: record.sourcesContent, label: `${mapFileName} sourcesContent` });
  if (sourcesContent.length !== sources.length) {
    throw new Error(`[${pluginName}] ${mapFileName} must embed sourcesContent for every source.`);
  }
  if (record.file !== chunk.fileName.split('/').at(-1)) {
    throw new Error(`[${pluginName}] ${mapFileName} has unexpected file field ${JSON.stringify(record.file)}.`);
  }
  if (typeof record.mappings !== 'string' || record.mappings.length === 0) {
    throw new Error(`[${pluginName}] ${mapFileName} has no mappings.`);
  }
  return {
    sourceMapFileName: mapFileName,
    sourceMapSources: sources.length,
  };
}

/**
 * Convert Vite's split ESM output to split System.register chunks for file://.
 *
 * Naidan can also support file:// through @vitejs/plugin-legacy's SystemJS
 * output. This dedicated plugin is not required merely to make file:// loading
 * possible. It exists to avoid the generic legacy-browser processing and
 * Terser-based minification used by that path, reducing build time and memory
 * usage for Naidan's large split-chunk graph while preserving the established
 * SystemJS runtime, lazy chunks, and lazy CSS behavior.
 *
 * Babel is intentionally used as the reference ESM-to-System.register
 * transform. SWC has had a SystemJS live-binding correctness issue, so it must
 * not replace Babel here without independent semantic-equivalence validation:
 * https://github.com/swc-project/swc/issues/4895
 *
 * Syntax lowering beyond module conversion remains Vite/Rolldown's concern.
 */
export function fileProtocolSystemJs({ emitDiagnostics }: FileProtocolSystemJsOptions): Plugin {
  let sourceMapMode: ResolvedConfig['build']['sourcemap'] = false;
  let timing = createEmptyTiming();

  return {
    name: pluginName,
    enforce: 'post',
    apply: 'build',
    configResolved(config) {
      assertSupportedFileProtocolSystemJsConfig({ config });
      sourceMapMode = config.build.sourcemap;
    },
    buildStart() {
      timing = createEmptyTiming();
    },
    async renderChunk(raw, chunk: RenderedChunk) {
      const started = performance.now();
      const sourceMaps = Boolean(sourceMapMode);
      const renderContext = this as typeof this & Partial<{ getCombinedSourcemap(): SourceMap }>;
      const inputMap = sourceMaps && typeof renderContext.getCombinedSourcemap === 'function'
        ? normalizeSourceMap({ map: renderContext.getCombinedSourcemap() })
        : undefined;
      const result = await transformAsync(raw, {
        filename: chunk.fileName,
        babelrc: false,
        configFile: false,
        ast: false,
        code: true,
        cloneInputAst: false,
        compact: false,
        comments: true,
        sourceMaps,
        inputSourceMap: inputMap as Exclude<TransformOptions['inputSourceMap'], boolean | null | undefined> | undefined,
        plugins: [transformDynamicImport, transformModulesSystemjs],
      });
      timing.babelMs += performance.now() - started;
      if (result?.code === undefined || result.code === null) {
        throw new Error(`[${pluginName}] Babel returned no code for ${chunk.fileName}.`);
      }
      timing.chunks += 1;
      timing.inputBytes += Buffer.byteLength(raw);
      timing.outputBytesBeforeMinify += Buffer.byteLength(result.code);
      return {
        code: result.code,
        map: normalizeSourceMap({ map: result.map }) as SourceMapInput,
      };
    },
    generateBundle(_options, bundle) {
      const emittedNames = new Set(Object.keys(bundle));
      const externalCss = [...emittedNames].filter((fileName) => fileName.endsWith('.css'));
      if (externalCss.length > 0) {
        throw new Error(
          `[${pluginName}] External CSS is unsupported by the standalone file:// contract; `
          + `inject CSS into JavaScript before this plugin. Found: ${externalCss.join(', ')}.`,
        );
      }

      const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === 'chunk');
      const diagnostics = [];
      for (const chunk of chunks) {
        const validation = assertFileProtocolStandaloneClassicScript({
          source: chunk.code,
          label: chunk.fileName,
          mode: 'application-chunk',
        });
        if (validation.systemRegisterCallCount !== 1) {
          throw new Error(
            `[${pluginName}] ${chunk.fileName} must contain exactly one System.register call; `
            + `found ${validation.systemRegisterCallCount}.`,
          );
        }
        const references = collectFileProtocolSystemJsOutputReferences({ chunk });
        for (const reference of references) {
          if (!emittedNames.has(reference)) {
            throw new Error(`[${pluginName}] ${chunk.fileName} references missing emitted file ${reference}.`);
          }
        }
        const sourceMap = sourceMapMode === true || sourceMapMode === 'hidden'
          ? validateFileProtocolSystemJsSourceMap({ bundle, chunk })
          : sourceMapMode === 'inline'
            ? (() => {
              if (!/sourceMappingURL=data:application\/json/.test(chunk.code)) {
                throw new Error(`[${pluginName}] ${chunk.fileName} is missing inline source map.`);
              }
              return { sourceMapFileName: undefined, sourceMapSources: undefined };
            })()
            : { sourceMapFileName: undefined, sourceMapSources: undefined };
        diagnostics.push({
          fileName: chunk.fileName,
          bytes: Buffer.byteLength(chunk.code),
          isEntry: chunk.isEntry,
          isDynamicEntry: chunk.isDynamicEntry,
          imports: [...chunk.imports],
          dynamicImports: [...chunk.dynamicImports],
          allReferences: references,
          moduleIds: Object.keys(chunk.modules).sort(),
          systemRegisterCallCount: validation.systemRegisterCallCount,
          ...sourceMap,
        });
      }
      if (chunks.length === 0) {
        throw new Error(`[${pluginName}] No JavaScript chunks were emitted.`);
      }
      if (!emitDiagnostics) {
        return;
      }
      this.emitFile({
        type: 'asset',
        fileName: 'systemjs-output-contract.json',
        source: `${JSON.stringify({
          format: 'file-protocol-systemjs-output-contract-v1',
          chunks: diagnostics.sort((left, right) => left.fileName.localeCompare(right.fileName)),
        }, undefined, 2)}\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'systemjs-transform-timing.json',
        source: `${JSON.stringify({
          format: 'file-protocol-systemjs-transform-timing-v1',
          ...timing,
        }, undefined, 2)}\n`,
      });
    },
  };
}
