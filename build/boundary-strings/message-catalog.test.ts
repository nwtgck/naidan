import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  boundaryStringMessageFilePath,
  classifyBoundaryStringFile,
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
} from './message-catalog';

const temporaryDirectories: string[] = [];
const messageKey = 'ChatInput__type_a_message';

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-strings-'));
  temporaryDirectories.push(root);
  for (const locale of ['en', 'ja']) {
    const directory = path.join(root, 'src/strings/messages', messageKey);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${locale}.ts`),
      `export const ${messageKey} = (): string => "message";\n`,
    );
  }
  const catalogDirectory = path.join(root, 'src/strings/catalogs');
  fs.mkdirSync(catalogDirectory, { recursive: true });
  for (const locale of ['en', 'ja']) {
    fs.writeFileSync(
      path.join(catalogDirectory, `${locale}.ts`),
      `import { ${messageKey} } from '@/strings/messages/${messageKey}/${locale}';\n\nexport const ${locale} = {\n  ${messageKey},\n};\n`,
    );
  }
  return root;
}

function readFixtureCatalog({ root }: {
  root: string;
}) {
  return readBoundaryStringMessageCatalog({
    paths: createBoundaryStringProjectPaths({ root }),
    root,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Boundary Strings message catalog', () => {
  it('rejects a project without the English catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-strings-'));
    temporaryDirectories.push(root);

    expect(() => readFixtureCatalog({ root })).toThrow(
      'English locale catalog was not found.',
    );
  });

  it('reads locale modules and creates an indexed catalog', () => {
    const root = createFixtureRoot();
    const catalog = readFixtureCatalog({ root });
    const message = catalog.messages[0];

    expect(catalog.messages).toHaveLength(1);
    expect(message).toEqual({
      key: messageKey,
      modulesByLocale: {
        en: {
          filePath: path.join(root, `src/strings/messages/${messageKey}/en.ts`),
          sourceModuleId: `/src/strings/messages/${messageKey}/en.ts`,
        },
        ja: {
          filePath: path.join(root, `src/strings/messages/${messageKey}/ja.ts`),
          sourceModuleId: `/src/strings/messages/${messageKey}/ja.ts`,
        },
      },
    });
    expect(catalog.messagesByKey.get(messageKey)).toBe(message);
  });

  it('classifies catalog, message, and unrelated files without prefix collisions', () => {
    const root = createFixtureRoot();
    const paths = createBoundaryStringProjectPaths({ root });

    expect(classifyBoundaryStringFile({
      filePath: paths.catalogFilePathsByLocale.en,
      paths,
    })).toBe('catalog');
    expect(classifyBoundaryStringFile({
      filePath: boundaryStringMessageFilePath({ key: messageKey, locale: 'ja', paths }),
      paths,
    })).toBe('message-module');
    expect(classifyBoundaryStringFile({
      filePath: `${paths.messagesDirectoryPath}-outside/${messageKey}/ja.ts`,
      paths,
    })).toBe('other');
  });

  it('surfaces TypeScript parser failures in the English catalog', () => {
    const root = createFixtureRoot();
    const catalogPath = path.join(root, 'src/strings/catalogs/en.ts');
    fs.appendFileSync(catalogPath, '\nexport const broken = {;\n');
    expect(() => readFixtureCatalog({ root })).toThrow(
      `Failed to parse ${catalogPath}`,
    );
  });

  it('rejects an English catalog object that is not exported', () => {
    const root = createFixtureRoot();
    const catalogPath = path.join(root, 'src/strings/catalogs/en.ts');
    fs.writeFileSync(
      catalogPath,
      fs.readFileSync(catalogPath, 'utf8').replace('export const en', 'const en'),
    );
    expect(() => readFixtureCatalog({ root })).toThrow(
      'English catalog must export exactly one "en" object.',
    );
  });

  it('ignores empty message directories that are not registered in the English catalog', () => {
    const root = createFixtureRoot();
    fs.mkdirSync(
      path.join(root, 'src/strings/messages/LanguageSelector__english'),
      { recursive: true },
    );

    expect(() => readFixtureCatalog({ root })).not.toThrow();
  });

  it('rejects an empty message directory that is registered in the English catalog', () => {
    const root = createFixtureRoot();
    const messageDirectory = path.join(root, 'src/strings/messages', messageKey);
    fs.rmSync(messageDirectory, { recursive: true });
    fs.mkdirSync(messageDirectory, { recursive: true });

    expect(() => readFixtureCatalog({ root })).toThrow(
      `Missing en.ts for catalog message "${messageKey}".`,
    );
  });

  it('rejects message directories that are not registered in the English catalog', () => {
    const root = createFixtureRoot();
    const orphanDirectory = path.join(root, 'src/strings/messages/LanguageSelector__english');
    fs.mkdirSync(orphanDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(orphanDirectory, 'ja.ts'),
      'export const LanguageSelector__english = (): string => "English";\n',
    );
    expect(() => readFixtureCatalog({ root })).toThrow(
      'Message directories are not registered in the English catalog: LanguageSelector__english.',
    );
  });

  it('rejects locale catalogs with a different key set', () => {
    const root = createFixtureRoot();
    const catalogPath = path.join(root, 'src/strings/catalogs/ja.ts');
    fs.writeFileSync(catalogPath, 'export const ja = {};\n');
    expect(() => readFixtureCatalog({ root })).toThrow(
      `Japanese catalog does not match the English catalog (missing: ${messageKey}).`,
    );
  });

  it('rejects locale catalog imports that point to another locale', () => {
    const root = createFixtureRoot();
    const catalogPath = path.join(root, 'src/strings/catalogs/ja.ts');
    fs.writeFileSync(
      catalogPath,
      fs.readFileSync(catalogPath, 'utf8').replace("/ja'", "/en'"),
    );
    expect(() => readFixtureCatalog({ root })).toThrow(
      `Japanese catalog entry "${messageKey}" has no matching named import.`,
    );
  });

  it('rejects a catalog message when a locale implementation is missing', () => {
    const root = createFixtureRoot();
    fs.rmSync(path.join(root, `src/strings/messages/${messageKey}/ja.ts`));
    expect(() => readFixtureCatalog({ root })).toThrow(
      `Missing ja.ts for catalog message "${messageKey}".`,
    );
  });
});
