import path from 'node:path';

import type { NaidanLicense } from '../src/01-models/naidan-license';
import license from 'rollup-plugin-license';
import type { Dependency as RollupLicenseDependency } from 'rollup-plugin-license';
import type { FunctionPluginHooks, NormalizedOutputOptions, OutputChunk, PluginContext } from 'rolldown';
import type { Plugin, ResolvedConfig } from 'vite';

import { serializeLicenseCatalogFactory } from './license-payload';
import { collectRenderedModuleLicenseDependencies } from './rendered-module-license-dependencies';
import {
  collectDevelopmentLicenseDependencies,
  convertRollupLicenseDependency,
  mergeBuildLicenseDependencies,
  type BuildLicenseDependency,
} from './license-dependencies';

export const NAIDAN_LICENSE_MODULE_ID = 'virtual:naidan-licenses';
const resolvedLicenseModuleId = `\0${NAIDAN_LICENSE_MODULE_ID}`;
const licensePayloadPlaceholder = '__NAIDAN_LICENSE_PAYLOAD_96f704f8__';
const pluginName = 'naidan-license-module';

type RenderChunkMeta = Parameters<FunctionPluginHooks['renderChunk']>[3];

/** Run the existing package scanner over this output's complete rendered graph.
 * Its normal generateBundle callback is too late for content-addressed code.
 * Use only its public hooks, with a fresh collector per output (no stale package
 * metadata across rebuilds). The returned banner/code is deliberately unused.
 */
async function collectBundleLicenseDependencies({ root, context, outputOptions, meta }: {
  root: string,
  context: PluginContext,
  outputOptions: NormalizedOutputOptions,
  meta: RenderChunkMeta,
}): Promise<readonly BuildLicenseDependency[]> {
  let collected: readonly BuildLicenseDependency[] | undefined;
  const collector = license({
    cwd: root,
    sourcemap: false,
    thirdParty: {
      includePrivate: false,
      multipleVersions: true,
      output: [(dependencies: RollupLicenseDependency[]) => {
        collected = dependencies
          .map((dependency) => convertRollupLicenseDependency({ dependency }))
          .filter((dependency): dependency is BuildLicenseDependency => dependency !== undefined);
      }],
    },
  }) as Plugin;
  const render = typeof collector.renderChunk === 'function' ? collector.renderChunk : collector.renderChunk?.handler;
  const finish = typeof collector.generateBundle === 'function' ? collector.generateBundle : collector.generateBundle?.handler;
  if (render === undefined || finish === undefined) {
    throw new Error(`[${pluginName}] License collector hooks are missing.`);
  }
  const moduleIds = new Set<string>();
  for (const chunk of Object.values(meta.chunks)) {
    await render.call(context, '', chunk, outputOptions, meta);
    for (const [moduleId, info] of Object.entries(chunk.modules)) {
      if (info.renderedLength > 0) {
        moduleIds.add(moduleId);
      }
    }
  }
  await finish.call(context, outputOptions, {}, false);
  if (collected === undefined) {
    throw new Error(`[${pluginName}] Main build license dependencies were not collected.`);
  }
  const renderedDependencies = await collectRenderedModuleLicenseDependencies({ moduleIds });
  return mergeBuildLicenseDependencies({ dependencyGroups: [collected, renderedDependencies] });
}

function replaceLicensePayload({ code, fileName, serializedFactory }: {
  code: string,
  fileName: string,
  serializedFactory: string,
}): string {
  const placeholderIndex = code.indexOf(licensePayloadPlaceholder);
  const placeholderEndIndex = placeholderIndex + licensePayloadPlaceholder.length;
  if (
    placeholderIndex < 0
    || code.indexOf(licensePayloadPlaceholder, placeholderEndIndex) !== -1
    || /[A-Za-z0-9_$]/.test(code[placeholderIndex - 1] ?? '')
    || /[A-Za-z0-9_$]/.test(code[placeholderEndIndex] ?? '')
  ) {
    throw new Error(`[${pluginName}] Expected exactly one license payload placeholder in ${fileName}.`);
  }
  return code.slice(0, placeholderIndex) + serializedFactory + code.slice(placeholderEndIndex);
}

