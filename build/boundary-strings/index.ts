import path from 'node:path';

import MagicString from 'magic-string';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';

import {
  analyzeBoundaryStringSource,
  type BoundaryStringSourceAnalysis,
} from './analyze';
import {
  compactBoundaryStringsModule,
  createBoundaryStringsCompactionState,
  type BoundaryStringsCompactionState,
} from './compaction';
import {
  BOUNDARY_STRING_LOCALES,
  boundaryStringMessageFilePath,
  classifyBoundaryStringFile,
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
  type BoundaryStringMessageCatalog,
  type BoundaryStringProjectPaths,
} from './message-catalog';
import {
  createBoundaryStringMessageCatalogCache,
  type BoundaryStringMessageCatalogCache,
} from './message-catalog-cache';
import {
  isSupportedSourceModuleId,
  normalizeModuleId,
  stripModuleQuery,
} from './module-id';
import {
  boundaryModuleId,
  createBoundaryId,
  createBoundaryRegistrationModuleSource,
  createBoundaryStringsPackModuleSource,
  parseResolvedBoundaryModuleId,
  parseResolvedPackModuleId,
  resolveBoundaryStringsVirtualId,
  type BoundaryStringBoundaryDefinition,
} from './virtual-modules';

// Boundary Strings preserves key-per-file authoring without either eagerly
// loading every locale message or producing one dynamic chunk per message. The
// plugin discovers the keys used by each existing JavaScript module boundary
// and generates one virtual locale pack for that boundary. This keeps copy
// ownership independent from chunk ownership and lets Vite/Rolldown retain
// control of the hosted and standalone chunk graph.

type BoundaryStringPluginMode = 'serve' | 'build';

type BoundaryUpdateResult =
  | {
      status: 'unchanged';
    }
  | {
      affectedBoundaryIds: ReadonlySet<string>;
      status: 'changed';
    };

