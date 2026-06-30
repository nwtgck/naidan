import path from 'node:path';

import MagicString from 'magic-string';
import type { Plugin, ResolvedConfig } from 'vite';

import {
  analyzeBoundaryStringSource,
  type BoundaryStringSourceAnalysis,
} from './analyze';
import {
  createBoundaryStringCatalogState,
  type BoundaryStringCatalogResolution,
  type BoundaryStringCatalogState,
} from './catalog-state';
import {
  compactBoundaryStringsModule,
  createBoundaryStringsCompactionState,
  type BoundaryStringsCompactionState,
} from './compaction';
import {
  BoundaryStringDiagnosticError,
  createBoundaryStringDiagnosticModuleSource,
  unknownBoundaryDiagnostic,
  unknownMessageKeyDiagnostic,
  type BoundaryStringDiagnostic,
} from './diagnostics';
import {
  BOUNDARY_STRING_LOCALES,
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
  type BoundaryStringMessageCatalog,
  type BoundaryStringProjectPaths,
} from './message-catalog';
import {
  isSupportedSourceModuleId,
  normalizeModuleId,
  stripModuleQuery,
} from './module-id';
import {
  createBoundaryStringServeCoordinator,
  type BoundaryStringServeCoordinator,
} from './serve-coordinator';
import { boundaryStringProcessServeState } from './serve-session-state';
import {
  createBoundaryStringSourceRegistry,
  type BoundaryStringSourceRegistry,
} from './source-registry';
import {
  boundaryModuleId,
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

function boundaryRelativeModulePath({ moduleId, root }: {
  moduleId: string;
  root: string;
}): string | undefined {
  if (!shouldParseProjectSource({ moduleId, root })) {
    return undefined;
  }
  const relativePath = projectRelativeModulePath({ moduleId, root });
  if (relativePath === undefined || relativePath.startsWith('src/strings/')) {
    return undefined;
  }
  return relativePath;
}

function prependBoundaryImport({ boundary, code, moduleId }: {
  boundary: BoundaryStringBoundaryDefinition;
  code: string;
  moduleId: string;
}): { code: string; map: ReturnType<MagicString['generateMap']> } {
  const magicString = new MagicString(code);
  magicString.prepend(`import ${JSON.stringify(boundaryModuleId({
    boundaryId: boundary.id,
    version: boundary.version,
  }))};\n`);
  return {
    code: magicString.toString(),
    map: magicString.generateMap({
      hires: true,
      includeContent: true,
      source: moduleId,
    }),
  };
}

function addCatalogWatchFiles({ addWatchFile, paths }: {
  addWatchFile: (filePath: string) => void;
  paths: BoundaryStringProjectPaths;
}): void {
  for (const locale of BOUNDARY_STRING_LOCALES) {
    addWatchFile(paths.catalogFilePathsByLocale[locale]);
  }
}

function buildCatalogResolutionForBoundary({ boundary, catalog }: {
  boundary: BoundaryStringBoundaryDefinition;
  catalog: BoundaryStringMessageCatalog;
}): BoundaryStringCatalogResolution {
  const unknownKey = boundary.keys.find((key) => !catalog.messagesByKey.has(key));
  if (unknownKey !== undefined) {
    return {
      diagnostic: unknownMessageKeyDiagnostic({
        key: unknownKey,
        moduleId: boundary.moduleId,
      }),
      status: 'invalid',
    };
  }
  return {
    catalog,
    status: 'valid',
  };
}

export function createBoundaryStringsPlugin(): Plugin[] {
  let resolvedConfig: ResolvedConfig | undefined;
  let pluginMode: BoundaryStringPluginMode | undefined;
  let projectPaths: BoundaryStringProjectPaths | undefined;
  let catalogState: BoundaryStringCatalogState | undefined;
  let buildCatalog: BoundaryStringMessageCatalog | undefined;
  let compactionState: BoundaryStringsCompactionState | undefined;
  let serveCoordinator: BoundaryStringServeCoordinator | undefined;
  const serveCoordinators = new Set<BoundaryStringServeCoordinator>();
  let missingSourcePaths: Set<string> | undefined;
  const sourceRegistry: BoundaryStringSourceRegistry = createBoundaryStringSourceRegistry();

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

  function requireCatalogState(): BoundaryStringCatalogState {
    if (catalogState === undefined) {
      throw new Error('[naidan-boundary-strings] Development catalog state was not initialized.');
    }
    return catalogState;
  }

  function requireBuildCatalog(): BoundaryStringMessageCatalog {
    if (buildCatalog === undefined) {
      throw new Error('[naidan-boundary-strings] Build catalog was not initialized.');
    }
    return buildCatalog;
  }

  function requireServeCoordinator(): BoundaryStringServeCoordinator {
    if (serveCoordinator === undefined) {
      throw new Error('[naidan-boundary-strings] Development coordinator was not initialized.');
    }
    return serveCoordinator;
  }

  function requireMissingSourcePaths(): Set<string> {
    if (missingSourcePaths === undefined) {
      throw new Error('[naidan-boundary-strings] Development serve state was not initialized.');
    }
    return missingSourcePaths;
  }

  function disposeServeCoordinators(): void {
    for (const coordinator of serveCoordinators) {
      coordinator.dispose();
    }
    serveCoordinators.clear();
    serveCoordinator = undefined;
  }

  function readCatalogFromDisk(): BoundaryStringMessageCatalog {
    return readBoundaryStringMessageCatalog({
      paths: requireProjectPaths(),
      root: requireResolvedConfig().root,
    });
  }

  function resolveCatalogForBoundary({ boundary }: {
    boundary: BoundaryStringBoundaryDefinition;
  }): BoundaryStringCatalogResolution {
    const mode = requirePluginMode();
    switch (mode) {
    case 'serve':
      return requireCatalogState().resolveForBoundary({
        keys: boundary.keys,
        moduleId: boundary.moduleId,
      });
    case 'build':
      return buildCatalogResolutionForBoundary({
        boundary,
        catalog: requireBuildCatalog(),
      });
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
    }
    }
  }

  function sourceAnalysis({ code, moduleId }: {
    code: string;
    moduleId: string;
  }): BoundaryStringSourceAnalysis {
    try {
      return analyzeBoundaryStringSource({
        moduleId,
        sourceCode: code,
      });
    } catch (error) {
      sourceRegistry.removeSource({ moduleId });
      throw error;
    }
  }

  function diagnosticModuleOrThrow({ diagnostic }: {
    diagnostic: BoundaryStringDiagnostic;
  }): string {
    const mode = requirePluginMode();
    switch (mode) {
    case 'serve':
      return createBoundaryStringDiagnosticModuleSource({ diagnostic });
    case 'build':
      throw new BoundaryStringDiagnosticError({ diagnostic });
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
    }
    }
  }

  function registerSource({ analysis, moduleId }: {
    analysis: BoundaryStringSourceAnalysis;
    moduleId: string;
  }): void {
    const config = requireResolvedConfig();
    const record = sourceRegistry.replaceSource({
      analysis,
      boundaryRelativeModulePath: boundaryRelativeModulePath({
        moduleId,
        root: config.root,
      }),
      moduleId,
    });
    if (record.boundary === undefined) {
      return;
    }

    const mode = requirePluginMode();
    switch (mode) {
    case 'serve':
      requireServeCoordinator().watchSourceDirectory({ moduleId });
      break;
    case 'build': {
      const resolution = resolveCatalogForBoundary({ boundary: record.boundary });
      switch (resolution.status) {
      case 'valid':
        break;
      case 'invalid':
        throw new BoundaryStringDiagnosticError({ diagnostic: resolution.diagnostic });
      default: {
        const _exhaustive: never = resolution;
        throw new Error(
          `Unsupported Boundary Strings catalog resolution: ${String(_exhaustive)}`,
        );
      }
      }
      break;
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
    }
    }
  }

  function addVirtualModuleWatchFiles({ addWatchFile, boundary }: {
    addWatchFile: (filePath: string) => void;
    boundary: BoundaryStringBoundaryDefinition;
  }): void {
    addWatchFile(boundary.moduleId);
    const mode = requirePluginMode();
    switch (mode) {
    case 'serve':
      addWatchFile(requireServeCoordinator().revisionFilePath);
      break;
    case 'build':
      break;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
    }
    }
  }

  function loadBoundaryModule({ addWatchFile, boundaryId, version }: {
    addWatchFile: (filePath: string) => void;
    boundaryId: string;
    version: string;
  }): string {
    const boundary = sourceRegistry.getBoundary({ boundaryId, version });
    if (boundary === undefined) {
      const diagnostic = unknownBoundaryDiagnostic({ boundaryId, version });
      const mode = requirePluginMode();
      switch (mode) {
      case 'serve':
        addWatchFile(requireServeCoordinator().revisionFilePath);
        break;
      case 'build':
        break;
      default: {
        const _exhaustive: never = mode;
        throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
      }
      }
      return diagnosticModuleOrThrow({ diagnostic });
    }
    addVirtualModuleWatchFiles({ addWatchFile, boundary });
    const resolution = resolveCatalogForBoundary({ boundary });
    switch (resolution.status) {
    case 'invalid':
      return diagnosticModuleOrThrow({ diagnostic: resolution.diagnostic });
    case 'valid':
      return createBoundaryRegistrationModuleSource({
        boundary,
        compactionState,
      });
    default: {
      const _exhaustive: never = resolution;
      throw new Error(
        `Unsupported Boundary Strings catalog resolution: ${String(_exhaustive)}`,
      );
    }
    }
  }

  function loadPackModule({ addWatchFile, boundaryId, locale, version }: {
    addWatchFile: (filePath: string) => void;
    boundaryId: string;
    locale: (typeof BOUNDARY_STRING_LOCALES)[number];
    version: string;
  }): string {
    const boundary = sourceRegistry.getBoundary({ boundaryId, version });
    if (boundary === undefined) {
      const diagnostic = unknownBoundaryDiagnostic({ boundaryId, version });
      const mode = requirePluginMode();
      switch (mode) {
      case 'serve':
        addWatchFile(requireServeCoordinator().revisionFilePath);
        break;
      case 'build':
        break;
      default: {
        const _exhaustive: never = mode;
        throw new Error(`Unsupported Boundary Strings plugin mode: ${_exhaustive}`);
      }
      }
      return diagnosticModuleOrThrow({ diagnostic });
    }
    addVirtualModuleWatchFiles({ addWatchFile, boundary });
    const resolution = resolveCatalogForBoundary({ boundary });
    switch (resolution.status) {
    case 'invalid':
      return diagnosticModuleOrThrow({ diagnostic: resolution.diagnostic });
    case 'valid':
      for (const key of boundary.keys) {
        const message = resolution.catalog.messagesByKey.get(key);
        if (message !== undefined) {
          addWatchFile(message.modulesByLocale[locale].filePath);
        }
      }
      return createBoundaryStringsPackModuleSource({
        boundary,
        compactionState,
        locale,
        messagesByKey: resolution.catalog.messagesByKey,
      });
    default: {
      const _exhaustive: never = resolution;
      throw new Error(
        `Unsupported Boundary Strings catalog resolution: ${String(_exhaustive)}`,
      );
    }
    }
  }

  const analysisPlugin: Plugin = {
    name: 'naidan-boundary-strings-analyze',
    enforce: 'pre',
    configResolved(config) {
      resolvedConfig = config;
      pluginMode = config.command;
      projectPaths = createBoundaryStringProjectPaths({ root: config.root });
      switch (pluginMode) {
      case 'serve':
        sourceRegistry.reset();
        missingSourcePaths = boundaryStringProcessServeState({ root: config.root }).missingSourcePaths;
        catalogState = createBoundaryStringCatalogState({
          readCatalog: readCatalogFromDisk,
        });
        buildCatalog = undefined;
        compactionState = undefined;
        break;
      case 'build':
        disposeServeCoordinators();
        sourceRegistry.reset();
        missingSourcePaths = undefined;
        catalogState = undefined;
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
      const coordinator = createBoundaryStringServeCoordinator({
        catalogState: requireCatalogState(),
        missingSourcePaths: requireMissingSourcePaths(),
        paths: requireProjectPaths(),
        registry: sourceRegistry,
        server,
      });
      serveCoordinators.add(coordinator);
      serveCoordinator = coordinator;

      const closeServer = server.close.bind(server);
      server.close = async () => {
        coordinator.dispose();
        serveCoordinators.delete(coordinator);
        if (serveCoordinator === coordinator) {
          serveCoordinator = undefined;
        }
        await closeServer();
      };
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

      sourceRegistry.reset();
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
      const boundaryIdentity = parseResolvedBoundaryModuleId({ id });
      if (boundaryIdentity !== undefined) {
        return loadBoundaryModule({
          addWatchFile: (filePath) => this.addWatchFile(filePath),
          boundaryId: boundaryIdentity.boundaryId,
          version: boundaryIdentity.version,
        });
      }

      const packIdentity = parseResolvedPackModuleId({ id });
      if (packIdentity === undefined) {
        return undefined;
      }
      return loadPackModule({
        addWatchFile: (filePath) => this.addWatchFile(filePath),
        boundaryId: packIdentity.boundaryId,
        locale: packIdentity.locale,
        version: packIdentity.version,
      });
    },
    transform(code, id) {
      const config = requireResolvedConfig();
      if (!shouldParseProjectSource({ moduleId: id, root: config.root })) {
        return undefined;
      }
      const normalizedModuleId = normalizeModuleId({ moduleId: id });
      const analysis = sourceAnalysis({
        code,
        moduleId: normalizedModuleId,
      });
      registerSource({
        analysis,
        moduleId: normalizedModuleId,
      });
      return undefined;
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
      const boundary = sourceRegistry.getCurrentBoundary({
        moduleId: normalizedModuleId,
      });
      if (boundary === undefined) {
        return undefined;
      }
      return prependBoundaryImport({
        boundary,
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
      const analysis = sourceRegistry.getAnalysis({ moduleId: normalizedModuleId });
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
