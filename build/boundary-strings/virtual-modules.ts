import crypto from 'node:crypto';

import {
  compactedMessageKey,
  type BoundaryStringsCompactionState,
} from './compaction';
import {
  BOUNDARY_STRING_LOCALES,
  type BoundaryStringLocale,
  type BoundaryStringMessageDefinition,
} from './message-catalog';

export const BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX = 'virtual:naidan-boundary-strings/boundary/';
export const RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX = `\0${BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX}`;
export const BOUNDARY_STRINGS_PACK_MODULE_PREFIX = 'virtual:naidan-boundary-strings/pack/';
export const RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX = `\0${BOUNDARY_STRINGS_PACK_MODULE_PREFIX}`;

export type BoundaryStringBoundaryDefinition = {
  id: string;
  keys: readonly string[];
  moduleId: string;
};

const boundaryIdPattern = /^[a-f0-9]{16}$/;

function normalizeModulePath({ modulePath }: {
  modulePath: string;
}): string {
  return modulePath.replaceAll('\\', '/');
}

function requireBoundaryId({ boundaryId, moduleId }: {
  boundaryId: string;
  moduleId: string;
}): string {
  if (!boundaryIdPattern.test(boundaryId)) {
    throw new Error(`[naidan-boundary-strings] Invalid boundary module ID "${moduleId}".`);
  }
  return boundaryId;
}

export function createBoundaryId({ moduleId }: {
  moduleId: string;
}): string {
  return crypto.createHash('sha256').update(normalizeModulePath({ modulePath: moduleId })).digest('hex').slice(0, 16);
}

export function boundaryModuleId({ boundaryId }: {
  boundaryId: string;
}): string {
  return `${BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX}${boundaryId}`;
}

export function packModuleId({ boundaryId, locale }: {
  boundaryId: string;
  locale: BoundaryStringLocale;
}): string {
  return `${BOUNDARY_STRINGS_PACK_MODULE_PREFIX}${locale}/${boundaryId}`;
}

export function resolveBoundaryStringsVirtualId({ id }: {
  id: string;
}): string | undefined {
  if (
    id.startsWith(BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX)
    || id.startsWith(BOUNDARY_STRINGS_PACK_MODULE_PREFIX)
  ) {
    return `\0${id}`;
  }
  return undefined;
}

export function parseResolvedBoundaryModuleId({ id }: {
  id: string;
}): string | undefined {
  if (!id.startsWith(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX)) {
    return undefined;
  }
  const boundaryId = id.slice(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX.length);
  return requireBoundaryId({ boundaryId, moduleId: id });
}

export function parseResolvedPackModuleId({ id }: {
  id: string;
}): { boundaryId: string; locale: BoundaryStringLocale } | undefined {
  if (!id.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX)) {
    return undefined;
  }
  const segments = id.slice(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX.length).split('/');
  if (segments.length !== 2) {
    throw new Error(`[naidan-boundary-strings] Invalid pack module ID "${id}".`);
  }
  const [localeValue, boundaryIdValue] = segments;
  const locale = BOUNDARY_STRING_LOCALES.find((candidate) => candidate === localeValue);
  if (locale === undefined) {
    throw new Error(`[naidan-boundary-strings] Unsupported locale "${String(localeValue)}".`);
  }
  if (boundaryIdValue === undefined) {
    throw new Error(`[naidan-boundary-strings] Invalid pack module ID "${id}".`);
  }
  return {
    boundaryId: requireBoundaryId({ boundaryId: boundaryIdValue, moduleId: id }),
    locale,
  };
}

export function createBoundaryRegistrationModuleSource({ boundary, compactionState }: {
  boundary: BoundaryStringBoundaryDefinition;
  compactionState: BoundaryStringsCompactionState | undefined;
}): string {
  const keys = compactionState === undefined
    ? boundary.keys
    : boundary.keys.map((key) => compactedMessageKey({ key, state: compactionState }));
  const serializedLoaders = `{\n${BOUNDARY_STRING_LOCALES.map((locale) => {
    const moduleId = JSON.stringify(packModuleId({ boundaryId: boundary.id, locale }));
    const loader = compactionState === undefined
      ? `() => import(${moduleId})`
      : `() => import(${moduleId}).then((module) => module.default)`;
    return `  ${locale}: ${loader}`;
  }).join(',\n')}\n}`;

  return `\
import { registerStringBoundary } from "/src/strings/runtime.ts";

registerStringBoundary({
  boundaryId: ${JSON.stringify(boundary.id)},
  keys: ${JSON.stringify(keys, undefined, 2)},
  loaders: ${serializedLoaders},
});
`;
}

export function createBoundaryStringsPackModuleSource({
  boundary,
  compactionState,
  locale,
  messagesByKey,
}: {
  boundary: BoundaryStringBoundaryDefinition;
  compactionState: BoundaryStringsCompactionState | undefined;
  locale: BoundaryStringLocale;
  messagesByKey: ReadonlyMap<string, BoundaryStringMessageDefinition>;
}): string {
  if (compactionState === undefined) {
    const reExports = boundary.keys.map((key) => {
      const message = messagesByKey.get(key);
      if (message === undefined) {
        throw new Error(`[naidan-boundary-strings] Unknown message key "${key}" in ${boundary.moduleId}.`);
      }
      return `export { ${key} } from ${JSON.stringify(message.modulesByLocale[locale].sourceModuleId)};`;
    });
    return `${reExports.join('\n')}\n`;
  }

  // Production packs use compact object properties because a general property
  // mangler cannot coordinate call sites, boundary metadata, locale modules,
  // and the runtime registry without risking mismatched message lookups.
  const imports: string[] = [];
  const properties: string[] = [];
  for (const key of boundary.keys) {
    const message = messagesByKey.get(key);
    if (message === undefined) {
      throw new Error(`[naidan-boundary-strings] Unknown message key "${key}" in ${boundary.moduleId}.`);
    }
    imports.push(`import { ${key} } from ${JSON.stringify(message.modulesByLocale[locale].sourceModuleId)};`);
    properties.push(`${compactedMessageKey({ key, state: compactionState })}: ${key}`);
  }
  return `${imports.join('\n')}\n\nexport default {\n  ${properties.join(',\n  ')},\n};\n`;
}
