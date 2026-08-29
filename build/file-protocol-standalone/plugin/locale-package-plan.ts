import { RUNTIME_MODULE_ID } from 'rolldown';

import {
  parseResolvedBoundaryModuleId,
  parseResolvedPackModuleIdentity,
} from '../../boundary-strings/virtual-modules.js';

export type RenderedModuleInfo = Readonly<{ renderedLength: number }>;
export type PackageChunk = Readonly<{
  fileName: string;
  isEntry: boolean;
  imports: readonly string[];
  dynamicImports: readonly string[];
  modules: Readonly<Record<string, RenderedModuleInfo>>;
}>;

export type LocalePackagePlan = Readonly<{
  locale: string;
  removeChunkFileNames: ReadonlySet<string>;
  retainedChunkFileNames: ReadonlySet<string>;
  localeRootChunkFileNames: Readonly<Record<string, readonly string[]>>;
}>;

function normalizedModuleId(moduleId: string): string {
  return moduleId.replaceAll('\\', '/');
}

function renderedModuleIds(chunk: PackageChunk): readonly string[] {
  return Object.entries(chunk.modules)
    .filter(([, info]) => info.renderedLength > 0)
    .map(([moduleId]) => normalizedModuleId(moduleId));
}

function parsePackLocale({ moduleId, supportedLocales }: Readonly<{
  moduleId: string;
  supportedLocales: readonly string[];
}>): string | undefined {
  const identity = parseResolvedPackModuleIdentity({ id: normalizedModuleId(moduleId) });
  if (identity === undefined) return undefined;
  if (!supportedLocales.includes(identity.locale)) {
    throw new Error(`Unknown Boundary Strings pack locale in module ID: ${moduleId}`);
  }
  return identity.locale;
}

