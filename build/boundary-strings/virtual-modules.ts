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
  version: string;
};

const boundaryIdentityPartPattern = /^[a-f0-9]{16}$/;

function normalizeModulePath({ modulePath }: {
  modulePath: string;
}): string {
  return modulePath.replaceAll('\\', '/');
}

function requireBoundaryIdentityPart({ kind, moduleId, value }: {
  kind: 'boundary ID' | 'boundary version';
  moduleId: string;
  value: string;
}): string {
  if (!boundaryIdentityPartPattern.test(value)) {
    throw new Error(`[naidan-boundary-strings] Invalid ${kind} in virtual module ID "${moduleId}".`);
  }
  return value;
}

export function createBoundaryId({ moduleId }: {
  moduleId: string;
}): string {
  return crypto.createHash('sha256')
    .update(normalizeModulePath({ modulePath: moduleId }))
    .digest('hex')
    .slice(0, 16);
}

export function createBoundaryVersion({ keys, moduleId }: {
  keys: readonly string[];
  moduleId: string;
}): string {
  const hash = crypto.createHash('sha256');
  hash.update(normalizeModulePath({ modulePath: moduleId }));
  for (const key of keys) {
    hash.update('\0');
    hash.update(key);
  }
  return hash.digest('hex').slice(0, 16);
}

export function boundaryModuleId({ boundaryId, version }: {
  boundaryId: string;
  version: string;
}): string {
  return `${BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX}${boundaryId}/${version}`;
}

export function packModuleId({ boundaryId, locale, version }: {
  boundaryId: string;
  locale: BoundaryStringLocale;
  version: string;
}): string {
  return `${BOUNDARY_STRINGS_PACK_MODULE_PREFIX}${locale}/${boundaryId}/${version}`;
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
}): { boundaryId: string; version: string } | undefined {
  if (!id.startsWith(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX)) {
    return undefined;
  }
  const segments = id.slice(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX.length).split('/');
  if (segments.length !== 2) {
    throw new Error(`[naidan-boundary-strings] Invalid boundary module ID "${id}".`);
  }
  const [boundaryIdValue, versionValue] = segments;
  if (boundaryIdValue === undefined || versionValue === undefined) {
    throw new Error(`[naidan-boundary-strings] Invalid boundary module ID "${id}".`);
  }
  return {
    boundaryId: requireBoundaryIdentityPart({
      kind: 'boundary ID',
      moduleId: id,
      value: boundaryIdValue,
    }),
    version: requireBoundaryIdentityPart({
      kind: 'boundary version',
      moduleId: id,
      value: versionValue,
    }),
  };
}

export function parseResolvedPackModuleId({ id }: {
  id: string;
}): {
  boundaryId: string;
  locale: BoundaryStringLocale;
  version: string;
} | undefined {
  if (!id.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX)) {
    return undefined;
  }
  const segments = id.slice(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX.length).split('/');
  if (segments.length !== 3) {
    throw new Error(`[naidan-boundary-strings] Invalid pack module ID "${id}".`);
  }
  const [localeValue, boundaryIdValue, versionValue] = segments;
  const locale = BOUNDARY_STRING_LOCALES.find((candidate) => candidate === localeValue);
  if (locale === undefined) {
    throw new Error(`[naidan-boundary-strings] Unsupported locale "${String(localeValue)}".`);
  }
  if (boundaryIdValue === undefined || versionValue === undefined) {
    throw new Error(`[naidan-boundary-strings] Invalid pack module ID "${id}".`);
  }
  return {
    boundaryId: requireBoundaryIdentityPart({
      kind: 'boundary ID',
      moduleId: id,
      value: boundaryIdValue,
    }),
    locale,
    version: requireBoundaryIdentityPart({
      kind: 'boundary version',
      moduleId: id,
      value: versionValue,
    }),
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
    const moduleId = JSON.stringify(packModuleId({
      boundaryId: boundary.id,
      locale,
      version: boundary.version,
    }));
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
