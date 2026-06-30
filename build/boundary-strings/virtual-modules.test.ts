import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBoundaryStringsCompactionState } from './compaction';
import {
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
} from './message-catalog';
import {
  createBoundaryRegistrationModuleSource,
  createBoundaryStringsPackModuleSource,
  parseResolvedBoundaryModuleId,
  parseResolvedPackModuleId,
  resolveBoundaryStringsVirtualId,
  type BoundaryStringBoundaryDefinition,
} from './virtual-modules';

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Boundary Strings virtual modules', () => {
  it('parses only structurally valid virtual module IDs', () => {
    const boundaryId = '0123456789abcdef';
    const version = 'fedcba9876543210';
    expect(resolveBoundaryStringsVirtualId({
      id: `virtual:naidan-boundary-strings/boundary/${boundaryId}/${version}`,
    })).toBe(`\0virtual:naidan-boundary-strings/boundary/${boundaryId}/${version}`);
    expect(parseResolvedBoundaryModuleId({
      id: `\0virtual:naidan-boundary-strings/boundary/${boundaryId}/${version}`,
    })).toEqual({ boundaryId, version });
    expect(parseResolvedPackModuleId({
      id: `\0virtual:naidan-boundary-strings/pack/ja/${boundaryId}/${version}`,
    })).toEqual({
      boundaryId,
      locale: 'ja',
      version,
    });
    expect(() => parseResolvedPackModuleId({
      id: `\0virtual:naidan-boundary-strings/pack/ja/${boundaryId}/${version}/extra`,
    })).toThrow('Invalid pack module ID');
    expect(() => parseResolvedPackModuleId({
      id: `\0virtual:naidan-boundary-strings/pack/fr/${boundaryId}/${version}`,
    })).toThrow('Unsupported locale "fr"');
    expect(() => parseResolvedBoundaryModuleId({
      id: `\0virtual:naidan-boundary-strings/boundary/not-a-boundary/${version}`,
    })).toThrow('Invalid boundary ID in virtual module ID');
  });

  it('keeps named re-exports and long runtime keys during development', () => {
    const root = createFixtureRoot();
    const catalog = readBoundaryStringMessageCatalog({
      paths: createBoundaryStringProjectPaths({ root }),
      root,
    });
    const boundary: BoundaryStringBoundaryDefinition = {
      id: 'chat-input',
      keys: [messageKey],
      moduleId: '/src/components/ChatInput.vue',
      version: 'fedcba9876543210',
    };
    expect(createBoundaryStringsPackModuleSource({
      boundary,
      compactionState: undefined,
      locale: 'ja',
      messagesByKey: catalog.messagesByKey,
    })).toContain(
      `export { ${messageKey} } from "/src/strings/messages/${messageKey}/ja.ts";`,
    );
    const registration = createBoundaryRegistrationModuleSource({
      boundary,
      compactionState: undefined,
    });
    expect(registration).toContain(`"${messageKey}"`);
    expect(registration).not.toContain('.then((module) => module.default)');
  });

  it('creates compact default-export packs and loaders for production', () => {
    const root = createFixtureRoot();
    const catalog = readBoundaryStringMessageCatalog({
      paths: createBoundaryStringProjectPaths({ root }),
      root,
    });
    const compactionState = createBoundaryStringsCompactionState({
      root,
      messages: catalog.messages,
    });
    const boundary: BoundaryStringBoundaryDefinition = {
      id: 'chat-input',
      keys: [messageKey],
      moduleId: '/src/components/ChatInput.vue',
      version: 'fedcba9876543210',
    };
    const pack = createBoundaryStringsPackModuleSource({
      boundary,
      compactionState,
      locale: 'ja',
      messagesByKey: catalog.messagesByKey,
    });
    expect(pack).toContain(`import { ${messageKey} }`);
    expect(pack).toContain('export default {');
    expect(pack).toContain(`a: ${messageKey}`);

    const registration = createBoundaryRegistrationModuleSource({ boundary, compactionState });
    expect(registration).toContain('"a"');
    expect(registration).not.toContain(`"${messageKey}"`);
    expect(registration).toContain('.then((module) => module.default)');
  });

  it('rejects an unknown key without rebuilding a message index', () => {
    const boundary: BoundaryStringBoundaryDefinition = {
      id: 'chat-input',
      keys: ['ChatInput__unknown'],
      moduleId: '/src/components/ChatInput.vue',
      version: 'fedcba9876543210',
    };
    expect(() => createBoundaryStringsPackModuleSource({
      boundary,
      compactionState: undefined,
      locale: 'en',
      messagesByKey: new Map(),
    })).toThrow('Unknown message key "ChatInput__unknown"');
  });
});
