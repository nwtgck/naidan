import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as ts from 'typescript';

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

const messageKeyPattern = /^[A-Za-z][A-Za-z0-9]*__[a-z][a-z0-9_]*$/;

function normalizeModulePath({ modulePath }: {
  modulePath: string;
}): string {
  return modulePath.replaceAll('\\', '/');
}

export function createBoundaryId({ moduleId }: {
  moduleId: string;
}): string {
  return crypto.createHash('sha256').update(normalizeModulePath({ modulePath: moduleId })).digest('hex').slice(0, 16);
}

export function readBoundaryStringMessages({ root }: {
  root: string;
}): readonly BoundaryStringMessageDefinition[] {
  const catalogPath = path.resolve(root, 'src/strings/catalogs/en.ts');
  if (!fs.existsSync(catalogPath)) {
    return [];
  }

  const catalogSource = fs.readFileSync(catalogPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    catalogPath,
    catalogSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const catalogImports = new Map<string, string>();
  let catalogKeys: readonly string[] | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleMatch = /^@\/strings\/messages\/([^/]+)\/en$/.exec(statement.moduleSpecifier.text);
      if (moduleMatch === null) {
        continue;
      }
      const key = moduleMatch[1];
      const namedBindings = statement.importClause?.namedBindings;
      if (
        key === undefined
        || namedBindings === undefined
        || !ts.isNamedImports(namedBindings)
        || namedBindings.elements.length !== 1
      ) {
        throw new Error(
          `[naidan-boundary-strings] Invalid English catalog import ${statement.getText(sourceFile)}.`,
        );
      }
      const importSpecifier = namedBindings.elements[0];
      if (importSpecifier === undefined) {
        throw new Error('[naidan-boundary-strings] English catalog import has no named binding.');
      }
      const importedName = importSpecifier.propertyName?.text ?? importSpecifier.name.text;
      const localName = importSpecifier.name.text;
      if (importedName !== key || localName !== key) {
        throw new Error(
          `[naidan-boundary-strings] English catalog import for "${key}" must preserve the message identifier.`,
        );
      }
      catalogImports.set(localName, key);
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declaration = statement.declarationList.declarations.find((candidate) => {
      return ts.isIdentifier(candidate.name) && candidate.name.text === 'en';
    });
    if (declaration === undefined || declaration.initializer === undefined) {
      continue;
    }
    if (!ts.isObjectLiteralExpression(declaration.initializer)) {
      throw new Error('[naidan-boundary-strings] English catalog "en" must be an object literal.');
    }
    catalogKeys = declaration.initializer.properties.map((property) => {
      if (!ts.isShorthandPropertyAssignment(property)) {
        throw new Error(
          '[naidan-boundary-strings] English catalog entries must use shorthand message identifiers.',
        );
      }
      return property.name.text;
    });
  }

  if (catalogKeys === undefined) {
    throw new Error('[naidan-boundary-strings] English catalog "en" was not found.');
  }

  return catalogKeys.map((key) => {
    if (!messageKeyPattern.test(key) || key.split('__').length !== 2) {
      throw new Error(
        `[naidan-boundary-strings] Invalid message key "${key}". `
        + 'Expected <scope>__<natural_english_like_message>.',
      );
    }
    if (catalogImports.get(key) !== key) {
      throw new Error(
        `[naidan-boundary-strings] English catalog entry "${key}" has no matching named import.`,
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

export function createBoundaryRegistrationModuleSource({ boundary }: {
  boundary: BoundaryStringBoundaryDefinition;
}): string {
  const loaders = Object.fromEntries(BOUNDARY_STRING_LOCALES.map((locale) => {
    return [locale, `__BOUNDARY_STRINGS_LOADER__${packModuleId({ boundaryId: boundary.id, locale })}`];
  }));
  const serializedLoaders = JSON.stringify(loaders, undefined, 2)
    .replaceAll(/"__BOUNDARY_STRINGS_LOADER__([^"]+)"/g, '() => import("$1")');

  return `\
import { registerStringBoundary } from "/src/strings/runtime.ts";

registerStringBoundary({
  boundaryId: ${JSON.stringify(boundary.id)},
  keys: ${JSON.stringify(boundary.keys, undefined, 2)},
  loaders: ${serializedLoaders},
});
`;
}

export function createBoundaryStringsPackModuleSource({
  boundary,
  locale,
  messages,
}: {
  boundary: BoundaryStringBoundaryDefinition;
  locale: BoundaryStringLocale;
  messages: readonly BoundaryStringMessageDefinition[];
}): string {
  const messagesByKey = new Map(messages.map((message) => [message.key, message]));
  const reExports = boundary.keys.map((key) => {
    const message = messagesByKey.get(key);
    if (message === undefined) {
      throw new Error(
        `[naidan-boundary-strings] Unknown message key "${key}" in ${boundary.moduleId}.`,
      );
    }
    return `export { ${key} } from ${JSON.stringify(message.localeModulePaths[locale])};`;
  });

  return `${reExports.join('\n')}\n`;
}
