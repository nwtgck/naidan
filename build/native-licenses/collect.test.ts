import { describe, expect, it, vi } from 'vitest';
import type { NativeLicenseIndex } from './index-types';
import type { NativeLicenseSource } from './collect';
import { collectNativeLicenseDependencies } from './collect';
import { serializeLicenseDependencies } from '../license-payload';

function fixture() {
  const bodies = new Map<string, Uint8Array>([
    ['LICENSE', Buffer.from(`\
Copyright Core\\r
Permission granted.\\r
`)],
    ['licenses/embedded/header.txt', Buffer.from(`\
/* Copyright Header */
int code;`)],
    ['licenses/extracted/header.txt', Buffer.from('/* Copyright Header */')],
  ]);
  const files = new Set(bodies.keys());
  const readArtifact = vi.fn(({ relative }: { relative: string }) => {
    const data = bodies.get(relative);
    if (data === undefined) {
      throw new Error(`Missing fixture: ${relative}`);
    }
    return { data, filePath: `/fixture/${relative}` };
  });
  const source: NativeLicenseSource = {
    runtime: 'llama-cpp',
    kind: 'external',
    rootDir: '/fixture',
    manifestPaths: ['/fixture/manifest.json'],
    files,
    readArtifact,
  };
  const index: NativeLicenseIndex = {
    components: [
      { id: 'core', name: 'Core', version: '1', license: 'MIT', notices: [{ path: 'LICENSE' }] },
      { id: 'header', name: 'Header', version: null, license: null, notices: [{ path: 'licenses/extracted/header.txt', sourcePath: 'licenses/embedded/header.txt' }] },
    ],
  };
  const watchFile = vi.fn();
  return { bodies, files, source, index, watchFile, readArtifact };
}

describe('native license collection', () => {
  it('keeps exact notice text, provenance, null metadata and original-file integrity checks', () => {
    const value = fixture();
    const records = collectNativeLicenseDependencies(value);
    expect(records).toEqual([
      {
        id: 'native:llama-cpp:core',
        origin: 'llama.cpp',
        name: 'Core',
        version: '1',
        license: 'MIT',
        licenseText: `\
===== LICENSE =====
Copyright Core\\r
Permission granted.\\r
`,
      },
      {
        id: 'native:llama-cpp:header',
        origin: 'llama.cpp',
        name: 'Header',
        version: null,
        license: null,
        licenseText: `\
===== licenses/extracted/header.txt =====
/* Copyright Header */`,
      },
    ]);
    expect(value.readArtifact).toHaveBeenCalledWith({ relative: 'licenses/embedded/header.txt' });
    expect(value.watchFile).toHaveBeenCalledTimes(3);
  });

  it('preserves a UTF-8 byte-order mark in notice text', () => {
    const value = fixture();
    value.bodies.set('LICENSE', Buffer.from('\uFEFFOriginal notice\r\n'));
    expect(collectNativeLicenseDependencies(value)[0]?.licenseText).toBe('===== LICENSE =====\n\uFEFFOriginal notice\r\n');
  });

  it('never merges different runtimes or a JavaScript package by display name', () => {
    const value = fixture();
    const llama = collectNativeLicenseDependencies(value);
    const image = collectNativeLicenseDependencies({ ...value, source: { ...value.source, runtime: 'stable-diffusion-cpp' } });
    const dependencies = [{ name: 'Core', version: '1', license: 'MIT', licenseText: 'JavaScript notice' }, ...llama, ...image];
    const expression = serializeLicenseDependencies({ dependencies });
    const reconstructed: unknown = new Function(`return (${expression})`)();
    expect(reconstructed).toEqual(dependencies);
    expect(new Set([...llama, ...image].map(item => item.id)).size).toBe(4);
  });

  it.each(['../outside', '/absolute', 'C:/absolute', 'licenses//x', 'licenses/./x', 'licenses/../x', 'licenses\\x', 'licenses/\0x'])('rejects unsafe notice paths: %j', path => {
    const value = fixture();
    const index = { components: [{ id: 'x', name: 'X', version: null, license: null, notices: [{ path }] }] } satisfies NativeLicenseIndex;
    expect(() => collectNativeLicenseDependencies({ ...value, index })).toThrow('Unsafe native notice path');
    expect(value.readArtifact).not.toHaveBeenCalled();
  });

  it('checks sourcePath with the same path rules', () => {
    const value = fixture();
    const index = { components: [{ id: 'x', name: 'X', version: null, license: null, notices: [{ path: 'LICENSE', sourcePath: '../outside' }] }] } satisfies NativeLicenseIndex;
    expect(() => collectNativeLicenseDependencies({ ...value, index })).toThrow('Unsafe native notice path');
  });

  it('rejects missing, unindexed, empty and invalid UTF-8 documents', () => {
    const value = fixture();
    value.files.delete('LICENSE');
    expect(() => collectNativeLicenseDependencies(value)).toThrow('not in the artifact manifest');
    value.files.add('LICENSE');
    value.files.add('licenses/new/NOTICE');
    expect(() => collectNativeLicenseDependencies(value)).toThrow('Unindexed native notice');
    value.files.delete('licenses/new/NOTICE');
    value.bodies.set('LICENSE', Buffer.from(' \r\n'));
    expect(() => collectNativeLicenseDependencies(value)).toThrow('Empty native notice');
    value.bodies.set('LICENSE', Uint8Array.from([0xff]));
    expect(() => collectNativeLicenseDependencies(value)).toThrow();
  });

  it('rejects empty components, duplicate identities and duplicate original ownership', () => {
    const value = fixture();
    const [first, second] = value.index.components;
    if (!first || !second) {
      throw new Error('Incomplete fixture');
    }
    for (const component of [{ ...first, id: '' }, { ...first, name: ' ' }, { ...first, notices: [] }]) {
      expect(() => collectNativeLicenseDependencies({ ...value, index: { components: [component] } })).toThrow('Incomplete');
    }
    expect(() => collectNativeLicenseDependencies({ ...value, index: { components: [] } })).toThrow('no components');
    expect(() => collectNativeLicenseDependencies({ ...value, index: { components: [first, { ...second, id: first.id }] } })).toThrow('Duplicate native license component');
    expect(() => collectNativeLicenseDependencies({ ...value, index: { components: [first, { ...first, id: 'another' }] } })).toThrow('Duplicate native notice');
  });

  it('rejects two different original documents assigned to one output notice', () => {
    const value = fixture();
    const index = {
      components: [{
        id: 'x',
        name: 'X',
        version: null,
        license: null,
        notices: [
          { path: 'LICENSE', sourcePath: 'licenses/embedded/header.txt' },
          { path: 'LICENSE', sourcePath: 'licenses/extracted/header.txt' },
        ],
      }],
    } satisfies NativeLicenseIndex;
    expect(() => collectNativeLicenseDependencies({ ...value, index })).toThrow('Duplicate native notice output');
  });

  it('propagates manifest integrity failures instead of omitting a notice', () => {
    const value = fixture();
    value.readArtifact.mockImplementation(() => {
      throw new Error('artifact integrity mismatch');
    });
    expect(() => collectNativeLicenseDependencies(value)).toThrow('artifact integrity mismatch');
  });
});
