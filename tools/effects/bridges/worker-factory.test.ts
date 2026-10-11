import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { digest } from '../project.ts';
import { printEffect } from '../contracts/effects.ts';
import type { EffectsAnalysis } from '../analysis/analyze.ts';

const transport = `\
type WorkerServerApi<Api> = {
  [K in keyof Api]: Api[K] extends (...args: infer Args) => infer Result
    ? (...args: { [I in keyof Args]: Args[I] }) => Result : Api[K];
};
declare function wrapWorkerRemote<T>(args: { endpoint: Worker }): {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
declare function exposeWorkerRemote<T>(args: { api: WorkerServerApi<T>; endpoint: undefined }): void;
`;
const contract = `\
export interface Service {
  configure(x: string, y?: string): Promise<void>;
  query({ request }: { request: string }): Promise<{ data: string }>;
}
`;
const api = `\
{
  /** @effects ["localstorage.write(*)"] */
  async configure(x: string, y?: string) { localStorage.setItem(x, y ?? ''); },
  /** @effects ["localstorage.read(*)"] */
  async query({ request }: { request: string }) { return { data: localStorage.getItem(request) ?? '' }; },
}`;
const alternative = api.replaceAll('localStorage', 'sessionStorage').replaceAll('localstorage.', 'sessionstorage.');
const client = `\
import type { Service } from './contract';
const endpoint = new Worker(new URL('./entry.ts', import.meta.url));
const remote = wrapWorkerRemote<Service>({ endpoint });
/** @effects [] */
export async function inspect() { return await remote.query({ request: 'x' }); }
/** @effects [] */
export async function configureClient() { await remote.configure('x'); }
`;
const exposure = 'exposeWorkerRemote<Service>({ api: create(), endpoint: undefined });';
const factory = `/** @effects [] */ function create(): WorkerServerApi<Service> { return ${api}; }`;
const shapeMessage = 'The complete exposed worker shape is not known.';

function factoryFixture({ body, edits }: { body: string, edits: Readonly<Record<string, string>> }) {
  const fixture = createFixture({
    files: {
      'transport.d.ts': transport,
      'contract.ts': contract,
      'entry.ts': `\
import type { Service } from './contract';
${body}`,
      'client.ts': client,
      ...edits,
    },
    entries: ['client.ts'],
  });
  const tsconfig = path.join(fixture.root, 'tsconfig.json');
  const config = JSON.parse(fs.readFileSync(tsconfig, 'utf8')) as { files: string[] };
  config.files.push('transport.d.ts');
  fs.writeFileSync(tsconfig, JSON.stringify(config));
  fixture.config.workerTransports = [{ file: 'transport.d.ts', sha256: digest({ content: edits['transport.d.ts'] ?? transport }), wrapExport: 'wrapWorkerRemote', exposeExport: 'exposeWorkerRemote' }];
  return fixture;
}

function row({ analysis, label }: { analysis: EffectsAnalysis, label: string }): readonly string[] {
  const owner = analysis.owners.find(candidate => candidate.label === label && candidate.role === 'implementation');
  expect(owner).toBeDefined();
  return (analysis.solution.rows.get(owner!.id) ?? []).map(effect => printEffect({ effect }));
}

