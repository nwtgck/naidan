import fs from 'node:fs';
import path from 'node:path';

import * as ts from 'typescript';

import { createBoundaryStringDiagnosticError } from './diagnostics';

export const BOUNDARY_STRING_LOCALES = ['en', 'ja'] as const;
export type BoundaryStringLocale = (typeof BOUNDARY_STRING_LOCALES)[number];

export type BoundaryStringLocaleModuleDefinition = {
  filePath: string;
  sourceModuleId: string;
};

export type BoundaryStringMessageDefinition = {
  key: string;
  modulesByLocale: Record<BoundaryStringLocale, BoundaryStringLocaleModuleDefinition>;
};

export type BoundaryStringMessageCatalog = {
  messages: readonly BoundaryStringMessageDefinition[];
  messagesByKey: ReadonlyMap<string, BoundaryStringMessageDefinition>;
};

export type BoundaryStringProjectPaths = {
  catalogFilePathsByLocale: Record<BoundaryStringLocale, string>;
  messagesDirectoryPath: string;
};

export type BoundaryStringFileKind = 'catalog' | 'message-module' | 'other';

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
};

const messageKeyPattern = /^[A-Za-z][A-Za-z0-9]*__[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function normalizeModulePath({ modulePath }: {
  modulePath: string;
}): string {
  return modulePath.replaceAll('\\', '/');
}

function isPathWithinDirectory({ directoryPath, filePath }: {
  directoryPath: string;
  filePath: string;
}): boolean {
  const relativePath = path.relative(directoryPath, filePath);
  return relativePath === ''
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)
    );
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
    throw createBoundaryStringDiagnosticError({
      code: 'catalog-parse-failed',
      message: `[naidan-boundary-strings] Failed to parse ${catalogPath}:\n${details}`,
    });
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
        throw createBoundaryStringDiagnosticError({
          code: 'catalog-shape-invalid',
          message: `[naidan-boundary-strings] Invalid ${displayName} catalog import ${statement.getText(sourceFile)}.`,
        });
      }
      const importSpecifier = namedBindings.elements[0];
      if (importSpecifier === undefined || importSpecifier.isTypeOnly) {
        throw createBoundaryStringDiagnosticError({
          code: 'catalog-shape-invalid',
          message: `[naidan-boundary-strings] ${displayName} catalog import has no value binding.`,
        });
      }
      const importedName = importSpecifier.propertyName?.text ?? importSpecifier.name.text;
      const localName = importSpecifier.name.text;
      if (importedName !== key || localName !== key) {
        throw createBoundaryStringDiagnosticError({
          code: 'catalog-shape-invalid',
          message: `[naidan-boundary-strings] ${displayName} catalog import for "${key}" must preserve the message identifier.`,
        });
      }
      if (catalogImports.has(localName)) {
        throw createBoundaryStringDiagnosticError({
          code: 'catalog-shape-invalid',
          message: `[naidan-boundary-strings] Duplicate ${displayName} catalog import "${key}".`,
        });
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
      throw createBoundaryStringDiagnosticError({
        code: 'catalog-shape-invalid',
        message: `[naidan-boundary-strings] ${displayName} catalog must export exactly one "${locale}" object.`,
      });
    }
    const declaration = declarations[0];
    if (declaration === undefined || declaration.initializer === undefined) {
      throw createBoundaryStringDiagnosticError({
        code: 'catalog-shape-invalid',
        message: `[naidan-boundary-strings] ${displayName} catalog "${locale}" has no initializer.`,
      });
    }
    const initializer = unwrapCatalogInitializer({ initializer: declaration.initializer });
    if (!ts.isObjectLiteralExpression(initializer)) {
      throw createBoundaryStringDiagnosticError({
        code: 'catalog-shape-invalid',
        message: `[naidan-boundary-strings] ${displayName} catalog "${locale}" must be an object literal.`,
      });
    }
    const keys = initializer.properties.map((property) => {
      if (!ts.isShorthandPropertyAssignment(property)) {
        throw createBoundaryStringDiagnosticError({
          code: 'catalog-shape-invalid',
          message: `[naidan-boundary-strings] ${displayName} catalog entries must use shorthand message identifiers.`,
        });
      }
      return property.name.text;
    });
    if (new Set(keys).size !== keys.length) {
      throw createBoundaryStringDiagnosticError({
        code: 'catalog-shape-invalid',
        message: `[naidan-boundary-strings] ${displayName} catalog contains duplicate message entries.`,
      });
    }
    catalogKeys = keys;
  }

  if (catalogKeys === undefined) {
    throw createBoundaryStringDiagnosticError({
      code: 'catalog-shape-invalid',
      message: `[naidan-boundary-strings] ${displayName} catalog "${locale}" was not found.`,
    });
  }
  const catalogKeySet = new Set(catalogKeys);
  for (const key of catalogKeys) {
    if (catalogImports.get(key) !== key) {
      throw createBoundaryStringDiagnosticError({
        code: 'catalog-shape-invalid',
        message: `[naidan-boundary-strings] ${displayName} catalog entry "${key}" has no matching named import.`,
      });
    }
  }
  const unusedImports = [...catalogImports.keys()].filter((key) => !catalogKeySet.has(key));
  if (unusedImports.length > 0) {
    throw createBoundaryStringDiagnosticError({
      code: 'catalog-shape-invalid',
      message: `[naidan-boundary-strings] ${displayName} catalog imports messages that are not in its object: ${unusedImports.join(', ')}.`,
    });
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
  throw createBoundaryStringDiagnosticError({
    code: 'catalog-locale-mismatch',
    message: `[naidan-boundary-strings] ${catalogDisplayName({ locale })} catalog does not match the English catalog (${details}).`,
  });
}

