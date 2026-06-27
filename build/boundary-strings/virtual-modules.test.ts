import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBoundaryStringsCompactionState } from './compaction';
import {
  createBoundaryRegistrationModuleSource,
  createBoundaryStringsPackModuleSource,
  parseResolvedBoundaryModuleId,
  parseResolvedPackModuleId,
  readBoundaryStringMessages,
  resolveBoundaryStringsVirtualId,
  type BoundaryStringBoundaryDefinition,
} from './virtual-modules';

const temporaryDirectories: string[] = [];

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-strings-'));
  temporaryDirectories.push(root);
  const key = 'ChatInput__type_a_message';
  for (const locale of ['en', 'ja']) {
    const directory = path.join(root, 'src/strings/messages', key);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${locale}.ts`),
      `export const ${key} = (): string => "message";\n`,
    );
  }
  const catalogDirectory = path.join(root, 'src/strings/catalogs');
  fs.mkdirSync(catalogDirectory, { recursive: true });
  for (const locale of ['en', 'ja']) {
    fs.writeFileSync(
      path.join(catalogDirectory, `${locale}.ts`),
      `import { ${key} } from '@/strings/messages/${key}/${locale}';\n\nexport const ${locale} = {\n  ${key},\n};\n`,
    );
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Boundary Strings virtual modules', () => {

  it('parses only structurally valid virtual module IDs', () => {
    const boundaryId = '0123456789abcdef';
    expect(resolveBoundaryStringsVirtualId({
      id: `virtual:naidan-boundary-strings/boundary/${boundaryId}`,
    })).toBe(`\0virtual:naidan-boundary-strings/boundary/${boundaryId}`);
    expect(parseResolvedBoundaryModuleId({
      id: `\0virtual:naidan-boundary-strings/boundary/${boundaryId}`,
    })).toBe(boundaryId);
    expect(parseResolvedPackModuleId({
      id: `\0virtual:naidan-boundary-strings/pack/ja/${boundaryId}`,
    })).toEqual({
      boundaryId,
      locale: 'ja',
    });
    expect(() => parseResolvedPackModuleId({
      id: `\0virtual:naidan-boundary-strings/pack/ja/${boundaryId}/extra`,
    })).toThrow('Invalid pack module ID');
    expect(() => parseResolvedPackModuleId({
      id: `\0virtual:naidan-boundary-strings/pack/fr/${boundaryId}`,
    })).toThrow('Unsupported locale "fr"');
    expect(() => parseResolvedBoundaryModuleId({
      id: '\0virtual:naidan-boundary-strings/boundary/not-a-boundary',
    })).toThrow('Invalid boundary module ID');
  });

  it('rejects a project without the English catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-strings-'));
    temporaryDirectories.push(root);

    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'English locale catalog was not found.',
    );
  });

  it('reads locale modules without creating generated source files', () => {
    const root = createFixtureRoot();
    expect(readBoundaryStringMessages({ root })).toEqual([{
      key: 'ChatInput__type_a_message',
      localeModulePaths: {
        en: '/src/strings/messages/ChatInput__type_a_message/en.ts',
        ja: '/src/strings/messages/ChatInput__type_a_message/ja.ts',
      },
    }]);
  });


  it('surfaces TypeScript parser failures in the English catalog', () => {
    const root = createFixtureRoot();
    const catalogPath = path.join(root, 'src/strings/catalogs/en.ts');
    fs.appendFileSync(catalogPath, '\nexport const broken = {;\n');
    expect(() => readBoundaryStringMessages({ root })).toThrow(
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
    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'English catalog must export exactly one "en" object.',
    );
  });

  it('ignores empty message directories that are not registered in the English catalog', () => {
    const root = createFixtureRoot();
    fs.mkdirSync(
      path.join(root, 'src/strings/messages/LanguageSelector__english'),
      { recursive: true },
    );

    expect(() => readBoundaryStringMessages({ root })).not.toThrow();
  });

  it('rejects an empty message directory that is registered in the English catalog', () => {
    const root = createFixtureRoot();
    const messageDirectory = path.join(
      root,
      'src/strings/messages/ChatInput__type_a_message',
    );
    fs.rmSync(messageDirectory, { recursive: true });
    fs.mkdirSync(messageDirectory, { recursive: true });

    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'Missing en.ts for catalog message "ChatInput__type_a_message".',
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
    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'Message directories are not registered in the English catalog: LanguageSelector__english.',
    );
  });

  it('rejects locale catalogs with a different key set', () => {
    const root = createFixtureRoot();
    const catalogPath = path.join(root, 'src/strings/catalogs/ja.ts');
    fs.writeFileSync(
      catalogPath,
      'export const ja = {};\n',
    );
    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'Japanese catalog does not match the English catalog (missing: ChatInput__type_a_message).',
    );
  });

  it('rejects locale catalog imports that point to another locale', () => {
    const root = createFixtureRoot();
    const catalogPath = path.join(root, 'src/strings/catalogs/ja.ts');
    fs.writeFileSync(
      catalogPath,
      fs.readFileSync(catalogPath, 'utf8').replace("/ja'", "/en'"),
    );
    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'Japanese catalog entry "ChatInput__type_a_message" has no matching named import.',
    );
  });

  it('rejects a catalog message when a locale implementation is missing', () => {
    const root = createFixtureRoot();
    fs.rmSync(path.join(root, 'src/strings/messages/ChatInput__type_a_message/ja.ts'));
    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'Missing ja.ts for catalog message "ChatInput__type_a_message".',
    );
  });

  it('keeps named re-exports and long runtime keys during development', () => {
    const root = createFixtureRoot();
    const messages = readBoundaryStringMessages({ root });
    const boundary: BoundaryStringBoundaryDefinition = {
      id: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      moduleId: '/src/components/ChatInput.vue',
    };
    expect(createBoundaryStringsPackModuleSource({
      boundary,
      compactionState: undefined,
      locale: 'ja',
      messages,
    })).toContain(
      'export { ChatInput__type_a_message } from "/src/strings/messages/ChatInput__type_a_message/ja.ts";',
    );
    const registration = createBoundaryRegistrationModuleSource({
      boundary,
      compactionState: undefined,
    });
    expect(registration).toContain('"ChatInput__type_a_message"');
    expect(registration).not.toContain('.then((module) => module.default)');
  });

  it('creates compact default-export packs and loaders for production', () => {
    const root = createFixtureRoot();
    const messages = readBoundaryStringMessages({ root });
    const compactionState = createBoundaryStringsCompactionState({ root, messages });
    const boundary: BoundaryStringBoundaryDefinition = {
      id: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      moduleId: '/src/components/ChatInput.vue',
    };
    const pack = createBoundaryStringsPackModuleSource({
      boundary,
      compactionState,
      locale: 'ja',
      messages,
    });
    expect(pack).toContain('import { ChatInput__type_a_message }');
    expect(pack).toContain('export default {');
    expect(pack).toContain('a: ChatInput__type_a_message');

    const registration = createBoundaryRegistrationModuleSource({ boundary, compactionState });
    expect(registration).toContain('"a"');
    expect(registration).not.toContain('"ChatInput__type_a_message"');
    expect(registration).toContain('.then((module) => module.default)');
  });
});
