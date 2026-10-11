import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { printEffect } from '../contracts/effects.ts';
import { digest } from '../project.ts';
import { createFixture } from '../test-support/project-fixture.ts';

describe('native Storage arguments bound to structural method slots', () => {
  it.each([
    { storage: 'localStorage', method: 'getItem', body: "return storage.getItem('key');", effect: 'localstorage.read(*)' },
    { storage: 'sessionStorage', method: 'setItem', body: "storage.setItem('key', 'value');", effect: 'sessionstorage.write(*)' },
  ])('binds $storage.$method through the existing native operation model', item => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
function access({ storage }: { storage: Pick<Storage, '${item.method}'> }) { ${item.body} }
function entry() { access({ storage: ${item.storage} }); }
`,
      },
      entries: ['main.ts'],
    });
    fixture.fix();
    const result = fixture.check();
    const access = result.owners.find(owner => owner.label === 'access' && owner.role === 'implementation')!;
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(access.id)?.map(effect => printEffect({ effect }))).toEqual([`call(arg0.storage.${item.method})`]);
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual([item.effect]);
    expect(result.diagnostics).toEqual([]);
    expect(fixture.fix().changedFiles).toEqual([]);
  });

  it.each([
    { body: "return storage.getItem('key');", expected: ['localstorage.read(*)'] },
    { body: "return 'unused';", expected: [] },
  ])('does not add an unused method effect: $body', item => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
function access({ storage }: { storage: Pick<Storage, 'getItem' | 'setItem'> }) { ${item.body} }
function entry() { access({ storage: localStorage }); }
`,
      },
      entries: ['main.ts'],
    });
    fixture.fix();
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(item.expected);
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    "const storage = { getItem(key: string) { fetch('/mock'); return key; } };",
    "const localStorage = { getItem(key: string) { fetch('/shadow'); return key; } }; const storage = localStorage;",
  ])('preserves the actual callback effect of a mock or shadow: %s', setup => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
function access({ storage }: { storage: Pick<Storage, 'getItem'> }) { return storage.getItem('key'); }
function entry() { ${setup} access({ storage }); }
`,
      },
      entries: ['main.ts'],
    });
    fixture.fix();
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['network.http(*)']);
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    "function access({ storage }: { storage: Storage }) { return storage.getItem('key'); } function entry() { access({ storage: localStorage }); }",
    "function access({ storage }: { storage: Pick<Storage, 'getItem'> }) { return storage.getItem('key'); } function entry() { access({ storage: { get getItem() { fetch('/getter'); return (key: string) => key; } } }); }",
  ])('retains existing bare-Storage and accessor boundaries: %s', source => {
    using fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    const result = fixture.check();
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(() => fixture.fix()).toThrow();
  });
});

const replacement = `\
function replacement(key: string) { fetch('/replacement'); return key; }
`;

describe('Storage named-setter boundaries in projected method records', () => {
  it.each([
    "storage.getItem = replacement;",
    "const alias = storage; alias.getItem = replacement;",
    "inner({ store: storage });",
    "const box = { storage }; inner({ store: box.storage });",
    "Object.assign(storage, { getItem: replacement });",
    "assignInner({ store: storage });",
  ])('refuses an unmodeled native named setter through %s', mutation => {
    using fixture = createFixture({
      files: {
        'main.ts': `${replacement}\
function inner({ store }: { store: Pick<Storage, 'getItem'> }) { store.getItem = replacement; }
function assignInner({ store }: { store: Pick<Storage, 'getItem'> }) { Object.assign(store, { getItem: replacement }); }
function access({ storage }: { storage: Pick<Storage, 'getItem'> }) { ${mutation} }
function entry() { access({ storage: localStorage }); }
`,
      },
      entries: ['main.ts'],
    });
    const result = fixture.check();
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('projected native Storage member'))).toBe(true);
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(() => fixture.fix()).toThrow();
  });

  it.each([
    "const copy = { getItem: storage.getItem }; copy.getItem = replacement;",
    "const copy = { getItem: storage.getItem }; inner({ store: copy });",
    "const copy = { getItem: storage.getItem }; Object.assign(copy, { getItem: replacement });",
    "Object.assign(storage, {});",
  ])('keeps copied callback containers and empty assignments distinct: %s', mutation => {
    using fixture = createFixture({
      files: {
        'main.ts': `${replacement}\
function inner({ store }: { store: Pick<Storage, 'getItem'> }) { store.getItem = replacement; }
function access({ storage }: { storage: Pick<Storage, 'getItem'> }) { ${mutation} }
function entry() { access({ storage: localStorage }); }
`,
      },
      entries: ['main.ts'],
    });
    fixture.fix();
    expect(fixture.check().diagnostics).toEqual([]);
  });

  it('retains native read effects through a reboxed parameter alias', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
function inner({ store }: { store: Pick<Storage, 'getItem'> }) { return store.getItem('key'); }
function access({ storage }: { storage: Pick<Storage, 'getItem'> }) { const box = { storage }; return inner({ store: box.storage }); }
function entry() { access({ storage: localStorage }); }
`,
      },
      entries: ['main.ts'],
    });
    fixture.fix();
    const result = fixture.check();
    const entry = result.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect(result.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)']);
    expect(result.diagnostics).toEqual([]);
  });

  it('checks aliases added while connecting a worker contract', () => {
    const transport = `\
declare function wrapWorkerRemote<T>(args: { endpoint: Worker }): {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
declare function exposeWorkerRemote<T>(args: { api: T; endpoint: undefined }): void;
`;
    using fixture = createFixture({
      files: {
        'transport.d.ts': transport,
        'contract.ts': `\
export interface Service {
  /** @effects [] */
  replace({ storage }: { storage: Pick<Storage, 'getItem'> }): void;
}
`,
        'entry.ts': `\
import type { Service } from './contract';
function replacement(key: string) { return key; }
const service = {
  /** @effects [] */
  replace({ storage }: { storage: Pick<Storage, 'getItem'> }) { storage.getItem = replacement; },
};
exposeWorkerRemote<Service>({ api: service, endpoint: undefined });
`,
        'client.ts': `\
/** @effectsModule ["network.http(*)"] */
import type { Service } from './contract';
const endpoint = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
const remote = wrapWorkerRemote<Service>({ endpoint });
/** @effects [] */
export async function entry() { await remote.replace({ storage: localStorage }); }
`,
      },
      entries: ['client.ts'],
    });
    const configPath = path.join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { files: string[] };
    config.files.push('transport.d.ts');
    fs.writeFileSync(configPath, JSON.stringify(config));
    fixture.config.workerTransports = [{ file: 'transport.d.ts', sha256: digest({ content: transport }), wrapExport: 'wrapWorkerRemote', exposeExport: 'exposeWorkerRemote' }];
    const result = fixture.check();
    const setters = result.diagnostics.filter(item => item.message.includes('projected native Storage member'));
    expect(setters).toHaveLength(1);
    expect(setters[0]!.file).toBe(path.join(fixture.root, 'entry.ts'));
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'boundary' && item.message.includes('worker argument serialization'))).toBe(true);
  });
});
