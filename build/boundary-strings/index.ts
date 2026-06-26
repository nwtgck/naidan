import path from 'node:path';

import MagicString from 'magic-string';
import type { Plugin, ResolvedConfig } from 'vite';

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
  readBoundaryStringMessages,
  resolveBoundaryStringsVirtualId,
  type BoundaryStringBoundaryDefinition,
  type BoundaryStringMessageDefinition,
} from './virtual-modules';

// Boundary Strings preserves key-per-file authoring without either eagerly
// loading every locale message or producing one dynamic chunk per message. The
// plugin discovers the keys used by each existing JavaScript module boundary
// and generates one virtual locale pack for that boundary. This keeps copy
// ownership independent from chunk ownership and lets Vite/Rolldown retain
// control of the hosted and standalone chunk graph.

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

export function createBoundaryStringsPlugin(): Plugin[] {
  let resolvedConfig: ResolvedConfig | undefined;
  let messages: readonly BoundaryStringMessageDefinition[] = [];
  let compactionState: BoundaryStringsCompactionState | undefined;
  let isProductionBuild = false;
  const boundaries = new Map<string, BoundaryStringBoundaryDefinition>();
  const boundaryIdsByModuleId = new Map<string, string>();
  const sourceAnalyses = new Map<string, BoundaryStringSourceAnalysis>();

  function requireResolvedConfig(): ResolvedConfig {
    if (resolvedConfig === undefined) {
      throw new Error('[naidan-boundary-strings] Vite config was not resolved.');
    }
    return resolvedConfig;
  }

  function updateBoundary({ analysis, moduleId }: {
    analysis: BoundaryStringSourceAnalysis;
    moduleId: string;
  }): void {
    const previousBoundaryId = boundaryIdsByModuleId.get(moduleId);
    if (analysis.keys.length === 0) {
      if (previousBoundaryId !== undefined) {
        boundaries.delete(previousBoundaryId);
        boundaryIdsByModuleId.delete(moduleId);
      }
      return;
    }

    const knownKeys = new Set(messages.map((message) => message.key));
    for (const key of analysis.keys) {
      if (!knownKeys.has(key)) {
        throw new Error(`[naidan-boundary-strings] Unknown message key "${key}" in ${moduleId}.`);
      }
    }

    const boundaryId = createBoundaryId({ moduleId });
    const previousBoundary = boundaries.get(boundaryId);
    if (
      previousBoundary !== undefined
      && previousBoundary.moduleId === moduleId
      && sameKeys({ left: previousBoundary.keys, right: analysis.keys })
    ) {
      boundaryIdsByModuleId.set(moduleId, boundaryId);
      return;
    }
    boundaries.set(boundaryId, {
      id: boundaryId,
      keys: analysis.keys,
      moduleId,
    });
    boundaryIdsByModuleId.set(moduleId, boundaryId);
  }

  const analysisPlugin: Plugin = {
    name: 'naidan-boundary-strings-analyze',
    enforce: 'pre',
    configResolved(config) {
      resolvedConfig = config;
      isProductionBuild = config.command === 'build';
      messages = readBoundaryStringMessages({ root: config.root });
      compactionState = isProductionBuild
        ? createBoundaryStringsCompactionState({ root: config.root, messages })
        : undefined;
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
      return createBoundaryStringsPackModuleSource({
        boundary,
        compactionState,
        locale: packId.locale,
        messages,
      });
    },
    transform(code, id) {
      const config = requireResolvedConfig();
      if (!shouldParseProjectSource({ moduleId: id, root: config.root })) {
        return undefined;
      }
      const normalizedModuleId = normalizeModuleId({ moduleId: id });
      const analysis = analyzeBoundaryStringSource({
        moduleId: normalizedModuleId,
        sourceCode: code,
      });
      sourceAnalyses.set(normalizedModuleId, analysis);
      if (shouldCreateBoundary({ moduleId: id, root: config.root })) {
        updateBoundary({ analysis, moduleId: normalizedModuleId });
      }
      return undefined;
    },
    handleHotUpdate({ file, server }) {
      const config = requireResolvedConfig();
      const normalizedFile = normalizeModuleId({ moduleId: file });
      const relativePath = projectRelativeModulePath({
        moduleId: normalizedFile,
        root: config.root,
      });
      const isMessageModule = relativePath?.startsWith('src/strings/messages/') === true;
      const isCatalog = relativePath === 'src/strings/catalogs/en.ts'
        || relativePath === 'src/strings/catalogs/ja.ts';

      const boundaryId = boundaryIdsByModuleId.get(normalizedFile);
      if (boundaryId !== undefined) {
        const boundaryModule = server.moduleGraph.getModuleById(`\0${boundaryModuleId({ boundaryId })}`);
        if (boundaryModule !== undefined) {
          server.moduleGraph.invalidateModule(boundaryModule);
        }
      }

      if (!isMessageModule && !isCatalog) {
        return undefined;
      }
      messages = readBoundaryStringMessages({ root: config.root });
      for (const moduleNode of server.moduleGraph.idToModuleMap.values()) {
        if (
          parseResolvedBoundaryModuleId({ id: moduleNode.id ?? '' }) !== undefined
          || parseResolvedPackModuleId({ id: moduleNode.id ?? '' }) !== undefined
        ) {
          server.moduleGraph.invalidateModule(moduleNode);
        }
      }
      server.ws.send({ type: 'full-reload' });
      return [];
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
      if (!isProductionBuild || !isProjectModule({ moduleId: id, root: config.root })) {
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