function parseMessageModuleLocale({ moduleId, supportedLocales }: Readonly<{
  moduleId: string;
  supportedLocales: readonly string[];
}>): string | undefined {
  const marker = '/src/strings/messages/';
  const markerIndex = moduleId.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const relative = moduleId.slice(markerIndex + marker.length).replace(/[?#].*$/u, '');
  const segments = relative.split('/');
  const fileName = segments.at(-1);
  if (fileName === undefined) return undefined;
  const match = /^([^./]+)\.(?:[cm]?[jt]s)$/u.exec(fileName);
  if (match === null) return undefined;
  const locale = match[1];
  if (locale === undefined) return undefined;
  if (!supportedLocales.includes(locale)) {
    throw new Error(`Unknown Boundary Strings source locale in module ID: ${moduleId}`);
  }
  return locale;
}

function chunkLocaleInfo({ chunk, supportedLocales }: Readonly<{
  chunk: PackageChunk;
  supportedLocales: readonly string[];
}>): Readonly<{
  payloadLocales: ReadonlySet<string>;
  rootLocales: ReadonlySet<string>;
}> {
  const payloadLocales = new Set<string>();
  const rootLocales = new Set<string>();

  for (const moduleId of renderedModuleIds(chunk)) {
    const packLocale = parsePackLocale({ moduleId, supportedLocales });
    if (packLocale !== undefined) {
      payloadLocales.add(packLocale);
      rootLocales.add(packLocale);
    }
    const sourceLocale = parseMessageModuleLocale({ moduleId, supportedLocales });
    if (sourceLocale !== undefined) payloadLocales.add(sourceLocale);
  }

  if (payloadLocales.size > 1) {
    throw new Error(`Chunk mixes Boundary Strings payload locales: ${chunk.fileName} -> ${[...payloadLocales].join(', ')}`);
  }
  if (rootLocales.size > 1) {
    throw new Error(`Chunk mixes Boundary Strings pack roots: ${chunk.fileName} -> ${[...rootLocales].join(', ')}`);
  }
  return { payloadLocales, rootLocales };
}

function followClosure({
  start,
  chunksByFileName,
}: Readonly<{
  start: readonly string[];
  chunksByFileName: ReadonlyMap<string, PackageChunk>;
}>): Set<string> {
  const visited = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const fileName = stack.pop();
    if (fileName === undefined || visited.has(fileName)) continue;
    const chunk = chunksByFileName.get(fileName);
    if (chunk === undefined) throw new Error(`Chunk graph references missing output chunk: ${fileName}`);
    visited.add(fileName);
    for (const imported of chunk.imports) stack.push(imported);
    for (const imported of chunk.dynamicImports) stack.push(imported);
  }
  return visited;
}

function asSortedRecord(map: ReadonlyMap<string, ReadonlySet<string>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries([...map.entries()].map(([locale, values]) => [locale, [...values].sort()]));
}

function createModuleToChunkMap({ chunks }: Readonly<{
  chunks: readonly PackageChunk[];
}>): Map<string, string> {
  const moduleToChunk = new Map<string, string>();
  for (const chunk of chunks) {
    for (const moduleId of renderedModuleIds(chunk)) {
      const previous = moduleToChunk.get(moduleId);
      if (previous !== undefined && previous !== chunk.fileName) {
        throw new Error(`Module is present in multiple output chunks: ${moduleId} -> ${previous}, ${chunk.fileName}`);
      }
      moduleToChunk.set(moduleId, chunk.fileName);
    }
  }
  return moduleToChunk;
}

function boundaryIdentityFromRegistrationModuleId(moduleId: string): string | undefined {
  const identity = parseResolvedBoundaryModuleId({ id: normalizedModuleId(moduleId) });
  return identity === undefined ? undefined : `${identity.boundaryId}/${identity.version}`;
}

function packModuleInfo({ moduleId, supportedLocales }: Readonly<{
  moduleId: string;
  supportedLocales: readonly string[];
}>): Readonly<{ locale: string; boundaryIdentity: string }> | undefined {
  const normalized = normalizedModuleId(moduleId);
  const identity = parseResolvedPackModuleIdentity({ id: normalized });
  if (identity === undefined) return undefined;
  if (!supportedLocales.includes(identity.locale)) {
    throw new Error(`Unknown Boundary Strings pack locale in module ID: ${normalized}`);
  }
  return {
    locale: identity.locale,
    boundaryIdentity: `${identity.boundaryId}/${identity.version}`,
  };
}

function isBoundaryLoaderEdge({
  sourceModuleId,
  targetModuleId,
  supportedLocales,
}: Readonly<{
  sourceModuleId: string;
  targetModuleId: string;
  supportedLocales: readonly string[];
}>): boolean {
  const sourceBoundaryIdentity = boundaryIdentityFromRegistrationModuleId(sourceModuleId);
  const targetPack = packModuleInfo({ moduleId: targetModuleId, supportedLocales });
  return sourceBoundaryIdentity !== undefined
    && targetPack !== undefined
    && sourceBoundaryIdentity === targetPack.boundaryIdentity;
}

function isDisabledForeignBoundaryLoader({
  sourceModuleId,
  targetModuleId,
  targetLocale,
  supportedLocales,
}: Readonly<{
  sourceModuleId: string;
  targetModuleId: string;
  targetLocale: string;
  supportedLocales: readonly string[];
}>): boolean {
  const targetPack = packModuleInfo({ moduleId: targetModuleId, supportedLocales });
  return targetPack !== undefined
    && targetPack.locale !== targetLocale
    && isBoundaryLoaderEdge({ sourceModuleId, targetModuleId, supportedLocales });
}

function followRetainedModuleClosure({
  start,
  moduleGraph,
  targetLocale,
  supportedLocales,
}: Readonly<{
  start: readonly string[];
  moduleGraph: PackageModuleGraph;
  targetLocale: string;
  supportedLocales: readonly string[];
}>): Set<string> {
  const visited = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const rawSourceId = queue.pop();
    if (rawSourceId === undefined) continue;
    const sourceId = normalizedModuleId(rawSourceId);
    if (visited.has(sourceId)) continue;
    visited.add(sourceId);
    const info = moduleGraph.get(sourceId);
    if (info === undefined) continue;

    for (const rawTargetId of info.importedIds) {
      const targetId = normalizedModuleId(rawTargetId);
      if (!visited.has(targetId) && moduleGraph.has(targetId)) queue.push(targetId);
    }
    for (const rawTargetId of info.dynamicallyImportedIds) {
      const targetId = normalizedModuleId(rawTargetId);
      if (isDisabledForeignBoundaryLoader({
        sourceModuleId: sourceId,
        targetModuleId: targetId,
        targetLocale,
        supportedLocales,
      })) continue;
      if (!visited.has(targetId) && moduleGraph.has(targetId)) queue.push(targetId);
    }
  }
  return visited;
}

function followStaticChunkClosure({
  start,
  chunksByFileName,
}: Readonly<{
  start: readonly string[];
  chunksByFileName: ReadonlyMap<string, PackageChunk>;
}>): Set<string> {
  const visited = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const fileName = stack.pop();
    if (fileName === undefined || visited.has(fileName)) continue;
    const chunk = chunksByFileName.get(fileName);
    if (chunk === undefined) throw new Error(`Chunk graph references missing output chunk: ${fileName}`);
    visited.add(fileName);
    for (const imported of chunk.imports) stack.push(imported);
  }
  return visited;
}

