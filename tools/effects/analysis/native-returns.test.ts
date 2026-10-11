import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';
import { withoutSourceEvidence } from './source-evidence.ts';
import { SCALAR, type FunctionValue } from './values.ts';

describe('checked implementation native return origins', () => {
  it.each([
    { type: 'Storage', source: 'localStorage', use: "storage.removeItem('key');", effects: ['localstorage.write(*)'] },
    { type: 'Storage', source: 'sessionStorage', use: "storage.removeItem('key');", effects: ['sessionstorage.write(*)'] },
    { type: 'IDBFactory', source: 'indexedDB', use: "storage.deleteDatabase('db');", effects: ['indexeddb.write(*)'] },
    { type: 'CacheStorage', source: 'caches', use: "void storage.keys(); void storage.delete('cache');", effects: ['cachestorage.read(*)', 'cachestorage.write(*)'] },
  ])('recovers $source through optional guarded returns without clearing type boundaries', ({ type, source, use, effects }) => {
    using fixture = createFixture({
      files: {
        'main.ts': `
/** @effects [] */ export function entry() { const storage = wrapped(); if (storage === undefined) return; ${use} }
/** @effects [] */ function wrapped(): ${type} | undefined {
  try { if (typeof ${source} === 'undefined') return undefined; const storage = ${source}; return storage; }
  catch { return undefined; }
}
`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(effects);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Built-in type'))).toBe(true);
    expect(() => fixture.fix()).toThrow();
  });

  it.each([
    'let storage = localStorage; storage = sessionStorage; return storage;',
    'let storage = localStorage; const read = /** @effects [] */ () => storage; storage = sessionStorage; return read();',
    'const holder = { storage: localStorage }; holder.storage = sessionStorage; return holder.storage;',
    'const holder = { storage: localStorage }; const storage = holder.storage; return storage;',
    'let root = globalThis; return root.localStorage;',
    'let get = /** @effects [] */ () => localStorage; get = () => sessionStorage; return get();',
    'const holder = { get: /** @effects [] */ () => localStorage }; holder.get = () => sessionStorage; return holder.get();',
  ])('does not promote a mutable source into a checked return origin: %s', body => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped(): Storage { ${body} }
/** @effects [] */ export function entry() { wrapped().clear(); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not invalidate an immutable origin when a different binding is assigned', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped(): Storage { const stable = localStorage; let changing = stable; changing = sessionStorage; return stable; }
/** @effects [] */ export function entry() { wrapped().clear(); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });

  it.each([
    'const get = /** @effects [] */ () => localStorage; return get();',
    'function get() { return localStorage; } const stable = get; let changing = stable; changing = () => sessionStorage; return stable();',
  ])('preserves immutable callable origins: %s', body => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped(): Storage { ${body} }
/** @effects [] */ export function entry() { wrapped().clear(); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  });

  it.each([
    'function change() { storage = sessionStorage; } function consume() { wrapped().clear(); }',
    'function consume() { wrapped().clear(); } function change() { storage = sessionStorage; }',
  ])('keeps captured mutable origins unresolved independently of pending-body order: %s', declarations => {
    using fixture = createFixture({
      files: {
        'main.ts': `let storage = localStorage;
/** @effects [] */ function wrapped(): Storage { return storage; }
${declarations}
/** @effects [] */ export function entry() { change(); consume(); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('preserves an existing static native contract despite mutable aliases', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped({ handle }: { handle: FileSystemFileHandle }): FileSystemFileHandle { const stable = handle; let changing = stable; changing = stable; return stable; }
/** @effects [] */ export function entry({ handle }: { handle: FileSystemFileHandle }) { void wrapped({ handle }).getFile(); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['hostfs.read(*)', 'opfs.read(*)']);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  });

  it.each([
    { body: 'return wrapped();', expected: [] },
    { body: 'if (flag) return localStorage; return value as Storage;', expected: ['localstorage.write(*)'] },
    { body: 'try { return localStorage; } finally { return value as Storage; }', expected: ['localstorage.write(*)'] },
    { body: 'if (flag) return localStorage; return;', expected: ['localstorage.write(*)'] },
  ])('preserves unresolved alternatives and recursive returns: $body', ({ body, expected }) => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped(): Storage | undefined { ${body} }
declare const flag: boolean; declare const value: unknown;
/** @effects [] */ export function entry() { const storage = wrapped(); if (storage === undefined) return; storage.clear(); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(expected);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it.each([
    { type: 'Storage | Callback', body: 'return flag ? localStorage : () => {};', use: "if (typeof output === 'function') output();" },
    { type: 'Storage | { readonly run: Callback }', body: 'return flag ? localStorage : { run: () => {} };', use: "if ('run' in output) output.run();" },
  ])('preserves callable upper bounds in mixed unknown return unions: $type', ({ type, body, use }) => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects ["network.http(*)"] */ type Callback = () => void;
/** @effects [] */ function wrapped({ flag }: { flag: boolean }): ${type} { ${body} }
/** @effects [] */ export function entry({ flag }: { flag: boolean }) { const output = wrapped({ flag }); ${use} }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['network.http(*)']);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  });

  it('retains async settlement and does not parse a called body twice', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ async function wrapped(): Promise<Storage> { void localStorage.length; return localStorage; }
/** @effects [] */ export async function entry() { const storage = await wrapped(); storage.clear(); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)', 'localstorage.write(*)']);
    expect(result.modelDecisions.filter(item => item.operation === 'localStorage.length')).toHaveLength(1);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Promise'))).toBe(true);
  });

  it.each([
    { storage: 'immutable const', body: 'const pending = Promise.resolve(handle); return pending;', expected: ['hostfs.read(*)', 'opfs.read(*)'] },
    { storage: 'mutable binding', body: 'let pending = Promise.resolve(handle); pending = Promise.resolve(value as FileSystemFileHandle); return pending;', expected: [] },
    { storage: 'record field', body: 'const holder = { pending: Promise.resolve(handle) }; holder.pending = Promise.resolve(value as FileSystemFileHandle); return holder.pending;', expected: [] },
  ])('keeps native Promise return origins separate from $storage storage', ({ body, expected }) => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped({ handle, value }: { handle: FileSystemFileHandle, value: unknown }): Promise<unknown> {
  ${body}
}
/** @effects [] */ async function entry({ handle, value }: { handle: FileSystemFileHandle, value: unknown }) {
  const output = await wrapped({ handle, value }); void (output as FileSystemFileHandle).getFile();
}`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(expected);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('copies callable origin facts without resolving lazy signatures or detaching transport updates', () => {
    using fixture = createFixture({ files: { 'main.ts': 'function noop() {}' }, entries: ['main.ts'] });
    const owner = fixture.check().owners.find(owner => owner.role === 'implementation')!;
    let reads = 0;
    const source: FunctionValue = {
      kind: 'function',
      owner,
      declaration: undefined,
      get parameters() {
        reads++; return [];
      },
      get returns() {
        reads++; return SCALAR;
      },
      transport: 'local',
    };
    const copied = withoutSourceEvidence({ value: source, undefinedFact: 'forget' });
    expect(reads).toBe(0);
    expect(copied.kind).toBe('function');
    if (copied.kind !== 'function') throw new Error('Expected a callable.');
    expect(copied.returnOrigin).toBe('unverified');
    copied.transport = 'worker';
    expect(source.transport).toBe('worker');
    expect(copied.parameters).toEqual([]);
    expect(reads).toBe(1);
    expect(copied.returns).toBe(SCALAR);
    expect(reads).toBe(2);
  });

  it.each([
    { storage: 'immutable native callable', body: 'const get = navigator.storage.getDirectory; return get();', expected: ['opfs.read(*)', 'opfs.write(*)'] },
    { storage: 'mutable native callable', body: 'let get = navigator.storage.getDirectory; get = () => Promise.resolve(alternative); return get();', expected: ['opfs.read(*)'] },
    { storage: 'mutable typed callable', body: 'let get = /** @effects [] */ (): Promise<FileSystemDirectoryHandle> => navigator.storage.getDirectory(); get = () => Promise.resolve(alternative); return get();', expected: ['opfs.read(*)'] },
  ])('keeps returned native origins separate from $storage storage', ({ body, expected }) => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped({ alternative }: { alternative: FileSystemDirectoryHandle }): Promise<unknown> { ${body} }
/** @effects [] */ export async function entry({ alternative }: { alternative: FileSystemDirectoryHandle }) {
  const output = await wrapped({ alternative }); void (output as FileSystemDirectoryHandle).getFileHandle('entry', { create: true });
}`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(expected);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not transfer a replaced Promise resolver payload into a native return proof', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects [] */ function wrapped({ handle }: { handle: FileSystemFileHandle }): Promise<unknown> {
  let resolve = Promise.resolve; resolve = Promise.reject; return resolve(handle);
}
/** @effects [] */ export async function entry({ handle }: { handle: FileSystemFileHandle }) {
  const output = await wrapped({ handle }); void (output as FileSystemFileHandle).getFile();
}`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('bounds demand-driven return recursion while preserving remaining pending-body analysis', () => {
    const chain = Array.from({ length: 48 }, (_, index) => `/** @effects [] */ function f${index}(): Storage { return ${index === 47 ? 'localStorage' : `f${index + 1}()`}; }`).join('\n');
    using fixture = createFixture({
      files: {
        'main.ts': `${chain}
/** @effects [] */ export function entry() { f0().clear(); localStorage.removeItem('known'); }`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(result.diagnostics.some(item => item.message === 'Implementation return analysis exceeds the supported depth.')).toBe(true);
  });
});
