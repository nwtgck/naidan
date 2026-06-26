import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compactBoundaryStringsModule,
  createBoundaryStringsCompactionState,
  createCompactedIdentifier,
  type BoundaryStringsCompactionState,
} from './compaction';

const temporaryDirectories: string[] = [];

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-compaction-'));
  temporaryDirectories.push(root);
  const messages = {
    ChatInput__type_a_message: `\
export const ChatInput__type_a_message = (): string => 'Type a message';
`,
    ChatInput__failed_to_copy: `\
export const ChatInput__failed_to_copy = ({ name, errorMessage }: { name: string; errorMessage: string }): string => (
  \`Failed to copy "\${name}": \${errorMessage}\`
);
`,
  };
  for (const [key, source] of Object.entries(messages)) {
    const directory = path.join(root, 'src/strings/messages', key);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'en.ts'), source);
  }
  return root;
}

function createState(): BoundaryStringsCompactionState {
  return {
    compactionByMessageKey: new Map([
      ['ChatInput__type_a_message', { messageId: 'a', parameterIdsByName: new Map() }],
      ['ChatInput__failed_to_copy', {
        messageId: 'b',
        parameterIdsByName: new Map([['name', 'a'], ['errorMessage', 'b']]),
      }],
    ]),
    messageKeyByCompactedId: new Map([
      ['a', 'ChatInput__type_a_message'],
      ['b', 'ChatInput__failed_to_copy'],
    ]),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Boundary Strings production compaction', () => {
  it('creates deterministic JavaScript property identifiers', () => {
    expect(createCompactedIdentifier({ index: 0 })).toBe('a');
    expect(createCompactedIdentifier({ index: 53 })).toBe('_');
    expect(createCompactedIdentifier({ index: 54 })).toBe('aa');
    expect(createCompactedIdentifier({ index: 55 })).toBe('ab');
    expect(new Set(Array.from({ length: 591 }, (_value, index) => {
      return createCompactedIdentifier({ index });
    })).size).toBe(591);
  });

  it('builds message and parameter mappings from catalog order', () => {
    const root = createFixtureRoot();
    const state = createBoundaryStringsCompactionState({
      root,
      messages: [
        { key: 'ChatInput__type_a_message' },
        { key: 'ChatInput__failed_to_copy' },
      ],
    });
    expect(state.compactionByMessageKey.get('ChatInput__type_a_message')).toEqual({
      messageId: 'a',
      parameterIdsByName: new Map(),
    });
    expect(state.compactionByMessageKey.get('ChatInput__failed_to_copy')).toEqual({
      messageId: 'b',
      parameterIdsByName: new Map([['name', 'a'], ['errorMessage', 'b']]),
    });
  });

  it('compacts zero-argument and named-argument calls', () => {
    const result = compactBoundaryStringsModule({
      code: `\
lazyStrings.ChatInput__type_a_message();
ensureStrings.ChatInput__failed_to_copy({
  name,
  errorMessage: error.message,
});
`,
      moduleId: '/src/example.ts',
      state: createState(),
    });
    expect(result?.code).toContain('lazyStrings.a();');
    expect(result?.code).toContain('ensureStrings.b({');
    expect(result?.code).toContain('a: name,');
    expect(result?.code).toContain('b: error.message,');
  });

  it('compacts Vue-generated calls without depending on the receiver shape', () => {
    const result = compactBoundaryStringsModule({
      code: '_toDisplayString(_ctx.lazyStrings.ChatInput__failed_to_copy({ name: item.name, errorMessage }))',
      moduleId: '/src/components/Example.vue?vue&type=template',
      state: createState(),
    });
    expect(result?.code).toBe('_toDisplayString(_ctx.lazyStrings.b({ a: item.name, b: errorMessage }))');
  });

  it('compacts locale implementation destructuring while preserving local bindings', () => {
    const result = compactBoundaryStringsModule({
      code: `\
export const ChatInput__failed_to_copy = ({ name, errorMessage }: { name: string; errorMessage: string }): string => (
  \`Failed to copy "\${name}": \${errorMessage}\`
);
`,
      moduleId: '/src/strings/messages/ChatInput__failed_to_copy/en.ts',
      state: createState(),
    });
    expect(result?.code).toContain('({ a: name, b: errorMessage }: { a: string; b: string })');
  });

  it('rejects indirect, missing, and unknown arguments', () => {
    expect(() => compactBoundaryStringsModule({
      code: 'ensureStrings.ChatInput__failed_to_copy(args);',
      moduleId: '/src/example.ts',
      state: createState(),
    })).toThrow('must be called with one direct object literal');
    expect(() => compactBoundaryStringsModule({
      code: 'ensureStrings.ChatInput__failed_to_copy({ name });',
      moduleId: '/src/example.ts',
      state: createState(),
    })).toThrow('Missing parameter "errorMessage"');
    expect(() => compactBoundaryStringsModule({
      code: 'ensureStrings.ChatInput__failed_to_copy({ name, errorMessage, extra });',
      moduleId: '/src/example.ts',
      state: createState(),
    })).toThrow('Unknown parameter "extra"');
  });
});