/**
 * Projects a locale package from module semantics first and physical chunks second.
 *
 * Rolldown may coalesce a Boundary registration and an unrelated shared helper into
 * one physical chunk. A locale pack can then statically depend on that shared chunk,
 * making the physical chunk graph appear cyclic across every locale loader even
 * though the pack module itself never reaches the foreign registration edge.
 * Package reachability therefore follows Rollup module provenance, cutting only
 * generated Boundary-registration -> foreign-pack dynamic edges. Physical chunks
 * are removed only after that semantic retained set is known.
 */
export function createLocalePackagePlan({
  chunks,
  moduleGraph,
  targetLocale,
  supportedLocales,
}: Readonly<{
  chunks: readonly PackageChunk[];
  moduleGraph: PackageModuleGraph;
  targetLocale: string;
  supportedLocales: readonly string[];
}>): LocalePackagePlan {
  if (!supportedLocales.includes(targetLocale)) throw new Error(`Unsupported target locale: ${targetLocale}`);
  if (new Set(supportedLocales).size !== supportedLocales.length) throw new Error('supportedLocales contains duplicates');

  const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  if (chunksByFileName.size !== chunks.length) throw new Error('Duplicate output chunk file names');
  for (const chunk of chunks) {
    for (const dependencyFileName of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!chunksByFileName.has(dependencyFileName)) {
        throw new Error(`Chunk graph references missing output chunk: ${dependencyFileName}`);
      }
    }
  }

  const infos = new Map<string, ReturnType<typeof chunkLocaleInfo>>();
  const rootChunksByLocale = new Map<string, Set<string>>(supportedLocales.map((locale) => [locale, new Set()]));
  const rootModulesByLocale = new Map<string, Set<string>>(supportedLocales.map((locale) => [locale, new Set()]));
  for (const chunk of chunks) {
    const info = chunkLocaleInfo({ chunk, supportedLocales });
    infos.set(chunk.fileName, info);
    for (const moduleId of renderedModuleIds(chunk)) {
      const locale = parsePackLocale({ moduleId, supportedLocales });
      if (locale === undefined) continue;
      rootChunksByLocale.get(locale)?.add(chunk.fileName);
      rootModulesByLocale.get(locale)?.add(moduleId);
    }
  }

  for (const locale of supportedLocales) {
    const roots = rootModulesByLocale.get(locale);
    if (roots === undefined || roots.size === 0) throw new Error(`No Boundary Strings pack root module found for locale: ${locale}`);
  }

  const entryModuleIds = [...moduleGraph]
    .filter(([, info]) => info.isEntry === true)
    .map(([moduleId]) => moduleId);
  if (entryModuleIds.length === 0) throw new Error('No semantic entry modules found');
  const fullModuleClosure = followModuleClosure({ start: entryModuleIds, moduleGraph });
  for (const [locale, roots] of rootModulesByLocale) {
    for (const root of roots) {
      if (!fullModuleClosure.has(root)) throw new Error(`Locale root module is unreachable from entries: ${locale} -> ${root}`);
    }
  }

  // Validate loader ownership at module level. Chunk-level incoming edges are not
  // authoritative once unrelated modules have been coalesced into one file.
  for (const [locale, roots] of rootModulesByLocale) {
    for (const root of roots) {
      let registrationDynamicIncoming = 0;
      for (const [sourceModuleId, sourceInfo] of moduleGraph) {
        if (sourceInfo.importedIds.includes(root)) {
          throw new Error(`Locale root module has a static incoming edge: ${locale} ${sourceModuleId} -> ${root}`);
        }
        if (!sourceInfo.dynamicallyImportedIds.includes(root)) continue;
        if (!isBoundaryLoaderEdge({
          sourceModuleId,
          targetModuleId: root,
          supportedLocales,
        })) {
          throw new Error(`Locale root module has a dynamic incoming edge outside its Boundary Strings registration: ${locale} ${sourceModuleId} -> ${root}`);
        }
        registrationDynamicIncoming += 1;
      }
      if (registrationDynamicIncoming === 0) {
        throw new Error(`Locale root module has no Boundary Strings registration dynamic incoming edge: ${locale} -> ${root}`);
      }
    }
  }

  const targetRootChunks = rootChunksByLocale.get(targetLocale) ?? new Set<string>();
  const foreignRootChunks = new Set<string>();
  for (const [locale] of rootModulesByLocale) {
    if (locale === targetLocale) continue;
    for (const rootChunk of rootChunksByLocale.get(locale) ?? []) foreignRootChunks.add(rootChunk);
  }

  const retainedModuleClosure = followRetainedModuleClosure({
    start: entryModuleIds,
    moduleGraph,
    targetLocale,
    supportedLocales,
  });
  const moduleToChunk = createModuleToChunkMap({ chunks });
  const renderedModuleIdSet = new Set(chunks.flatMap(renderedModuleIds));
  const retainedChunkSeeds = new Set<string>();
  for (const moduleId of retainedModuleClosure) {
    const ownerChunk = moduleToChunk.get(moduleId);
    if (ownerChunk === undefined) {
      // Semantic entry nodes such as Vite's index.html participate in the
      // module graph but are not rendered into a JavaScript output chunk.
      // Their rendered dependencies seed physical ownership instead.
      if (renderedModuleIdSet.has(moduleId)) {
        throw new Error(`Retained rendered module has no output chunk owner: ${moduleId}`);
      }
      continue;
    }
    retainedChunkSeeds.add(ownerChunk);
  }
  const requiredRetainedChunks = followStaticChunkClosure({
    start: [...retainedChunkSeeds],
    chunksByFileName,
  });

  // The foreign physical closure is deliberately conservative: coalescing can
  // make it pass through shared/target chunks. Those chunks are subtracted only
  // after module semantics have proven they are retained.
  const foreignChunkClosure = followClosure({
    start: [...foreignRootChunks],
    chunksByFileName,
  });
  const removeChunkFileNames = new Set(
    [...foreignChunkClosure].filter((fileName) => !requiredRetainedChunks.has(fileName)),
  );

  for (const root of targetRootChunks) {
    if (removeChunkFileNames.has(root)) {
      throw new Error(`Target locale root would be removed: ${targetLocale} -> ${root}`);
    }
  }
  for (const root of foreignRootChunks) {
    if (!removeChunkFileNames.has(root)) throw new Error(`Foreign locale root could not be removed: ${root}`);
  }

  const retainedChunkFileNames = new Set(chunks.map((chunk) => chunk.fileName).filter((fileName) => !removeChunkFileNames.has(fileName)));
  for (const fileName of retainedChunkFileNames) {
    const info = infos.get(fileName);
    if (info === undefined) throw new Error(`Missing locale information for ${fileName}`);
    for (const locale of info.payloadLocales) {
      if (locale !== targetLocale) {
        throw new Error(`Foreign Boundary Strings payload would remain in ${targetLocale} package: ${fileName} contains ${locale}`);
      }
    }
  }

  for (const chunk of chunks) {
    const info = infos.get(chunk.fileName);
    if (info === undefined) continue;
    if (info.payloadLocales.has(targetLocale) && !retainedChunkFileNames.has(chunk.fileName)) {
      throw new Error(`Target Boundary Strings payload would be removed: ${chunk.fileName}`);
    }
  }

  return {
    locale: targetLocale,
    removeChunkFileNames,
    retainedChunkFileNames,
    localeRootChunkFileNames: asSortedRecord(rootChunksByLocale),
  };
}