function projectRelativeModulePath({ moduleId, root }: {
  moduleId: string;
  root: string;
}): string | undefined {
  const filePath = stripModuleQuery({ moduleId });
  const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
  if (relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath;
}

function isProjectModule({ moduleId, root }: {
  moduleId: string;
  root: string;
}): boolean {
  const relativePath = projectRelativeModulePath({ moduleId, root });
  return relativePath !== undefined
    && !relativePath.startsWith('build/')
    && !relativePath.startsWith('node_modules/');
}

function shouldParseProjectSource({ moduleId, root }: {
  moduleId: string;
  root: string;
}): boolean {
  return !moduleId.includes('?')
    && isSupportedSourceModuleId({ moduleId })
    && isProjectModule({ moduleId, root });
}

function shouldCreateBoundary({ moduleId, root }: {
  moduleId: string;
  root: string;
}): boolean {
  if (!shouldParseProjectSource({ moduleId, root })) {
    return false;
  }
  const relativePath = projectRelativeModulePath({ moduleId, root });
  return relativePath !== undefined && !relativePath.startsWith('src/strings/');
}

function prependBoundaryImport({ boundaryId, code, moduleId }: {
  boundaryId: string;
  code: string;
  moduleId: string;
}): { code: string; map: ReturnType<MagicString['generateMap']> } {
  const magicString = new MagicString(code);
  magicString.prepend(`import ${JSON.stringify(boundaryModuleId({ boundaryId }))};\n`);
  return {
    code: magicString.toString(),
    map: magicString.generateMap({
      hires: true,
      includeContent: true,
      source: moduleId,
    }),
  };
}

function sameKeys({ left, right }: {
  left: readonly string[];
  right: readonly string[];
}): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function addCatalogWatchFiles({ addWatchFile, paths }: {
  addWatchFile: (filePath: string) => void;
  paths: BoundaryStringProjectPaths;
}): void {
  for (const locale of BOUNDARY_STRING_LOCALES) {
    addWatchFile(paths.catalogFilePathsByLocale[locale]);
  }
}

function assertKnownMessageKeys({ analysis, catalog, moduleId }: {
  analysis: BoundaryStringSourceAnalysis;
  catalog: BoundaryStringMessageCatalog;
  moduleId: string;
}): void {
  for (const key of analysis.keys) {
    if (!catalog.messagesByKey.has(key)) {
      throw new Error(`[naidan-boundary-strings] Unknown message key "${key}" in ${moduleId}.`);
    }
  }
}

export function createBoundaryStringsPlugin(): Plugin[] {
  let resolvedConfig: ResolvedConfig | undefined;
  let pluginMode: BoundaryStringPluginMode | undefined;
  let projectPaths: BoundaryStringProjectPaths | undefined;
  let catalogCache: BoundaryStringMessageCatalogCache | undefined;
  let buildCatalog: BoundaryStringMessageCatalog | undefined;
  let compactionState: BoundaryStringsCompactionState | undefined;
  let configuredServer: ViteDevServer | undefined;
  const boundaries = new Map<string, BoundaryStringBoundaryDefinition>();
  const boundaryIdsByModuleId = new Map<string, string>();
  const sourceAnalyses = new Map<string, BoundaryStringSourceAnalysis>();

  function requireResolvedConfig(): ResolvedConfig {
    if (resolvedConfig === undefined) {
      throw new Error('[naidan-boundary-strings] Vite config was not resolved.');
    }
    return resolvedConfig;
  }

  function requirePluginMode(): BoundaryStringPluginMode {
    if (pluginMode === undefined) {
      throw new Error('[naidan-boundary-strings] Plugin mode was not initialized.');
    }
    return pluginMode;
  }

  function requireProjectPaths(): BoundaryStringProjectPaths {
    if (projectPaths === undefined) {
      throw new Error('[naidan-boundary-strings] Project paths were not initialized.');
    }
    return projectPaths;
  }

  function requireCatalogCache(): BoundaryStringMessageCatalogCache {
    if (catalogCache === undefined) {
      throw new Error('[naidan-boundary-strings] Development catalog cache was not initialized.');
    }
    return catalogCache;
  }

  function requireBuildCatalog(): BoundaryStringMessageCatalog {
    if (buildCatalog === undefined) {
      throw new Error('[naidan-boundary-strings] Build catalog was not initialized.');
    }
    return buildCatalog;
  }

  function readCatalogFromDisk(): BoundaryStringMessageCatalog {
    return readBoundaryStringMessageCatalog({
      paths: requireProjectPaths(),
      root: requireResolvedConfig().root,
    });
  }

  function catalogForLoad(): BoundaryStringMessageCatalog {
    const mode = requirePluginMode();
    switch (mode) {
    case 'serve':
      return requireCatalogCache().read({ refresh: 'if-stale' }).catalog;
    case 'build':
      return requireBuildCatalog();
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
    }
    }
  }

  function catalogForAnalysis({ analysis, moduleId }: {
    analysis: BoundaryStringSourceAnalysis;
    moduleId: string;
  }): BoundaryStringMessageCatalog {
    const mode = requirePluginMode();
    switch (mode) {
    case 'build': {
      const catalog = requireBuildCatalog();
      assertKnownMessageKeys({ analysis, catalog, moduleId });
      return catalog;
    }
    case 'serve': {
      const cache = requireCatalogCache();
      const firstRead = cache.read({ refresh: 'if-stale' });
      const hasUnknownKey = analysis.keys.some((key) => {
        return !firstRead.catalog.messagesByKey.has(key);
      });
      if (!hasUnknownKey) {
        return firstRead.catalog;
      }
      let latestCatalog: BoundaryStringMessageCatalog;
      switch (firstRead.refreshResult) {
      case 'performed':
        latestCatalog = firstRead.catalog;
        break;
      case 'not-needed':
        latestCatalog = cache.read({ refresh: 'force' }).catalog;
        break;
      default: {
        const _exhaustive: never = firstRead.refreshResult;
        throw new Error(`Unsupported Boundary Strings catalog refresh result: ${_exhaustive}`);
      }
      }
      assertKnownMessageKeys({ analysis, catalog: latestCatalog, moduleId });
      return latestCatalog;
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
    }
    }
  }

  function addAnalysisWatchFiles({ addWatchFile, analysis }: {
    addWatchFile: (filePath: string) => void;
    analysis: BoundaryStringSourceAnalysis;
  }): void {
    if (analysis.keys.length === 0) {
      return;
    }
    const paths = requireProjectPaths();
    addCatalogWatchFiles({ addWatchFile, paths });
    for (const key of analysis.keys) {
      for (const locale of BOUNDARY_STRING_LOCALES) {
        addWatchFile(boundaryStringMessageFilePath({ key, locale, paths }));
      }
    }
  }

  function updateBoundary({ analysis, moduleId }: {
    analysis: BoundaryStringSourceAnalysis;
    moduleId: string;
  }): BoundaryUpdateResult {
    const previousBoundaryId = boundaryIdsByModuleId.get(moduleId);
    if (analysis.keys.length === 0) {
      if (previousBoundaryId === undefined) {
        return { status: 'unchanged' };
      }
      boundaries.delete(previousBoundaryId);
      boundaryIdsByModuleId.delete(moduleId);
      return {
        affectedBoundaryIds: new Set([previousBoundaryId]),
        status: 'changed',
      };
    }

    const relativeModulePath = projectRelativeModulePath({
      moduleId,
      root: requireResolvedConfig().root,
    });
    if (relativeModulePath === undefined) {
      throw new Error(`[naidan-boundary-strings] Boundary module is outside the project root: ${moduleId}.`);
    }
    const boundaryId = createBoundaryId({ moduleId: relativeModulePath });
    const previousBoundary = boundaries.get(boundaryId);
    if (previousBoundary !== undefined && previousBoundary.moduleId !== moduleId) {
      throw new Error(
        `[naidan-boundary-strings] Boundary ID collision between ${previousBoundary.moduleId} and ${moduleId}.`,
      );
    }
    if (
      previousBoundary !== undefined
      && previousBoundary.moduleId === moduleId
      && previousBoundaryId === boundaryId
      && sameKeys({ left: previousBoundary.keys, right: analysis.keys })
    ) {
      return { status: 'unchanged' };
    }

    if (previousBoundaryId !== undefined && previousBoundaryId !== boundaryId) {
      boundaries.delete(previousBoundaryId);
    }
    boundaries.set(boundaryId, {
      id: boundaryId,
      keys: analysis.keys,
      moduleId,
    });
    boundaryIdsByModuleId.set(moduleId, boundaryId);
    return {
      affectedBoundaryIds: new Set(
        [previousBoundaryId, boundaryId].filter((value): value is string => value !== undefined),
      ),
      status: 'changed',
    };
  }

  function invalidateAnalyzedSourceModules({ server }: {
    server: ViteDevServer;
  }): void {
    for (const [moduleId, analysis] of sourceAnalyses) {
      if (analysis.keys.length === 0) {
        continue;
      }
      const moduleNode = server.moduleGraph.getModuleById(moduleId);
      if (moduleNode !== undefined) {
        server.moduleGraph.invalidateModule(moduleNode);
      }
    }
  }

  function invalidateBoundaryVirtualModules({ boundaryIds, server }: {
    boundaryIds: ReadonlySet<string> | undefined;
    server: ViteDevServer;
  }): void {
    for (const moduleNode of server.moduleGraph.idToModuleMap.values()) {
      const boundaryId = parseResolvedBoundaryModuleId({ id: moduleNode.id ?? '' })
        ?? parseResolvedPackModuleId({ id: moduleNode.id ?? '' })?.boundaryId;
      if (boundaryId !== undefined && (boundaryIds === undefined || boundaryIds.has(boundaryId))) {
        server.moduleGraph.invalidateModule(moduleNode);
      }
    }
  }

  function invalidateBoundaryUpdate({ server, update }: {
    server: ViteDevServer | undefined;
    update: BoundaryUpdateResult;
  }): void {
    if (server === undefined) {
      return;
    }
    switch (update.status) {
    case 'unchanged':
      return;
    case 'changed':
      invalidateBoundaryVirtualModules({
        boundaryIds: update.affectedBoundaryIds,
        server,
      });
      return;
    default: {
      const _exhaustive: never = update;
      throw new Error(
        `Unsupported Boundary Strings boundary update: ${String(_exhaustive)}`,
      );
    }
    }
  }

  function analyzeAndUpdateSource({ addWatchFile, code, moduleId }: {
    addWatchFile: ((filePath: string) => void) | undefined;
    code: string;
    moduleId: string;
  }): {
    analysis: BoundaryStringSourceAnalysis;
    update: BoundaryUpdateResult;
  } {
    const analysis = analyzeBoundaryStringSource({
      moduleId,
      sourceCode: code,
    });
    if (addWatchFile !== undefined) {
      addAnalysisWatchFiles({ addWatchFile, analysis });
    }

    const config = requireResolvedConfig();
    let update: BoundaryUpdateResult;
    if (shouldCreateBoundary({ moduleId, root: config.root })) {
      if (analysis.keys.length > 0) {
        catalogForAnalysis({ analysis, moduleId });
      }
      update = updateBoundary({ analysis, moduleId });
    } else {
      update = { status: 'unchanged' };
    }

    sourceAnalyses.set(moduleId, analysis);
    return { analysis, update };
  }

  function addBoundaryModuleWatchFiles({ addWatchFile, boundary }: {
    addWatchFile: (filePath: string) => void;
    boundary: BoundaryStringBoundaryDefinition;
  }): void {
    addWatchFile(boundary.moduleId);
    addCatalogWatchFiles({
      addWatchFile,
      paths: requireProjectPaths(),
    });
  }

  const analysisPlugin: Plugin = {
    name: 'naidan-boundary-strings-analyze',
    enforce: 'pre',
    configResolved(config) {
      resolvedConfig = config;
      pluginMode = config.command;
      projectPaths = createBoundaryStringProjectPaths({ root: config.root });
      switch (pluginMode) {
      case 'serve': {
        const initialCatalog = readCatalogFromDisk();
        catalogCache = createBoundaryStringMessageCatalogCache({
          initialCatalog,
          readCatalog: readCatalogFromDisk,
        });
        buildCatalog = undefined;
        compactionState = undefined;
        break;
      }
      case 'build':
        catalogCache = undefined;
        buildCatalog = undefined;
        compactionState = undefined;
        break;
      default: {
        const _exhaustive: never = pluginMode;
        throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
      }
      }
    },
    configureServer(server) {
      configuredServer = server;
      const paths = requireProjectPaths();
      server.watcher.add([
        ...BOUNDARY_STRING_LOCALES.map((locale) => paths.catalogFilePathsByLocale[locale]),
        paths.messagesDirectoryPath,
      ]);
      const handleWatchEvent = ({ event, filePath }: {
        event: 'add' | 'change' | 'unlink';
        filePath: string;
      }): void => {
        const kind = classifyBoundaryStringFile({
          filePath,
          paths,
        });
        switch (kind) {
        case 'catalog':
          requireCatalogCache().markStale();
          invalidateAnalyzedSourceModules({ server });
          break;
        case 'message-module':
          if (event === 'add' || event === 'unlink') {
            requireCatalogCache().markStale();
            invalidateAnalyzedSourceModules({ server });
          }
          break;
        case 'other':
          return;
        default: {
          const _exhaustive: never = kind;
          throw new Error(`Unsupported Boundary Strings file kind: ${_exhaustive}`);
        }
        }

        if ((event === 'add' || event === 'unlink') && server.config.server.hmr !== false) {
          invalidateBoundaryVirtualModules({ boundaryIds: undefined, server });
          server.ws.send({ type: 'full-reload' });
        }
      };
      server.watcher.on('add', (filePath) => {
        handleWatchEvent({ event: 'add', filePath });
      });
      server.watcher.on('change', (filePath) => {
        handleWatchEvent({ event: 'change', filePath });
      });
      server.watcher.on('unlink', (filePath) => {
        handleWatchEvent({ event: 'unlink', filePath });
      });
    },
    buildStart() {
      const mode = requirePluginMode();
      switch (mode) {
      case 'serve':
        return;
      case 'build':
        break;
      default: {
        const _exhaustive: never = mode;
        throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
      }
      }
      const paths = requireProjectPaths();
      addCatalogWatchFiles({
        addWatchFile: (filePath) => this.addWatchFile(filePath),
        paths,
      });
      this.addWatchFile(paths.messagesDirectoryPath);
      const nextCatalog = readCatalogFromDisk();
      for (const message of nextCatalog.messages) {
        for (const locale of BOUNDARY_STRING_LOCALES) {
          this.addWatchFile(message.modulesByLocale[locale].filePath);
        }
      }
      const nextCompactionState = createBoundaryStringsCompactionState({
        root: requireResolvedConfig().root,
        messages: nextCatalog.messages,
      });
      buildCatalog = nextCatalog;
      compactionState = nextCompactionState;
    },
    resolveId(id) {
      return resolveBoundaryStringsVirtualId({ id });
    },
    load(id) {
      const boundaryId = parseResolvedBoundaryModuleId({ id });
      if (boundaryId !== undefined) {
        const boundary = boundaries.get(boundaryId);
        if (boundary === undefined) {
          throw new Error(`[naidan-boundary-strings] Unknown boundary "${boundaryId}".`);
        }
        addBoundaryModuleWatchFiles({
          addWatchFile: (filePath) => this.addWatchFile(filePath),
          boundary,
        });
        return createBoundaryRegistrationModuleSource({ boundary, compactionState });
      }

      const packId = parseResolvedPackModuleId({ id });
      if (packId === undefined) {
        return undefined;
      }
      const boundary = boundaries.get(packId.boundaryId);
      if (boundary === undefined) {
        throw new Error(`[naidan-boundary-strings] Unknown boundary "${packId.boundaryId}".`);
      }
      addBoundaryModuleWatchFiles({
        addWatchFile: (filePath) => this.addWatchFile(filePath),
        boundary,
      });
      const catalog = catalogForLoad();
      for (const key of boundary.keys) {
        const message = catalog.messagesByKey.get(key);
        const filePath = message?.modulesByLocale[packId.locale].filePath
          ?? boundaryStringMessageFilePath({
            key,
            locale: packId.locale,
            paths: requireProjectPaths(),
          });
        this.addWatchFile(filePath);
      }
      return createBoundaryStringsPackModuleSource({
        boundary,
        compactionState,
        locale: packId.locale,
        messagesByKey: catalog.messagesByKey,
      });
    },
    transform(code, id) {
      const config = requireResolvedConfig();
      if (!shouldParseProjectSource({ moduleId: id, root: config.root })) {
        return undefined;
      }
      const normalizedModuleId = normalizeModuleId({ moduleId: id });
      const { update } = analyzeAndUpdateSource({
        addWatchFile: (filePath) => this.addWatchFile(filePath),
        code,
        moduleId: normalizedModuleId,
      });
      invalidateBoundaryUpdate({ server: configuredServer, update });
      return undefined;
    },
    async handleHotUpdate({ file, read, server }) {
      const normalizedFile = normalizeModuleId({ moduleId: file });
      const kind = classifyBoundaryStringFile({
        filePath: normalizedFile,
        paths: requireProjectPaths(),
      });
      switch (kind) {
      case 'catalog':
        requireCatalogCache().markStale();
        invalidateAnalyzedSourceModules({ server });
        invalidateBoundaryVirtualModules({ boundaryIds: undefined, server });
        server.ws.send({ type: 'full-reload' });
        return [];
      case 'message-module':
        invalidateBoundaryVirtualModules({ boundaryIds: undefined, server });
        server.ws.send({ type: 'full-reload' });
        return [];
      case 'other':
        break;
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unsupported Boundary Strings file kind: ${_exhaustive}`);
      }
      }

      const config = requireResolvedConfig();
      if (!shouldParseProjectSource({ moduleId: normalizedFile, root: config.root })) {
        return undefined;
      }

      const { update } = analyzeAndUpdateSource({
        addWatchFile: undefined,
        code: await read(),
        moduleId: normalizedFile,
      });
      invalidateBoundaryUpdate({ server, update });
      switch (update.status) {
      case 'unchanged':
        return undefined;
      case 'changed':
        server.ws.send({ type: 'full-reload' });
        return [];
      default: {
        const _exhaustive: never = update;
        throw new Error(
          `Unsupported Boundary Strings boundary update: ${String(_exhaustive)}`,
        );
      }
      }
    },
  };

  const injectionPlugin: Plugin = {
    name: 'naidan-boundary-strings-inject',
    enforce: 'post',
    transform(code, id) {
      if (id.includes('?')) {
        return undefined;
      }
      const normalizedModuleId = normalizeModuleId({ moduleId: id });
      const boundaryId = boundaryIdsByModuleId.get(normalizedModuleId);
      if (boundaryId === undefined) {
        return undefined;
      }
      return prependBoundaryImport({
        boundaryId,
        code,
        moduleId: normalizedModuleId,
      });
    },
  };

  const compactionPlugin: Plugin = {
    name: 'naidan-boundary-strings-compact',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      const config = requireResolvedConfig();
      if (requirePluginMode() !== 'build' || !isProjectModule({ moduleId: id, root: config.root })) {
        return undefined;
      }
      if (compactionState === undefined) {
        throw new Error('[naidan-boundary-strings] Production compaction state was not initialized.');
      }
      const normalizedModuleId = normalizeModuleId({ moduleId: id });
      const analysis = sourceAnalyses.get(normalizedModuleId);
      return compactBoundaryStringsModule({
        allowedBindingNames: analysis?.importedBindingNames ?? [],
        code,
        moduleId: id,
        state: compactionState,
      });
    },
  };

  return [analysisPlugin, injectionPlugin, compactionPlugin];
}
