import path from 'node:path';

import type { Plugin, ResolvedConfig } from 'vite';

import { collectBoundaryStringKeys } from './analyze';
import {
  BOUNDARY_STRING_LOCALES,
  BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX,
  BOUNDARY_STRINGS_PACK_MODULE_PREFIX,
  boundaryModuleId,
  createBoundaryId,
  createBoundaryRegistrationModuleSource,
  createBoundaryStringsPackModuleSource,
  packModuleId,
  readBoundaryStringMessages,
  RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX,
  RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX,
  type BoundaryStringBoundaryDefinition,
  type BoundaryStringLocale,
} from './virtual-modules';

// Boundary Strings exists to preserve key-per-file authoring without paying either
// of the two common runtime costs: eagerly loading every locale message or
// producing one dynamic chunk per message. The plugin discovers the keys used
// by each already-existing JavaScript module boundary and generates one virtual
// locale pack for that boundary. This keeps copy ownership independent from
// chunk ownership, avoids loading strings for screens that have not loaded, and
// lets Vite/Rolldown keep deciding the actual hosted and standalone chunk graph.
// A plain import.meta.glob loader cannot provide all three properties at once:
// no manually maintained packs, no unused-screen text, and no request per key.

const supportedSourcePattern = /\.(?:[cm]?[jt]sx?|vue)$/;

function stripQuery({ moduleId }: {
  moduleId: string;
}): string {
  return moduleId.split('?', 1)[0] ?? moduleId;
}

function shouldAnalyzeModule({ moduleId, root }: {
  moduleId: string;
  root: string;
}): boolean {
  if (moduleId.includes('?')) {
    return false;
  }
  const filePath = stripQuery({ moduleId });
  if (!supportedSourcePattern.test(filePath)) {
    return false;
  }
  if (!filePath.startsWith(root)) {
    return false;
  }

  const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
  return !relativePath.startsWith('src/strings/')
    && !relativePath.startsWith('build/')
    && !relativePath.startsWith('node_modules/');
}

function injectBoundaryImport({ boundaryId, code, moduleId }: {
  boundaryId: string;
  code: string;
  moduleId: string;
}): string {
  const importStatement = `import ${JSON.stringify(boundaryModuleId({ boundaryId }))};`;
  if (!stripQuery({ moduleId }).endsWith('.vue')) {
    return `${importStatement}\n${code}`;
  }

  const scriptSetupMatch = /<script\s+setup(?:\s[^>]*)?>/.exec(code);
  if (scriptSetupMatch !== null && scriptSetupMatch.index !== undefined) {
    const insertionIndex = scriptSetupMatch.index + scriptSetupMatch[0].length;
    return `${code.slice(0, insertionIndex)}\n${importStatement}${code.slice(insertionIndex)}`;
  }

  const scriptMatch = /<script(?:\s[^>]*)?>/.exec(code);
  if (scriptMatch !== null && scriptMatch.index !== undefined) {
    const insertionIndex = scriptMatch.index + scriptMatch[0].length;
    return `${code.slice(0, insertionIndex)}\n${importStatement}${code.slice(insertionIndex)}`;
  }

  return `<script setup lang="ts">\n${importStatement}\n</script>\n${code}`;
}

export function createBoundaryStringsPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;
  let messages = readBoundaryStringMessages({ root: process.cwd() });
  const boundaries = new Map<string, BoundaryStringBoundaryDefinition>();

  function requireResolvedConfig(): ResolvedConfig {
    if (resolvedConfig === undefined) {
      throw new Error('[naidan-boundary-strings] Vite config was not resolved.');
    }
    return resolvedConfig;
  }

  return {
    name: 'naidan-boundary-strings',
    enforce: 'pre',
    configResolved(config) {
      resolvedConfig = config;
      messages = readBoundaryStringMessages({ root: config.root });
    },
    resolveId(id) {
      if (id.startsWith(BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX)) {
        return `\0${id}`;
      }
      if (id.startsWith(BOUNDARY_STRINGS_PACK_MODULE_PREFIX)) {
        return `\0${id}`;
      }
      return undefined;
    },
    load(id) {
      if (id.startsWith(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX)) {
        const boundaryId = id.slice(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX.length);
        const boundary = boundaries.get(boundaryId);
        if (boundary === undefined) {
          throw new Error(`[naidan-boundary-strings] Unknown boundary "${boundaryId}".`);
        }
        return createBoundaryRegistrationModuleSource({ boundary });
      }
      if (!id.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX)) {
        return undefined;
      }

      const remainder = id.slice(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX.length);
      const separatorIndex = remainder.indexOf('/');
      if (separatorIndex < 0) {
        throw new Error(`[naidan-boundary-strings] Invalid pack module ID "${id}".`);
      }
      const localeValue = remainder.slice(0, separatorIndex);
      const boundaryId = remainder.slice(separatorIndex + 1);
      const locale = BOUNDARY_STRING_LOCALES.find((candidate) => candidate === localeValue);
      if (locale === undefined) {
        throw new Error(`[naidan-boundary-strings] Unsupported locale "${localeValue}".`);
      }
      const boundary = boundaries.get(boundaryId);
      if (boundary === undefined) {
        throw new Error(`[naidan-boundary-strings] Unknown boundary "${boundaryId}".`);
      }

      return createBoundaryStringsPackModuleSource({
        boundary,
        locale: locale as BoundaryStringLocale,
        messages,
      });
    },
    transform(code, id) {
      const config = requireResolvedConfig();
      if (!shouldAnalyzeModule({ moduleId: id, root: config.root })) {
        return undefined;
      }

      const keys = collectBoundaryStringKeys({ sourceCode: code });
      if (keys.length === 0) {
        return undefined;
      }

      const knownKeys = new Set(messages.map((message) => message.key));
      for (const key of keys) {
        if (!knownKeys.has(key)) {
          throw new Error(
            `[naidan-boundary-strings] Unknown message key "${key}" in ${stripQuery({ moduleId: id })}.`,
          );
        }
      }

      const normalizedModuleId = stripQuery({ moduleId: id });
      const boundaryId = createBoundaryId({ moduleId: normalizedModuleId });
      boundaries.set(boundaryId, {
        id: boundaryId,
        keys,
        moduleId: normalizedModuleId,
      });

      return {
        code: injectBoundaryImport({ boundaryId, code, moduleId: normalizedModuleId }),
        map: null,
      };
    },
    handleHotUpdate({ file, server }) {
      const normalizedFile = file.replaceAll('\\', '/');
      const isMessageModule = normalizedFile.includes('/src/strings/messages/');
      const isCatalog = normalizedFile.endsWith('/src/strings/catalogs/en.ts')
        || normalizedFile.endsWith('/src/strings/catalogs/ja.ts');
      if (!isMessageModule && !isCatalog) {
        return undefined;
      }
      messages = readBoundaryStringMessages({ root: requireResolvedConfig().root });
      for (const moduleNode of server.moduleGraph.idToModuleMap.values()) {
        if (
          moduleNode.id?.startsWith(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX) === true
          || moduleNode.id?.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX) === true
        ) {
          server.moduleGraph.invalidateModule(moduleNode);
        }
      }
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
