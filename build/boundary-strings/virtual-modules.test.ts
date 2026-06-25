import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createBoundaryRegistrationModuleSource,
  createBoundaryStringsPackModuleSource,
  readBoundaryStringMessages,
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
  fs.writeFileSync(
    path.join(catalogDirectory, 'en.ts'),
    `import { ${key} } from '@/strings/messages/${key}/en';\n\nexport const en = {\n  ${key},\n};\n`,
  );
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Boundary Strings virtual modules', () => {
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


  it('ignores message directories that are not registered in the English catalog', () => {
    const root = createFixtureRoot();
    const orphanDirectory = path.join(
      root,
      'src/strings/messages/LanguageSelector__english',
    );
    fs.mkdirSync(orphanDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(orphanDirectory, 'ja.ts'),
      'export const LanguageSelector__english = (): string => "English";\n',
    );

    expect(readBoundaryStringMessages({ root })).toEqual([{
      key: 'ChatInput__type_a_message',
      localeModulePaths: {
        en: '/src/strings/messages/ChatInput__type_a_message/en.ts',
        ja: '/src/strings/messages/ChatInput__type_a_message/ja.ts',
      },
    }]);
  });

  it('rejects a catalog message when a locale implementation is missing', () => {
    const root = createFixtureRoot();
    fs.rmSync(
      path.join(root, 'src/strings/messages/ChatInput__type_a_message/ja.ts'),
    );

    expect(() => readBoundaryStringMessages({ root })).toThrow(
      'Missing ja.ts for catalog message "ChatInput__type_a_message".',
    );
  });

  it('creates one locale pack for the keys used by a source boundary', () => {
    const root = createFixtureRoot();
    const messages = readBoundaryStringMessages({ root });
    const boundary: BoundaryStringBoundaryDefinition = {
      id: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      moduleId: '/src/components/ChatInput.vue',
    };

    expect(createBoundaryStringsPackModuleSource({
      boundary,
      locale: 'ja',
      messages,
    })).toContain(
      'export { ChatInput__type_a_message } from "/src/strings/messages/ChatInput__type_a_message/ja.ts";',
    );
  });

  it('creates static locale loaders for a registered boundary', () => {
    const boundary: BoundaryStringBoundaryDefinition = {
      id: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      moduleId: '/src/components/ChatInput.vue',
    };

    const source = createBoundaryRegistrationModuleSource({ boundary });

    expect(source).toContain('registerStringBoundary({');
    expect(source).toContain('virtual:naidan-boundary-strings/pack/en/chat-input');
    expect(source).toContain('virtual:naidan-boundary-strings/pack/ja/chat-input');
  });
});