function validateMessageDirectories({ catalogKeys, paths }: {
  catalogKeys: readonly string[];
  paths: BoundaryStringProjectPaths;
}): void {
  if (!fs.existsSync(paths.messagesDirectoryPath)) {
    throw createBoundaryStringDiagnosticError({
      code: 'message-directory-not-found',
      message: '[naidan-boundary-strings] Messages directory was not found.',
    });
  }
  const catalogKeySet = new Set(catalogKeys);
  const orphanDirectories = fs.readdirSync(paths.messagesDirectoryPath, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory() || catalogKeySet.has(entry.name)) {
        return false;
      }
      const messageDirectory = path.join(paths.messagesDirectoryPath, entry.name);
      return fs.readdirSync(messageDirectory).length > 0;
    })
    .map((entry) => entry.name)
    .sort();
  if (orphanDirectories.length > 0) {
    throw createBoundaryStringDiagnosticError({
      code: 'message-directory-orphaned',
      message: '[naidan-boundary-strings] Message directories are not registered in the English catalog: '
        + `${orphanDirectories.join(', ')}.`,
    });
  }
}

export function createBoundaryStringProjectPaths({ root }: {
  root: string;
}): BoundaryStringProjectPaths {
  return {
    catalogFilePathsByLocale: {
      en: path.resolve(root, 'src/strings/catalogs/en.ts'),
      ja: path.resolve(root, 'src/strings/catalogs/ja.ts'),
    },
    messagesDirectoryPath: path.resolve(root, 'src/strings/messages'),
  };
}

export function boundaryStringMessageFilePath({ key, locale, paths }: {
  key: string;
  locale: BoundaryStringLocale;
  paths: BoundaryStringProjectPaths;
}): string {
  return path.resolve(paths.messagesDirectoryPath, key, `${locale}.ts`);
}

export function classifyBoundaryStringFile({ filePath, paths }: {
  filePath: string;
  paths: BoundaryStringProjectPaths;
}): BoundaryStringFileKind {
  const resolvedFilePath = path.resolve(filePath);
  if (BOUNDARY_STRING_LOCALES.some((locale) => {
    return resolvedFilePath === paths.catalogFilePathsByLocale[locale];
  })) {
    return 'catalog';
  }
  if (isPathWithinDirectory({
    directoryPath: paths.messagesDirectoryPath,
    filePath: resolvedFilePath,
  })) {
    return 'message-module';
  }
  return 'other';
}

export function readBoundaryStringMessageCatalog({ paths, root }: {
  paths: BoundaryStringProjectPaths;
  root: string;
}): BoundaryStringMessageCatalog {
  const englishCatalogPath = paths.catalogFilePathsByLocale.en;
  if (!fs.existsSync(englishCatalogPath)) {
    throw createBoundaryStringDiagnosticError({
      code: 'catalog-not-found',
      message: '[naidan-boundary-strings] English locale catalog was not found.',
    });
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
      const catalogPath = paths.catalogFilePathsByLocale[locale];
      if (!fs.existsSync(catalogPath)) {
        throw createBoundaryStringDiagnosticError({
          code: 'catalog-not-found',
          message: `[naidan-boundary-strings] Missing ${locale}.ts locale catalog.`,
        });
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
  validateMessageDirectories({ catalogKeys: englishKeys, paths });

  const messages = englishKeys.map((key): BoundaryStringMessageDefinition => {
    if (!messageKeyPattern.test(key)) {
      throw createBoundaryStringDiagnosticError({
        code: 'message-key-invalid',
        message: `[naidan-boundary-strings] Invalid message key "${key}". `
          + 'Expected <scope>__<natural_english_like_message>.',
      });
    }

    const modulesByLocale = Object.fromEntries(BOUNDARY_STRING_LOCALES.map((locale) => {
      const filePath = boundaryStringMessageFilePath({ key, locale, paths });
      if (!fs.existsSync(filePath)) {
        throw createBoundaryStringDiagnosticError({
          code: 'message-locale-file-missing',
          message: `[naidan-boundary-strings] Missing ${locale}.ts for catalog message "${key}".`,
        });
      }
      const relativePath = normalizeModulePath({ modulePath: path.relative(root, filePath) });
      return [locale, {
        filePath,
        sourceModuleId: `/${relativePath}`,
      }];
    })) as Record<BoundaryStringLocale, BoundaryStringLocaleModuleDefinition>;

    return {
      key,
      modulesByLocale,
    };
  });

  return {
    messages,
    messagesByKey: new Map(messages.map((message) => [message.key, message])),
  };
}
