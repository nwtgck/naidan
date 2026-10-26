import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBoundaryStringsCompactionState } from './compaction';
import {
  BOUNDARY_STRING_LOCALES,
  createBoundaryStringProjectPaths,
  readBoundaryStringMessageCatalog,
} from './message-catalog';
import {
  createBoundaryRegistrationModuleSource,
  createBoundaryStringsPackModuleSource,
  parseResolvedBoundaryModuleId,
  parseResolvedPackModuleId,
  parseResolvedPackModuleIdentity,
  resolveBoundaryStringsVirtualId,
  type BoundaryStringBoundaryDefinition,
} from './virtual-modules';

const temporaryDirectories: string[] = [];
const messageKey = 'ChatInput__type_a_message';

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-strings-'));
  temporaryDirectories.push(root);
  for (const locale of BOUNDARY_STRING_LOCALES) {
    const directory = path.join(root, 'src/strings/messages', messageKey);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${locale}.ts`),
      `export const ${messageKey} = (): string => "message";\n`,
    );
  }
  const catalogDirectory = path.join(root, 'src/strings/catalogs');
  fs.mkdirSync(catalogDirectory, { recursive: true });
  for (const locale of BOUNDARY_STRING_LOCALES) {
    fs.writeFileSync(
      path.join(catalogDirectory, `${locale}.ts`),
      `import { ${messageKey} } from '@/strings/messages/${messageKey}/${locale}';\n\nexport const catalog = {\n  ${messageKey},\n};\n`,
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
    expect(parseResolvedPackModuleIdentity({
      id: `\0virtual:naidan-boundary-strings/pack/pt-BR/${boundaryId}/${version}`,
    })).toEqual({
      boundaryId,
      locale: 'pt-BR',
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
    for (const locale of BOUNDARY_STRING_LOCALES) {
      expect(registration).toContain(`${JSON.stringify(locale)}:`);
    }
    expect(registration).not.toContain('.then((module) => module.default)');
    expect(registration).toContain('const { unregister, updateLocale } = registerStringBoundary(');
    expect(registration).toContain('hot.prune(cleanup)');
    expect(registration).toContain("hot.on('vite:beforePrune', onPrune)");
  });

  it.each(['raw', 'normalized'])('cleans up a boundary for the %s virtual-module prune path', (pathForm) => {
    const boundary: BoundaryStringBoundaryDefinition = {
      id: '0123456789abcdef',
      keys: [messageKey],
      moduleId: '/src/components/Example.vue',
      version: 'fedcba9876543210',
    };
    const unregister = vi.fn();
    const register = vi.fn(() => ({ unregister, updateLocale: vi.fn() }));
    let beforePrune: ((event: { paths: string[] }) => void) | undefined;
    let prune: (() => void) | undefined;
    const off = vi.fn();
    const hot = {
      accept: vi.fn(),
      on: vi.fn((_event, callback) => {
        beforePrune = callback;
      }),
      off,
      prune: vi.fn((callback) => {
        prune = callback;
      }),
      dispose: vi.fn(),
    };
    const source = createBoundaryRegistrationModuleSource({ boundary, compactionState: undefined })
      .replace('import { registerStringBoundary } from "/src/strings/runtime.ts";', '')
      .replaceAll('import.meta.hot', 'testHot');
    new Function('registerStringBoundary', 'testHot', source)(register, hot);
    expect(register).toHaveBeenCalledTimes(1);
    beforePrune?.({ paths: ['\0virtual:naidan-boundary-strings/boundary/another/version'] });
    expect(unregister).not.toHaveBeenCalled();

    if (pathForm === 'raw') {
      beforePrune?.({ paths: ['\0virtual:naidan-boundary-strings/boundary/0123456789abcdef/fedcba9876543210'] });
    } else {
      prune?.();
    }
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledWith('vite:beforePrune', beforePrune);
  });

  it('removes the old prune listener without unregistering during a module update', () => {
    const boundary: BoundaryStringBoundaryDefinition = {
      id: '0123456789abcdef',
      keys: [messageKey],
      moduleId: '/src/components/Example.vue',
      version: 'fedcba9876543210',
    };
    const unregister = vi.fn();
    const off = vi.fn();
    let dispose: (() => void) | undefined;
    const source = createBoundaryRegistrationModuleSource({ boundary, compactionState: undefined })
      .replace('import { registerStringBoundary } from "/src/strings/runtime.ts";', '')
      .replaceAll('import.meta.hot', 'testHot');
    new Function('registerStringBoundary', 'testHot', source)(() => ({ unregister, updateLocale: vi.fn() }), {
      accept: vi.fn(),
      on: vi.fn(),
      off,
      prune: vi.fn(),
      dispose: (callback: () => void) => {
        dispose = callback;
      },
    });
    dispose?.();
    expect(off).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();
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

  it('accepts locale packs at the registration without eagerly loading them', () => {
    const boundary: BoundaryStringBoundaryDefinition = {
      id: '0123456789abcdef',
      keys: [messageKey],
      moduleId: '/src/components/Example.vue',
      version: 'fedcba9876543210',
    };
    const updateLocale = vi.fn();
    const callbacks = new Map<string, (module: unknown) => void>();
    const source = createBoundaryRegistrationModuleSource({ boundary, compactionState: undefined })
      .replace('import { registerStringBoundary } from "/src/strings/runtime.ts";', '')
      .replaceAll('import.meta.hot', 'testHot');
    new Function('registerStringBoundary', 'testHot', source)(() => ({ unregister: vi.fn(), updateLocale }), {
      accept: (id: string, callback: (module: unknown) => void) => callbacks.set(id, callback),
      on: vi.fn(),
      off: vi.fn(),
      prune: vi.fn(),
      dispose: vi.fn(),
    });
    expect(callbacks.size).toBe(7);
    expect(updateLocale).not.toHaveBeenCalled();
    for (const locale of BOUNDARY_STRING_LOCALES) {
      const callback = callbacks.get(`virtual:naidan-boundary-strings/pack/${locale}/0123456789abcdef/fedcba9876543210`);
      expect(callback).toBeDefined();
      callback?.(undefined);
      expect(updateLocale).not.toHaveBeenCalled();
      const module = { [messageKey]: () => 'Updated message' };
      callback?.(module);
      expect(updateLocale).toHaveBeenCalledExactlyOnceWith({ locale, module });
      updateLocale.mockClear();
    }
  });

  it('reports an invalid pack without aborting the update batch or preventing a later correction', () => {
    const boundary: BoundaryStringBoundaryDefinition = {
      id: '0123456789abcdef',
      keys: [messageKey],
      moduleId: '/src/components/Example.vue',
      version: 'fedcba9876543210',
    };
    const failure = new Error('Invalid message implementation');
    const updateLocale = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    const callbacks = new Map<string, (module: unknown) => void>();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const source = createBoundaryRegistrationModuleSource({ boundary, compactionState: undefined })
        .replace('import { registerStringBoundary } from "/src/strings/runtime.ts";', '')
        .replaceAll('import.meta.hot', 'testHot');
      new Function('registerStringBoundary', 'testHot', source)(() => ({ unregister: vi.fn(), updateLocale }), {
        accept: (id: string, callback: (module: unknown) => void) => callbacks.set(id, callback),
        on: vi.fn(),
        off: vi.fn(),
        prune: vi.fn(),
        dispose: vi.fn(),
      });
      const callback = callbacks.get('virtual:naidan-boundary-strings/pack/en/0123456789abcdef/fedcba9876543210');
      if (callback === undefined) {
        throw new Error('Expected the English pack callback.');
      }
      expect(() => callback({ [messageKey]: 123 })).not.toThrow();
      expect(error).toHaveBeenCalledExactlyOnceWith('[Boundary Strings] Failed to update a message boundary.', failure);
      const corrected = { [messageKey]: () => 'Corrected message' };
      callback(corrected);
      expect(updateLocale).toHaveBeenLastCalledWith({ locale: 'en', module: corrected });
      expect(updateLocale).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});