export function toPackageChunks(bundle: Readonly<Record<string, unknown>>): readonly PackageChunk[] {
  const chunks: PackageChunk[] = [];
  for (const value of Object.values(bundle)) {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'chunk') continue;
    const chunk = value as unknown as {
      fileName: string;
          isEntry: boolean;
      imports: readonly string[];
      dynamicImports: readonly string[];
      modules: Readonly<Record<string, RenderedModuleInfo>>;
    };
    chunks.push({
      fileName: chunk.fileName,
      isEntry: chunk.isEntry,
      imports: [...chunk.imports],
      dynamicImports: [...chunk.dynamicImports],
      modules: chunk.modules,
    });
  }
  return chunks;
}

export type PackageModuleGraphInfo = Readonly<{
  importedIds: readonly string[];
  dynamicallyImportedIds: readonly string[];
  isEntry?: boolean;
}>;

export type PackageModuleGraph = ReadonlyMap<string, PackageModuleGraphInfo>;

function followModuleClosure({
  start,
  moduleGraph,
}: Readonly<{
  start: readonly string[];
  moduleGraph: PackageModuleGraph;
}>): Set<string> {
  const visited = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const rawModuleId = queue.pop();
    if (rawModuleId === undefined) continue;
    const moduleId = normalizedModuleId(rawModuleId);
    if (visited.has(moduleId)) continue;
    visited.add(moduleId);
    const info = moduleGraph.get(moduleId);
    if (info === undefined) continue;
    for (const target of [...info.importedIds, ...info.dynamicallyImportedIds]) {
      const normalizedTarget = normalizedModuleId(target);
      if (!visited.has(normalizedTarget) && moduleGraph.has(normalizedTarget)) queue.push(normalizedTarget);
    }
  }
  return visited;
}

