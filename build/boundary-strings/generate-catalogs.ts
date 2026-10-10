import fs from 'node:fs';
import path from 'node:path';

import {
  BOUNDARY_STRING_LOCALES,
  createBoundaryStringProjectPaths,
  isBoundaryStringMessageKey,
  type BoundaryStringLocale,
} from './message-catalog';

function displayPath({ root, filePath }: { root: string; filePath: string }): string {
  return path.relative(root, filePath).replaceAll('\\', '/');
}

function readMessageKeys({ root, messagesDirectoryPath }: {
  root: string;
  messagesDirectoryPath: string;
}): string[] {
  if (!fs.lstatSync(messagesDirectoryPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected a messages directory: ${displayPath({ root, filePath: messagesDirectoryPath })}`);
  }

  const keys: string[] = [];
  const errors: string[] = [];
  const entries = fs.readdirSync(messagesDirectoryPath, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    // Files such as AGENTS.md are documentation, not message definitions.
    if (entry.isFile()) {
      continue;
    }
    const directory = path.join(messagesDirectoryPath, entry.name);
    if (!entry.isDirectory()) {
      errors.push(`Expected a regular message directory, not a link: ${displayPath({ root, filePath: directory })}`);
      continue;
    }
    if (!isBoundaryStringMessageKey({ key: entry.name })) {
      errors.push(`Invalid message key "${entry.name}"; expected <scope>__<natural_english_like_message>.`);
      continue;
    }
    keys.push(entry.name);
    for (const locale of BOUNDARY_STRING_LOCALES) {
      const filePath = path.join(directory, `${locale}.ts`);
      if (!fs.lstatSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        errors.push(`Missing or non-regular locale file: ${displayPath({ root, filePath })}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(['Cannot generate string catalogs:', ...errors.map(error => `  ${error}`)].join('\n'));
  }
  if (keys.length === 0) {
    throw new Error('No message directories found; existing catalogs have not been changed.');
  }

  // The directory enumeration was sorted without a locale-sensitive comparator.
  // Keep each group in that order and preserve the shared-copy ownership warning.
  return [
    ...keys.filter(key => key.startsWith('SHARED__')),
    ...keys.filter(key => !key.startsWith('SHARED__')),
  ];
}

function renderCatalog({ keys, locale }: {
  keys: readonly string[];
  locale: BoundaryStringLocale;
}): string {
  const lines = [
    '// Generated from src/strings/messages/ and src/01-models/ui-locale.ts.',
    '// Run `npm run strings:catalogs` to regenerate; `npm run strings:catalogs:check` to compare.',
    '',
  ];
  if (keys.some(key => key.startsWith('SHARED__'))) {
    lines.push(
      '// SHARED__ keys intentionally couple every call site to one product-wide copy decision.',
      '// Do not use this scope for deduplication or unclear ownership; follow messages/AGENTS.md.',
    );
  }
  lines.push(...keys.map(key => `import { ${key} } from '@/strings/messages/${key}/${locale}';`));
  lines.push('');
  const contract = (() => {
    // eslint-disable-next-line local-rules-switch/force-switch-for-union -- English defines the types; all other registered locales share one contract without a second locale list.
    if (locale === 'en') {
      return {
        declarations: [
          '/* eslint-disable local-rules-named-args/require-named-args -- This catalog contract accepts either supported message signature without weakening each message\'s exact type. */',
          'type BoundaryStringMessage = (() => string) | ((args: never) => string);',
          '/* eslint-enable local-rules-named-args/require-named-args */',
          'type BoundaryStringCatalog = Readonly<Record<string, BoundaryStringMessage>>;',
        ],
        constraint: 'BoundaryStringCatalog',
        exports: ['', 'export type Strings = typeof catalog;', 'export type StringKey = keyof Strings;'],
      };
    }
    return { declarations: ["import type { Strings } from './en';"], constraint: 'Strings', exports: [] };
  })();
  lines.push(...contract.declarations);
  lines.push('', 'export const catalog = {');
  if (keys.some(key => key.startsWith('SHARED__'))) {
    lines.push('  // SHARED__ intentionally couples every call site. Follow messages/AGENTS.md.');
  }
  lines.push(...keys.map(key => `  ${key},`));
  lines.push(`} satisfies ${contract.constraint};`, ...contract.exports);
  return `${lines.join('\n')}\n`;
}

function replaceCatalog({ filePath, content }: { filePath: string; content: string }): void {
  // Stage beside the destination, then rename: a failed write cannot truncate an
  // existing catalog. The set of locale files is not a multi-file transaction.
  const directory = fs.mkdtempSync(path.join(path.dirname(filePath), '.strings-catalog-'));
  try {
    const temporaryFile = path.join(directory, 'catalog.ts');
    fs.writeFileSync(temporaryFile, content, 'utf8');
    fs.renameSync(temporaryFile, filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function synchronizeStringCatalogs({ root, mode }: {
  root: string;
  mode: 'write' | 'check';
}): { changedFiles: string[]; messageCount: number; localeCount: number } {
  const paths = createBoundaryStringProjectPaths({ root });
  const keys = readMessageKeys({ root, messagesDirectoryPath: paths.messagesDirectoryPath });
  const catalogDirectory = path.dirname(paths.catalogFilePathsByLocale.en);
  const directoryStat = fs.lstatSync(catalogDirectory, { throwIfNoEntry: false });
  if (directoryStat !== undefined) {
    if (!directoryStat.isDirectory()) {
      throw new Error(`Expected a regular catalog directory: ${displayPath({ root, filePath: catalogDirectory })}`);
    }
    const expectedNames = new Set(BOUNDARY_STRING_LOCALES.map(locale => `${locale}.ts`));
    const unexpected = fs.readdirSync(catalogDirectory)
      .filter(name => name.endsWith('.ts') && !expectedNames.has(name))
      .sort();
    if (unexpected.length > 0) {
      throw new Error(`Unexpected locale catalogs: ${unexpected.join(', ')}. Review the supported locales or remove these files explicitly; no files have been changed.`);
    }
  }

  // Validate every input and read every destination before the first write.
  // No message implementation is imported, executed, or rewritten here. The
  // generated imports and satisfies contracts leave export/signature checking
  // to TypeScript rather than imposing a second message-function grammar.
  const changed = BOUNDARY_STRING_LOCALES.flatMap(locale => {
    const filePath = paths.catalogFilePathsByLocale[locale];
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isFile()) {
      throw new Error(`Expected a regular catalog file: ${displayPath({ root, filePath })}`);
    }
    const existing = stat === undefined ? undefined : fs.readFileSync(filePath, 'utf8');
    const content = renderCatalog({ keys, locale });
    // Accept CRLF checkouts without changing otherwise identical files.
    return existing?.replaceAll('\r\n', '\n') === content ? [] : [{ filePath, content }];
  });

  switch (mode) {
  case 'write':
    if (changed.length > 0) {
      fs.mkdirSync(catalogDirectory, { recursive: true });
      for (const entry of changed) {
        replaceCatalog(entry);
      }
    }
    break;
  case 'check':
    break;
  default: {
    const exhaustive: never = mode;
    throw new Error(`Unsupported string catalog mode: ${exhaustive}`);
  }
  }

  return {
    changedFiles: changed.map(({ filePath }) => displayPath({ root, filePath })),
    messageCount: keys.length,
    localeCount: BOUNDARY_STRING_LOCALES.length,
  };
}