describe('worker API factories with checked implementation returns', () => {
  it.each([
    ['direct object', `const service = ${api}; exposeWorkerRemote<Service>({ api: service, endpoint: undefined });`],
    ['plain return type', `/** @effects [] */ function create(): Service { return ${api}; } ${exposure}`],
    ['mapped return type', `${factory} ${exposure}`],
    ['inferred return type', `/** @effects [] */ function create() { return ${api}; } ${exposure}`],
    ['plain typed const', `const service: Service = ${api}; exposeWorkerRemote<Service>({ api: service, endpoint: undefined });`],
    ['mapped typed const', `const service: WorkerServerApi<Service> = ${api}; exposeWorkerRemote<Service>({ api: service, endpoint: undefined });`],
    ['parenthesized arrow return', `const create = /** @effects [] */ () => ((${api})); ${exposure}`],
  ])('keeps sibling methods separate through %s', (_name, body) => {
    using fixture = factoryFixture({ body, edits: {} });
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.message === shapeMessage)).toBe(false);
    expect(row({ analysis, label: 'inspect' })).toEqual(['localstorage.read(*)']);
    expect(row({ analysis, label: 'configureClient' })).toEqual(['localstorage.write(*)']);
  });

  it.each([
    ['unknown returned spread', `declare const extension: object; /** @effects [] */ function create(): WorkerServerApi<Service> { return { ...${api}, ...extension }; } ${exposure}`],
    ['unknown computed member', `declare const key: string; /** @effects [] */ function create(): WorkerServerApi<Service> { return { ...${api}, [key]: '' }; } ${exposure}`],
    ['choice callee', `declare const flag: boolean; ${factory} /** @effects [] */ function other(): WorkerServerApi<Service> { return ${alternative}; } const createChoice = flag ? create : other; exposeWorkerRemote<Service>({ api: createChoice(), endpoint: undefined });`],
    ['optional callee', `declare const flag: boolean; ${factory} const createChoice = flag ? create : undefined; exposeWorkerRemote<Service>({ api: createChoice!(), endpoint: undefined });`],
    ['mutable callee', `${factory} let changing = create; changing = () => (${alternative}); exposeWorkerRemote<Service>({ api: changing(), endpoint: undefined });`],
    ['multiple returns', `declare const flag: boolean; /** @effects [] */ function create(): WorkerServerApi<Service> { if (flag) return ${api}; return ${alternative}; } ${exposure}`],
    ['open returned argument', `/** @effects [] */ function create({ source }: { source: Service }): WorkerServerApi<Service> { return source; } const source = ${api}; exposeWorkerRemote<Service>({ api: create({ source }), endpoint: undefined });`],
    ['returned variable replacement', `/** @effects [] */ function create(): WorkerServerApi<Service> { let service = ${api}; service = ${alternative}; return service; } ${exposure}`],
    ['returned method replacement', `/** @effects [] */ function create(): WorkerServerApi<Service> { const service = ${api}; service.query = /** @effects ["sessionstorage.read(*)"] */ async ({ request }: { request: string }) => ({ data: sessionStorage.getItem(request) ?? '' }); return service; } ${exposure}`],
    ['exposed variable replacement', `${factory} let service = create(); service = ${alternative}; exposeWorkerRemote<Service>({ api: service, endpoint: undefined });`],
    ['exposed method replacement', `${factory} const service = create(); service.query = /** @effects ["sessionstorage.read(*)"] */ async ({ request }: { request: string }) => ({ data: sessionStorage.getItem(request) ?? '' }); exposeWorkerRemote<Service>({ api: service, endpoint: undefined });`],
    ['independent factory instances', `${factory} const stable = create(); let changing = create(); changing = ${alternative}; exposeWorkerRemote<Service>({ api: stable, endpoint: undefined });`],
    ['const alias of replaced binding', `${factory} let service = create(); const stable = service; service = ${alternative}; exposeWorkerRemote<Service>({ api: stable, endpoint: undefined });`],
    ['overwriting argument spread', `${factory} const replacement: { api?: WorkerServerApi<Service> } = { api: ${alternative} }; exposeWorkerRemote<Service>({ api: create(), ...replacement, endpoint: undefined });`],
  ])('keeps %s unresolved instead of selecting a stale factory proof', (_name, body) => {
    using fixture = factoryFixture({ body, edits: {} });
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message === shapeMessage)).toBe(true);
    expect(row({ analysis, label: 'inspect' })).toEqual([]);
    expect(row({ analysis, label: 'configureClient' })).toEqual([]);
  });

  it.each([
    ['promise', `/** @effects [] */ async function create(): Promise<WorkerServerApi<Service>> { return ${api}; }`, transport.replace('api: WorkerServerApi<T>', 'api: WorkerServerApi<T> | Promise<WorkerServerApi<T>>')],
    ['unknown', `/** @effects [] */ function create(): unknown { return ${api}; }`, transport.replace('api: WorkerServerApi<T>', 'api: unknown')],
  ])('does not extract a record from a %s API', (_name, body, declarations) => {
    using fixture = factoryFixture({ body: `${body} ${exposure}`, edits: { 'transport.d.ts': declarations } });
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.message === shapeMessage)).toBe(true);
    expect(row({ analysis, label: 'inspect' })).toEqual([]);
    expect(row({ analysis, label: 'configureClient' })).toEqual([]);
  });

  it('retains a provider upper bound without charging startup to sibling methods', () => {
    const wideFactory = factory.replace('["localstorage.write(*)"]', '["localstorage.write(*)", "network.http(*)"]');
    using fixture = factoryFixture({ body: `${wideFactory} ${exposure} fetch('/startup');`, edits: {} });
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(row({ analysis, label: 'inspect' })).toEqual(['localstorage.read(*)']);
    expect(row({ analysis, label: 'configureClient' })).toEqual(['localstorage.write(*)', 'network.http(*)']);
    const modules = analysis.owners.filter(owner => owner.role === 'module');
    expect(modules.some(owner => (analysis.solution.rows.get(owner.id) ?? []).some(effect => printEffect({ effect }) === 'network.http(*)'))).toBe(true);
  });

  it('checks hidden members in the returned body shape', () => {
    using fixture = factoryFixture({ body: `/** @effects [] */ function create() { return { ...${api}, /** @effects [] */ extra() {} }; } ${exposure}`, edits: {} });
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message === 'Undeclared worker member: extra.')).toBe(true);
  });

  it('retains return serialization checks after the factory proof is recovered', () => {
    const body = factory.replace("return { data: localStorage.getItem(request) ?? '' };", "return /** @effects [\"localstorage.read(*)\"] */ () => localStorage.getItem(request) ?? '';");
    using fixture = factoryFixture({ body: `${body} ${exposure}`, edits: { 'contract.ts': contract.replace('Promise<{ data: string }>', 'Promise<() => string>') } });
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message === 'Unverified worker return serialization for query.')).toBe(true);
  });

  it('retains argument serialization checks after the factory proof is recovered', () => {
    const body = factory.replace('configure(x: string, y?: string)', 'configure(x: () => string, y?: string)').replace("localStorage.setItem(x, y ?? '');", "localStorage.setItem(x(), y ?? '');");
    using fixture = factoryFixture({ body: `${body} ${exposure}`, edits: { 'contract.ts': contract.replace('x: string, y?: string', 'x: () => string, y?: string'), 'client.ts': client.replace("remote.configure('x')", "remote.configure(/** @effects [] */ () => 'x')") } });
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message === 'Unverified worker argument serialization; a structural type is not a closed wire shape.')).toBe(true);
  });
});
