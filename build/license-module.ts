import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import license from 'rollup-plugin-license';
import type { Dependency as RollupLicenseDependency } from 'rollup-plugin-license';
import type { OutputChunk } from 'rolldown';
import type { Plugin, ResolvedConfig } from 'vite';

import { serializeLicenseDependencies } from './license-payload';
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

function normalizePackageModuleId({ moduleId, root }: { moduleId: string, root: string }): string | undefined {
  const normalized = moduleId.replaceAll('\\', '/').split('?', 1)[0] ?? moduleId;
  const nodeModulesMarker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(nodeModulesMarker);
  if (markerIndex >= 0) {
    const dependencyPath = normalized.slice(markerIndex + nodeModulesMarker.length);
    const segments = dependencyPath.split('/');
    const packageName = dependencyPath.startsWith('@')
      ? segments.slice(0, 2).join('/')
      : segments[0];
    return packageName === undefined || packageName === '' ? undefined : packageName;
  }
  const relative = path.relative(root, normalized).replaceAll('\\', '/');
  return relative.startsWith('../') || path.isAbsolute(relative) ? undefined : `/${relative}`;
}

function replaceLicensePayload({ chunk, serializedDependencies }: {
  chunk: OutputChunk,
  serializedDependencies: string,
}): void {
  const placeholderIndex = chunk.code.indexOf(licensePayloadPlaceholder);
  const placeholderEndIndex = placeholderIndex + licensePayloadPlaceholder.length;
  if (
    placeholderIndex < 0
    || chunk.code.indexOf(licensePayloadPlaceholder, placeholderEndIndex) !== -1
    || /[A-Za-z0-9_$]/.test(chunk.code[placeholderIndex - 1] ?? '')
    || /[A-Za-z0-9_$]/.test(chunk.code[placeholderEndIndex] ?? '')
  ) {
    throw new Error(`[${pluginName}] Expected exactly one license payload placeholder in ${chunk.fileName}.`);
  }

  chunk.code = chunk.code.slice(0, placeholderIndex)
    + serializedDependencies
    + chunk.code.slice(placeholderEndIndex);

  // The payload is injected after rendering, so an existing source map would
  // contain stale offsets and duplicate a large generated data value. Keep the
  // data-only lazy chunk intentionally map-free instead of publishing a wrong map.
  chunk.map = null;
}

export function createLicenseModulePlugins({ getAdditionalDependencies }: {
  getAdditionalDependencies: () => readonly BuildLicenseDependency[],
}): readonly Plugin[] {
  let resolvedConfig: ResolvedConfig | undefined;
  let mainDependencies: readonly BuildLicenseDependency[] = [];
  let developmentDependenciesPromise: Promise<readonly BuildLicenseDependency[]> | undefined;
  let mainDependenciesCollected = false;
  const renderedModuleIds = new Set<string>();

  const collector = license({
    thirdParty: {
      includePrivate: false,
      output: [(dependencies: RollupLicenseDependency[]) => {
        mainDependencies = mergeBuildLicenseDependencies({
          dependencyGroups: [dependencies
            .map((dependency) => convertRollupLicenseDependency({ dependency }))
            .filter((dependency): dependency is BuildLicenseDependency => dependency !== undefined)],
        });
        mainDependenciesCollected = true;
      }],
    },
  }) as Plugin;

  const modulePlugin: Plugin = {
    name: pluginName,
    configResolved(config) {
      resolvedConfig = config;
    },
    buildStart() {
      mainDependencies = [];
      mainDependenciesCollected = false;
      renderedModuleIds.clear();
    },
    resolveId(id) {
      return id === NAIDAN_LICENSE_MODULE_ID ? resolvedLicenseModuleId : undefined;
    },
    async load(id) {
      if (id !== resolvedLicenseModuleId) return undefined;
      if (resolvedConfig === undefined) {
        throw new Error(`[${pluginName}] Vite config was not resolved.`);
      }
      switch (resolvedConfig.command) {
      case 'serve': {
        developmentDependenciesPromise ??= collectDevelopmentLicenseDependencies({ root: resolvedConfig.root });
        const dependencies = mergeBuildLicenseDependencies({
          dependencyGroups: [await developmentDependenciesPromise, getAdditionalDependencies()],
        });
        return `const licenses = ${serializeLicenseDependencies({ dependencies })}; export default licenses;`;
      }
      case 'build':
        return `const licenses = ${licensePayloadPlaceholder}; export default licenses;`;
      default: {
        const _exhaustive: never = resolvedConfig.command;
        throw new Error(`[${pluginName}] Unsupported Vite command: ${_exhaustive}`);
      }
      }
    },
    renderChunk(_code, chunk) {
      for (const [moduleId, moduleInfo] of Object.entries(chunk.modules)) {
        if (moduleInfo.renderedLength > 0) renderedModuleIds.add(moduleId);
      }
      return undefined;
    },
    augmentChunkHash(chunkInfo) {
      if (!chunkInfo.moduleIds.includes(resolvedLicenseModuleId)) return undefined;
      if (resolvedConfig === undefined) {
        throw new Error(`[${pluginName}] Vite config was not resolved.`);
      }
      const config = resolvedConfig;
      const packageLockPath = path.resolve(config.root, 'package-lock.json');
      const packageLock = fs.existsSync(packageLockPath) ? fs.readFileSync(packageLockPath, 'utf8') : '';
      const moduleInputs = [...renderedModuleIds]
        .map((moduleId) => normalizePackageModuleId({ moduleId, root: config.root }))
        .filter((moduleId): moduleId is string => moduleId !== undefined)
        .sort();
      return createHash('sha256')
        .update(JSON.stringify({
          moduleInputs,
          packageLock,
          additionalDependencies: mergeBuildLicenseDependencies({
            dependencyGroups: [getAdditionalDependencies()],
          }),
        }))
        .digest('hex');
    },
    generateBundle(_outputOptions, bundle) {
      if (!mainDependenciesCollected) {
        throw new Error(`[${pluginName}] Main build license dependencies were not collected.`);
      }
      const dependencies = mergeBuildLicenseDependencies({
        dependencyGroups: [mainDependencies, getAdditionalDependencies()],
      });
      // generateBundle runs after rendering and identifier renaming, so inject
      // one self-contained expression rather than separate dictionary variables
      // that could refer to a pre-render name. The serializer derives sharing
      // only from actual licenseText values and includes its direct reconstruction
      // expressions, keeping the lazy module independent from application code.
      const serializedDependencies = serializeLicenseDependencies({ dependencies });
      const licenseChunks = Object.values(bundle)
        .filter((output): output is OutputChunk => output.type === 'chunk' && output.moduleIds.includes(resolvedLicenseModuleId));
      if (licenseChunks.length !== 1) {
        throw new Error(`[${pluginName}] Expected exactly one lazy license chunk, found ${licenseChunks.length}.`);
      }
      const [licenseChunk] = licenseChunks;
      if (licenseChunk === undefined) throw new Error(`[${pluginName}] License chunk is missing.`);
      if (!licenseChunk.isDynamicEntry || licenseChunk.isEntry) {
        throw new Error(`[${pluginName}] Generated license module must remain a lazy dynamic chunk.`);
      }
      replaceLicensePayload({ chunk: licenseChunk, serializedDependencies });
      delete bundle[`${licenseChunk.fileName}.map`];
    },
  };

  return [collector, modulePlugin];
}