function packLocaleFromAnyModuleId({ moduleId, supportedLocales }: Readonly<{
  moduleId: string;
  supportedLocales: readonly string[];
}>): string | undefined {
  return packModuleInfo({ moduleId, supportedLocales })?.locale;
}

/**
 * Closes an ambiguity that chunk-level Rollup edges cannot resolve: a boundary
 * registration module and unrelated application code may be coalesced into the
 * same emitted chunk. In that case `chunk.dynamicImports` alone cannot prove
 * which source module owns an edge to a removable locale chunk.
 *
 * Every emitted module-level edge from retained code into a removed chunk must
 * therefore be explained by the one intentional pattern: a rendered Boundary
 * Strings registration module dynamically importing a foreign pack virtual
 * module. Any other retained -> removed edge fails closed.
 */
export function assertLocalePackageModuleEdgeSafety({
  chunks,
  plan,
  moduleGraph,
  supportedLocales,
}: Readonly<{
  chunks: readonly PackageChunk[];
  plan: LocalePackagePlan;
  moduleGraph: PackageModuleGraph;
  supportedLocales: readonly string[];
}>): void {
  const moduleToChunk = new Map<string, string>();
  for (const chunk of chunks) {
    for (const moduleId of renderedModuleIds(chunk)) {
      const normalized = normalizedModuleId(moduleId);
      const previous = moduleToChunk.get(normalized);
      if (previous !== undefined && previous !== chunk.fileName) {
        throw new Error(`Module is present in multiple output chunks: ${normalized} -> ${previous}, ${chunk.fileName}`);
      }
      moduleToChunk.set(normalized, chunk.fileName);
    }
  }

  for (const chunk of chunks) {
    if (!plan.retainedChunkFileNames.has(chunk.fileName)) continue;
    for (const sourceModuleId of renderedModuleIds(chunk)) {
      const moduleInfo = moduleGraph.get(sourceModuleId);
      if (moduleInfo === undefined) {
        throw new Error(`Missing module-edge provenance for rendered module: ${sourceModuleId}`);
      }

      for (const rawTargetId of moduleInfo.importedIds) {
        const targetId = normalizedModuleId(rawTargetId);
        const targetChunk = moduleToChunk.get(targetId);
        if (targetChunk !== undefined && plan.removeChunkFileNames.has(targetChunk)) {
          throw new Error(`Retained module statically imports a removed chunk: ${sourceModuleId} -> ${targetId} (${targetChunk})`);
        }
      }

      for (const rawTargetId of moduleInfo.dynamicallyImportedIds) {
        const targetId = normalizedModuleId(rawTargetId);
        const targetChunk = moduleToChunk.get(targetId);
        if (targetChunk === undefined || !plan.removeChunkFileNames.has(targetChunk)) continue;

        const isAuthorizedBoundaryLoader = isDisabledForeignBoundaryLoader({
          sourceModuleId,
          targetModuleId: targetId,
          targetLocale: plan.locale,
          supportedLocales,
        });
        if (!isAuthorizedBoundaryLoader) {
          throw new Error(`Retained module dynamically imports a removed chunk outside an authorized Boundary Strings loader: ${sourceModuleId} -> ${targetId} (${targetChunk})`);
        }
      }
    }
  }

  // Physical coalescing can retain a mixed chunk even when only one module
  // inside it belongs to the foreign locale closure. That is safe for execution
  // but silently defeats the package-size guarantee. Prove
  // at module level that every foreign-closure module left in a retained chunk
  // is independently reachable from the retained application/target-locale
  // graph after the authorized foreign Boundary loader edges are cut.
  const foreignPackModuleIds = new Set<string>();
  for (const chunk of chunks) {
    for (const moduleId of renderedModuleIds(chunk)) {
      const locale = packLocaleFromAnyModuleId({ moduleId, supportedLocales });
      if (locale !== undefined && locale !== plan.locale) foreignPackModuleIds.add(moduleId);
    }
  }
  const foreignModuleClosure = followModuleClosure({
    start: [...foreignPackModuleIds],
    moduleGraph,
  });
  const retainedModuleStarts = [...moduleGraph]
    .filter(([, info]) => info.isEntry === true)
    .map(([moduleId]) => moduleId);
  const retainedModuleClosure = followRetainedModuleClosure({
    start: retainedModuleStarts,
    moduleGraph,
    targetLocale: plan.locale,
    supportedLocales,
  });

  for (const moduleId of foreignModuleClosure) {
    const ownerChunk = moduleToChunk.get(moduleId);
    if (
      ownerChunk !== undefined
      && plan.retainedChunkFileNames.has(ownerChunk)
      && !retainedModuleClosure.has(moduleId)
    ) {
      throw new Error(`Foreign-only module would remain in ${plan.locale} package because of chunk coalescing: ${moduleId} (${ownerChunk})`);
    }
  }
}