export function createLicenseModulePlugins({ getAdditionalDependencies, getNativeDependencies, onBuildDependenciesCollected }: {
  getAdditionalDependencies: () => readonly BuildLicenseDependency[],
  getNativeDependencies?: (input: { watchFile: (filePath: string) => void }) => Promise<readonly NaidanLicense[]>,
  onBuildDependenciesCollected?: (input: { dependencies: readonly BuildLicenseDependency[] }) => void,
}): readonly Plugin[] {
  let resolvedConfig: ResolvedConfig | undefined;
  let buildDependencies: readonly BuildLicenseDependency[] | undefined;

  const modulePlugin: Plugin = {
    name: pluginName,
    configResolved(config) {
      resolvedConfig = config;
    },
    renderStart() {
      buildDependencies = undefined;
    },
    resolveId(id) {
      return id === NAIDAN_LICENSE_MODULE_ID ? resolvedLicenseModuleId : undefined;
    },
    async load(id) {
      if (id !== resolvedLicenseModuleId) {
        return undefined;
      }
      if (resolvedConfig === undefined) {
        throw new Error(`[${pluginName}] Vite config was not resolved.`);
      }
      switch (resolvedConfig.command) {
      case 'serve': {
        // Vite caches the transformed module. Recollect whenever that module is
        // invalidated instead of retaining stale data or a rejected promise.
        this.addWatchFile(path.resolve(resolvedConfig.root, 'package.json'));
        this.addWatchFile(path.resolve(resolvedConfig.root, 'package-lock.json'));
        const developmentDependencies = await collectDevelopmentLicenseDependencies({ root: resolvedConfig.root });
        const dependencies = mergeBuildLicenseDependencies({
          dependencyGroups: [developmentDependencies, getAdditionalDependencies()],
        });
        const nativeDependencies = await getNativeDependencies?.({ watchFile: filePath => this.addWatchFile(filePath) }) ?? [];
        return `const createLicenseCatalog = ${serializeLicenseCatalogFactory({ dependencies: [...dependencies, ...nativeDependencies] })}; export default createLicenseCatalog;`;
      }
      case 'build':
        return `const createLicenseCatalog = ${licensePayloadPlaceholder}; export default createLicenseCatalog;`;
      default: {
        const _exhaustive: never = resolvedConfig.command;
        throw new Error(`[${pluginName}] Unsupported Vite command: ${_exhaustive}`);
      }
      }
    },
    async renderChunk(code, chunk, outputOptions, meta) {
      if (!chunk.moduleIds.includes(resolvedLicenseModuleId)) {
        return undefined;
      }
      if (!chunk.isDynamicEntry || chunk.isEntry) {
        throw new Error(`[${pluginName}] Generated license module must remain a lazy dynamic chunk.`);
      }
      if (resolvedConfig === undefined) {
        throw new Error(`[${pluginName}] Vite config was not resolved.`);
      }
      const mainDependencies = await collectBundleLicenseDependencies({
        root: resolvedConfig.root,
        context: this,
        outputOptions,
        meta,
      });
      buildDependencies = mergeBuildLicenseDependencies({
        dependencyGroups: [mainDependencies, getAdditionalDependencies()],
      });
      const nativeDependencies = await getNativeDependencies?.({ watchFile: filePath => this.addWatchFile(filePath) }) ?? [];
      // Inject BEFORE Rolldown hashes the chunk and its importers. Hash the
      // actual payload, not lockfile noise or a proxy for the license contents.
      // The expression is self-contained, so subsequent transforms may safely
      // rename identifiers (including the standalone SystemJS conversion).
      return {
        code: replaceLicensePayload({
          code,
          fileName: chunk.fileName,
          serializedFactory: serializeLicenseCatalogFactory({ dependencies: [...buildDependencies, ...nativeDependencies] }),
        }),
        map: { mappings: '' },
      };
    },
    generateBundle(_outputOptions, bundle) {
      const licenseChunks = Object.values(bundle)
        .filter((output): output is OutputChunk => output.type === 'chunk' && output.moduleIds.includes(resolvedLicenseModuleId));
      if (licenseChunks.length !== 1) {
        throw new Error(`[${pluginName}] Expected exactly one lazy license chunk, found ${licenseChunks.length}.`);
      }
      const [licenseChunk] = licenseChunks;
      if (licenseChunk === undefined) {
        throw new Error(`[${pluginName}] License chunk is missing.`);
      }
      if (!licenseChunk.isDynamicEntry || licenseChunk.isEntry) {
        throw new Error(`[${pluginName}] Generated license module must remain a lazy dynamic chunk.`);
      }
      if (buildDependencies === undefined) {
        throw new Error(`[${pluginName}] License payload was not rendered.`);
      }
      onBuildDependenciesCollected?.({ dependencies: buildDependencies });
      // This generated, data-only chunk intentionally has no source map. Do not
      // mutate its code here: its content hash has already been finalized.
      licenseChunk.map = null;
      delete bundle[`${licenseChunk.fileName}.map`];
    },
  };

  return [modulePlugin];
}
