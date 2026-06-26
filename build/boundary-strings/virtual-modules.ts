import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as ts from 'typescript';

import {
  compactedMessageKey,
  type BoundaryStringsCompactionState,
} from './compaction';

export const BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX = 'virtual:naidan-boundary-strings/boundary/';
export const RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX = `\0${BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX}`;
export const BOUNDARY_STRINGS_PACK_MODULE_PREFIX = 'virtual:naidan-boundary-strings/pack/';
export const RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX = `\0${BOUNDARY_STRINGS_PACK_MODULE_PREFIX}`;

export const BOUNDARY_STRING_LOCALES = ['en', 'ja'] as const;
export type BoundaryStringLocale = (typeof BOUNDARY_STRING_LOCALES)[number];

export type BoundaryStringMessageDefinition = {
  key: string;
  localeModulePaths: Record<BoundaryStringLocale, string>;
};

export type BoundaryStringBoundaryDefinition = {
  id: string;
  keys: readonly string[];
  moduleId: string;
};

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
};

const messageKeyPattern = /^[A-Za-z][A-Za-z0-9]*__[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const boundaryIdPattern = /^[a-f0-9]{16}$/;

function normalizeModulePath({ modulePath }: {
  modulePath: string;
}): string {
  return modulePath.replaceAll('\\', '/');
}

function hasExportModifier({ node }: {
  node: ts.Node;
}): boolean {
  return ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function catalogDisplayName({ locale }: {
  locale: BoundaryStringLocale;
}): string {
  switch (locale) {
  case 'en':
    return 'English';
  case 'ja':
    return 'Japanese';
  default: {
    const _exhaustive: never = locale;
    throw new Error(`Unsupported Boundary Strings locale: ${_exhaustive}`);
  }
  }
}

function messageKeyFromCatalogImport({ locale, moduleSpecifier }: {
  locale: BoundaryStringLocale;
  moduleSpecifier: string;
}): string | undefined {
  const prefix = '@/strings/messages/';
  if (!moduleSpecifier.startsWith(prefix)) {
    return undefined;
  }
  const segments = moduleSpecifier.slice(prefix.length).split('/');
  if (segments.length !== 2 || segments[1] !== locale) {
    return undefined;
  }
  const key = segments[0];
  return key === undefined || key.length === 0 ? undefined : key;
}

function unwrapCatalogInitializer({ initializer }: {
  initializer: ts.Expression;
}): ts.Expression {
  let current = initializer;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function parseCatalog({ catalogPath, locale }: {
  catalogPath: string;
  locale: BoundaryStringLocale;
}): readonly string[] {
  const displayName = catalogDisplayName({ locale });
  const catalogSource = fs.readFileSync(catalogPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    catalogPath,
    catalogSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  ) as SourceFileWithParseDiagnostics;
  if (sourceFile.parseDiagnostics.length > 0) {
    const details = sourceFile.parseDiagnostics.map((diagnostic) => {
      return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    }).join('\n');
    throw new Error(`[naidan-boundary-strings] Failed to parse ${catalogPath}:\n${details}`);
  }

  const catalogImports = new Map<string, string>();
  let catalogKeys: readonly string[] | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const key = messageKeyFromCatalogImport({
        locale,
        moduleSpecifier: statement.moduleSpecifier.text,
      });
      if (key === undefined) {
        continue;
      }
      const namedBindings = statement.importClause?.namedBindings;
      if (
        namedBindings === undefined
        || !ts.isNamedImports(namedBindings)
        || namedBindings.elements.length !== 1
      ) {
        throw new Error(
          `[naidan-boundary-strings] Invalid ${displayName} catalog import ${statement.getText(sourceFile)}.`,
        );
      }
      const importSpecifier = namedBindings.elements[0];
      if (importSpecifier === undefined || importSpecifier.isTypeOnly) {
        throw new Error(`[naidan-boundary-strings] ${displayName} catalog import has no value binding.`);
      }
      const importedName = importSpecifier.propertyName?.text ?? importSpecifier.name.text;
      const localName = importSpecifier.name.text;
      if (importedName !== key || localName !== key) {
        throw new Error(
          `[naidan-boundary-strings] ${displayName} catalog import for "${key}" must preserve the message identifier.`,
        );
      }
      if (catalogImports.has(localName)) {
        throw new Error(`[naidan-boundary-strings] Duplicate ${displayName} catalog import "${key}".`);
      }
      catalogImports.set(localName, key);
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declarations = statement.declarationList.declarations.filter((candidate) => {
      return ts.isIdentifier(candidate.name) && candidate.name.text === locale;
    });
    if (declarations.length === 0) {
      continue;
    }
    if (catalogKeys !== undefined || declarations.length !== 1 || !hasExportModifier({ node: statement })) {
      throw new Error(
        `[naidan-boundary-strings] ${displayName} catalog must export exactly one "${locale}" object.`,
      );
    }
    const declaration = declarations[0];
    if (declaration === undefined || declaration.initializer === undefined) {
      throw new Error(`[naidan-boundary-strings] ${displayName} catalog "${locale}" has no initializer.`);
    }
    const initializer = unwrapCatalogInitializer({ initializer: declaration.initializer });
    if (!ts.isObjectLiteralExpression(initializer)) {
      throw new Error(
        `[naidan-boundary-strings] ${displayName} catalog "${locale}" must be an object literal.`,
      );
    }
    const keys = initializer.properties.map((property) => {
      if (!ts.isShorthandPropertyAssignment(property)) {
        throw new Error(
          `[naidan-boundary-strings] ${displayName} catalog entries must use shorthand message identifiers.`,
        );
      }
      return property.name.text;
    });
    if (new Set(keys).size !== keys.length) {
      throw new Error(
        `[naidan-boundary-strings] ${displayName} catalog contains duplicate message entries.`,
      );
    }
    catalogKeys = keys;
  }

  if (catalogKeys === undefined) {
    throw new Error(`[naidan-boundary-strings] ${displayName} catalog "${locale}" was not found.`);
  }
  for (const key of catalogKeys) {
    if (catalogImports.get(key) !== key) {
      throw new Error(
        `[naidan-boundary-strings] ${displayName} catalog entry "${key}" has no matching named import.`,
      );
    }
  }
  const unusedImports = [...catalogImports.keys()].filter((key) => !catalogKeys.includes(key));
  if (unusedImports.length > 0) {
    throw new Error(
      `[naidan-boundary-strings] ${displayName} catalog imports messages that are not in its object: ${unusedImports.join(', ')}.`,
    );
  }
  return catalogKeys;
}

function validateCatalogParity({ englishKeys, locale, localeKeys }: {
  englishKeys: readonly string[];
  locale: BoundaryStringLocale;
  localeKeys: readonly string[];
}): void {
  const englishKeySet = new Set(englishKeys);
  const localeKeySet = new Set(localeKeys);
  const missing = englishKeys.filter((key) => !localeKeySet.has(key));
  const extra = localeKeys.filter((key) => !englishKeySet.has(key));
  if (missing.length === 0 && extra.length === 0) {
    return;
  }
  const details = [
    missing.length === 0 ? undefined : `missing: ${missing.join(', ')}`,
    extra.length === 0 ? undefined : `extra: ${extra.join(', ')}`,
  ].filter((value): value is string => value !== undefined).join('; ');
  throw new Error(
    `[naidan-boundary-strings] ${catalogDisplayName({ locale })} catalog does not match the English catalog (${details}).`,
  );
}

function validateMessageDirectories({ catalogKeys, root }: {
  catalogKeys: readonly string[];
  root: string;
}): void {
  const messagesDirectory = path.resolve(root, 'src/strings/messages');
  if (!fs.existsSync(messagesDirectory)) {
    throw new Error('[naidan-boundary-strings] Messages directory was not found.');
  }
  const catalogKeySet = new Set(catalogKeys);
  const orphanDirectories = fs.readdirSync(messagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !catalogKeySet.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (orphanDirectories.length > 0) {
    throw new Error(
      '[naidan-boundary-strings] Message directories are not registered in the English catalog: '
      + `${orphanDirectories.join(', ')}.`,
    );
  }
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

export function readBoundaryStringMessages({ root }: {
  root: string;
}): readonly BoundaryStringMessageDefinition[] {
  const englishCatalogPath = path.resolve(root, 'src/strings/catalogs/en.ts');
  if (!fs.existsSync(englishCatalogPath)) {
    return [];
  }

  const englishKeys = parseCatalog({
    catalogPath: englishCatalogPath,
    locale: 'en',
  });
  for (const locale of BOUNDARY_STRING_LOCALES) {
    switch (locale) {
    case 'en':
      break;
    case 'ja': {
      const catalogPath = path.resolve(root, `src/strings/catalogs/${locale}.ts`);
      if (!fs.existsSync(catalogPath)) {
        throw new Error(`[naidan-boundary-strings] Missing ${locale}.ts locale catalog.`);
      }
      const localeKeys = parseCatalog({ catalogPath, locale });
      validateCatalogParity({ englishKeys, locale, localeKeys });
      break;
    }
    default: {
      const _exhaustive: never = locale;
      throw new Error(`Unsupported Boundary Strings locale: ${_exhaustive}`);
    }
    }
  }
  validateMessageDirectories({ catalogKeys: englishKeys, root });

  return englishKeys.map((key) => {
    if (!messageKeyPattern.test(key)) {
      throw new Error(
        `[naidan-boundary-strings] Invalid message key "${key}". `
        + 'Expected <scope>__<natural_english_like_message>.',
      );
    }

    const localeModulePaths = Object.fromEntries(BOUNDARY_STRING_LOCALES.map((locale) => {
      const absolutePath = path.resolve(root, 'src/strings/messages', key, `${locale}.ts`);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(
          `[naidan-boundary-strings] Missing ${locale}.ts for catalog message "${key}".`,
        );
      }
      const relativePath = normalizeModulePath({ modulePath: path.relative(root, absolutePath) });
      return [locale, `/${relativePath}`];
    })) as Record<BoundaryStringLocale, string>;

    return {
      key,
      localeModulePaths,
    };
  });
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
  messages,
}: {
  boundary: BoundaryStringBoundaryDefinition;
  compactionState: BoundaryStringsCompactionState | undefined;
  locale: BoundaryStringLocale;
  messages: readonly BoundaryStringMessageDefinition[];
}): string {
  const messagesByKey = new Map(messages.map((message) => [message.key, message]));
  if (compactionState === undefined) {
    const reExports = boundary.keys.map((key) => {
      const message = messagesByKey.get(key);
      if (message === undefined) {
        throw new Error(`[naidan-boundary-strings] Unknown message key "${key}" in ${boundary.moduleId}.`);
      }
      return `export { ${key} } from ${JSON.stringify(message.localeModulePaths[locale])};`;
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
    imports.push(`import { ${key} } from ${JSON.stringify(message.localeModulePaths[locale])};`);
    properties.push(`${compactedMessageKey({ key, state: compactionState })}: ${key}`);
  }
  return `${imports.join('\n')}\n\nexport default {\n  ${properties.join(',\n  ')},\n};\n`;
}