/**
 * Configured Worker entries are retained roots of locale-specialized packages.
 * Keep their rendered module provenance explicit so Worker graph changes cannot
 * silently bypass the module-level package safety checks.
 */
export function assertLocalePackageWorkerEntryProvenance({
  moduleGraph,
  workerEntryModuleIds,
}: Readonly<{
  moduleGraph: PackageModuleGraph;
  workerEntryModuleIds: readonly string[];
}>): void {
  if (workerEntryModuleIds.length === 0) throw new Error('At least one standalone Worker entry is required');

  for (const rawWorkerEntryModuleId of workerEntryModuleIds) {
    const workerEntryModuleId = normalizedModuleId(rawWorkerEntryModuleId);
    if (!moduleGraph.has(workerEntryModuleId)) {
      throw new Error(`Missing module-edge provenance for standalone Worker entry: ${workerEntryModuleId}`);
    }
  }
}

export function collectPackageModuleGraph({
  chunks,
  getModuleIds,
  getModuleInfo,
}: Readonly<{
  chunks: readonly PackageChunk[];
  getModuleIds: () => IterableIterator<string>;
  getModuleInfo: (moduleId: string) => Readonly<{
    importedIds: readonly string[];
    dynamicallyImportedIds: readonly string[];
    isEntry: boolean;
  }> | null;
}>): PackageModuleGraph {
  const graph = new Map<string, PackageModuleGraphInfo>();

  // Keep the complete Rollup/Rolldown semantic module graph, including
  // non-rendered HTML/virtual nodes between semantic entries and rendered
  // output modules. Physical ownership is decided separately from chunk.modules.
  for (const rawModuleId of getModuleIds()) {
    const moduleId = normalizedModuleId(rawModuleId);
    const info = getModuleInfo(rawModuleId);
    if (info === null) {
      // Rolldown may expose its synthetic runtime without ModuleInfo. It is a
      // bundler-owned leaf and is the only accepted provenance exception.
      if (rawModuleId !== RUNTIME_MODULE_ID) {
        throw new Error(`Rollup getModuleInfo returned null for module graph ID: ${moduleId}`);
      }
      graph.set(moduleId, { importedIds: [], dynamicallyImportedIds: [] });
      continue;
    }
    graph.set(moduleId, {
      importedIds: info.importedIds.map(normalizedModuleId),
      dynamicallyImportedIds: info.dynamicallyImportedIds.map(normalizedModuleId),
      isEntry: info.isEntry,
    });
  }

  // Rendered modules should normally already be present in getModuleIds(). Check
  // them separately so bundler-generated rendered modules cannot silently lose
  // provenance, while retaining the narrow Rolldown runtime exception above.
  for (const chunk of chunks) {
    for (const [rawModuleId, rendered] of Object.entries(chunk.modules)) {
      if (rendered.renderedLength <= 0) continue;
      const moduleId = normalizedModuleId(rawModuleId);
      if (graph.has(moduleId)) continue;
      const info = getModuleInfo(rawModuleId);
      if (info === null) {
        if (rawModuleId !== RUNTIME_MODULE_ID) {
          throw new Error(`Rollup getModuleInfo returned null for rendered module: ${moduleId}`);
        }
        graph.set(moduleId, { importedIds: [], dynamicallyImportedIds: [] });
        continue;
      }
      graph.set(moduleId, {
        importedIds: info.importedIds.map(normalizedModuleId),
        dynamicallyImportedIds: info.dynamicallyImportedIds.map(normalizedModuleId),
        isEntry: info.isEntry,
      });
    }
  }
  return graph;
}
