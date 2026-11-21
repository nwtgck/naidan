import type { Rollup } from 'vite';
import { BOUNDARY_STRING_LOCALES, type BoundaryStringLocale, type BoundaryStringMessageCatalog, type BoundaryStringProjectPaths } from './message-catalog.ts';
import { normalizeModuleId } from './module-id.ts';
import { parseResolvedBoundaryModuleId, parseResolvedPackModuleId } from './virtual-modules.ts';

export type BoundaryLocaleAssets = ReadonlyMap<string, BoundaryStringLocale>;
type LocaleAssetResult = { assets: BoundaryLocaleAssets } | { error: unknown };
export type PublishLocaleAssets = ({ result }: { result: LocaleAssetResult | undefined }) => void;

export function createLocaleAssetReport() {
  let current: LocaleAssetResult | undefined;
  const publish: PublishLocaleAssets = ({ result }) => {
    current = result;
  };
  return {
    publish,
    read(): BoundaryLocaleAssets | undefined {
      if (current !== undefined && 'error' in current) {
        throw current.error;
      }
      return current?.assets;
    },
  };
}

export function collectBoundaryLocaleAssets({ bundle, catalog, paths, getModuleInfo }: {
  bundle: Rollup.OutputBundle;
  catalog: BoundaryStringMessageCatalog;
  paths: BoundaryStringProjectPaths;
  getModuleInfo: Rollup.PluginContext['getModuleInfo'];
}): BoundaryLocaleAssets {
  const byModule = new Map<string, BoundaryStringLocale>();
  for (const locale of BOUNDARY_STRING_LOCALES) {
    byModule.set(normalizeModuleId({ moduleId: paths.catalogFilePathsByLocale[locale] }), locale);
    for (const message of catalog.messages) {
      byModule.set(normalizeModuleId({ moduleId: message.modulesByLocale[locale].filePath }), locale);
    }
  }

  function moduleLocale({ id }: { id: string }): BoundaryStringLocale | undefined {
    return parseResolvedPackModuleId({ id })?.locale ?? byModule.get(normalizeModuleId({ moduleId: id }));
  }

  const chunks = Object.values(bundle).filter(chunk => chunk.type === 'chunk');
  const locales = new Map<string, BoundaryStringLocale>();
  const packFiles = new Set<string>();
  for (const chunk of chunks) {
    const ids = new Set(chunk.moduleIds);
    if (chunk.facadeModuleId !== null) {
      ids.add(chunk.facadeModuleId);
    }
    const ownedModules = new Map<string, BoundaryStringLocale>();
    for (const id of ids) {
      const locale = moduleLocale({ id });
      if (locale === undefined) {
        continue;
      }
      ownedModules.set(id, locale);
      const pack = parseResolvedPackModuleId({ id });
      if (pack !== undefined) {
        packFiles.add(chunk.fileName);
      }
      for (const importer of getModuleInfo(id)?.dynamicImporters ?? []) {
        const boundary = parseResolvedBoundaryModuleId({ id: importer });
        if (moduleLocale({ id: importer }) !== locale
          && !(pack !== undefined && boundary?.boundaryId === pack.boundaryId && boundary.version === pack.version)) {
          throw new Error(`Boundary Strings locale asset ${chunk.fileName} (${id}) has an unscoped dynamic import from ${importer}`);
        }
      }
    }
    const owners = new Set(ownedModules.values());
    const locale = owners.values().next().value;
    if (locale === undefined) {
      continue;
    }
    if (owners.size !== 1 || chunk.isEntry) {
      throw new Error(`Boundary Strings locale asset ${chunk.fileName} mixes languages or enters the initial graph: ${[...ownedModules.keys()].join(', ')}`);
    }
    locales.set(chunk.fileName, locale);
  }

  for (const chunk of chunks) {
    const owner = locales.get(chunk.fileName);
    for (const imported of chunk.imports) {
      const locale = locales.get(imported);
      if (locale !== undefined && locale !== owner) {
        throw new Error(`Boundary Strings locale asset ${imported} (${locale}) is eagerly required by ${chunk.fileName}`);
      }
    }
    for (const imported of chunk.dynamicImports) {
      const locale = locales.get(imported);
      if (locale !== undefined && locale !== owner && !packFiles.has(imported)) {
        throw new Error(`Boundary Strings locale asset ${imported} (${locale}) bypasses a locale pack from ${chunk.fileName}`);
      }
    }
  }
  return locales;
}

export const TEST_ONLY = {
};
