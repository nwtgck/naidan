import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { digest } from '../project.ts';
import { printEffect } from '../contracts/effects.ts';
import type { EffectsAnalysis } from '../analysis/analyze.ts';

const transport = `
export declare function wrapWorkerRemote<T>(args: { endpoint: Worker }): {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export declare function exposeWorkerRemote<T>(args: { api: T; endpoint: undefined }): void;
`;
const contract = `
export interface Service {
  /** @effects \`localstorage.read(*)\` */
  read(): string;
  /** @effects \`localstorage.write(*)\` */
  write(value: string): void;
}
`;
const provider = `
import { exposeWorkerRemote } from './transport';
import type { Service } from './contract';
const service = {
  /** @effects \`localstorage.read(*)\` */
  read() { return localStorage.getItem('x') ?? ''; },
  /** @effects \`localstorage.write(*)\` */
  write(value: string) { localStorage.setItem('x', value); },
};
exposeWorkerRemote<Service>({ api: service, endpoint: undefined });
`;
const client = `
import { wrapWorkerRemote } from './transport';
import type { Service } from './contract';
const endpoint = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
const remote = wrapWorkerRemote<Service>({ endpoint });
/** @effects \`localstorage.read(*)\` */
export async function inspect() { return await remote.read(); }
/** @effects \`localstorage.write(*)\` */
export async function save() { await remote.write('updated'); }
`;

function workerFixture({ edits }: { edits: Readonly<Record<string, string>> }) {
  const fixture = createFixture({ files: { 'transport.d.ts': transport, 'contract.ts': contract, 'entry.ts': provider, 'client.ts': client, ...edits }, entries: ['client.ts'] });
  fixture.config.workerTransports = [{ file: 'transport.d.ts', sha256: digest({ content: transport }), wrapExport: 'wrapWorkerRemote', exposeExport: 'exposeWorkerRemote' }];
  return fixture;
}

function effectRows({ analysis, label }: { analysis: EffectsAnalysis, label: string }): readonly string[][] {
  return analysis.owners.filter(owner => owner.label === label).map(owner => (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })));
}

describe('reviewed literal-entry worker transport', () => {
  it('discovers the entry and keeps sibling methods separate', () => {
    const fixture = workerFixture({ edits: {} });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.coverage.files.some(file => file.endsWith('/entry.ts'))).toBe(true);
      expect(effectRows({ analysis, label: 'inspect' })).toEqual([['localstorage.read(*)']]);
      expect(effectRows({ analysis, label: 'save' })).toEqual([['localstorage.write(*)']]);
    } finally {
      fixture.dispose();
    }
  });

  it('propagates a new provider operation through the shared contract and fixes once', () => {
    const fixture = workerFixture({ edits: { 'entry.ts': provider.replace("return localStorage.getItem", "fetch('/extra'); return localStorage.getItem") } });
    try {
      const before = fixture.check();
      expect(before.diagnostics.filter(item => !['missing', 'exceeds'].includes(item.code))).toEqual([]);
      expect(effectRows({ analysis: before, label: 'inspect' })[0]).toContain('network.http(*)');
      expect(effectRows({ analysis: before, label: 'save' })[0]).not.toContain('network.http(*)');
      const fixed = fixture.fix();
      expect(fixed.analysis.diagnostics).toEqual([]);
      expect(fixed.changedFiles.map(file => path.basename(file)).sort()).toEqual(['client.ts', 'contract.ts', 'entry.ts']);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('charges entry startup to worker creation, not to every remote method', () => {
    const fixture = workerFixture({
      edits: {
        'entry.ts': provider + "\nfetch('/startup');",
        'client.ts': client.replace("const endpoint =", `\
interface RemoteService { /** @effects \`localstorage.read(*)\` */ readonly read: () => Promise<string>; /** @effects \`localstorage.write(*)\` */ readonly write: (value: string) => Promise<void>; }
/** @effects \`none\` */
function create(): RemoteService { const endpoint =`).replace('const remote = wrapWorkerRemote<Service>({ endpoint });', `\
return wrapWorkerRemote<Service>({ endpoint }); }
const remote = create();`),
      },
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => !['missing', 'exceeds'].includes(item.code))).toEqual([]);
      expect(effectRows({ analysis, label: 'create' })[0]).toContain('network.http(*)');
      expect(effectRows({ analysis, label: 'inspect' })[0]).not.toContain('network.http(*)');
    } finally {
      fixture.dispose();
    }
  });

  it('rejects a structurally identical but different shared declaration', () => {
    const fixture = workerFixture({ edits: { 'other.ts': contract, 'entry.ts': provider.replace("'./contract'", "'./other'") } });
    try {
      const result = fixture.check();
      expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(result.diagnostics.some(item => item.code === 'boundary' && item.message.includes('same shared'))).toBe(true);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('does not ignore a callable hidden from the exposed shared type', () => {
    const fixture = workerFixture({
      edits: {
        'entry.ts': provider.replace("const service = {", `\
const original = {
/** @effects \`none\` */ extra() {},`).replace('exposeWorkerRemote<Service>', `\
const service: Service = original;
exposeWorkerRemote<Service>`),
      },
    });
    try {
      expect(fixture.check().diagnostics.some(item => item.message.includes('Undeclared worker member: extra'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('rejects wrapping an endpoint without a verified creation identity', () => {
    const fixture = workerFixture({ edits: { 'client.ts': client.replace("const endpoint = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });", 'declare const endpoint: Worker;') } });
    try {
      expect(fixture.check().diagnostics.some(item => item.message.includes('endpoint has no verified'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('rejects unverified reverse callbacks instead of treating them as cloneable values', () => {
    const valueContract = 'export interface Service { /** @effects `none` */ use(value: { x: string }): void; }';
    const fixture = workerFixture({
      edits: {
        'contract.ts': valueContract,
        'entry.ts': `import { exposeWorkerRemote } from './transport'; import type { Service } from './contract';
const api = { /** @effects \`none\` */ use(value: { x: string }) { void value.x; } }; exposeWorkerRemote<Service>({ api, endpoint: undefined });`,
        'client.ts': `import { wrapWorkerRemote } from './transport'; import type { Service } from './contract';
const endpoint = new Worker(new URL('./entry.ts', import.meta.url)); const remote = wrapWorkerRemote<Service>({ endpoint });
const original = { x: '', /** @effects \`localstorage.write(*)\` */ hidden: () => localStorage.clear() };
const view: { x: string } = original;
/** @effects \`none\` */ function call() { remote.use(view); }`,
      },
    });
    try {
      expect(fixture.check().diagnostics.some(item => item.message.includes('worker argument serialization'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('preserves transport checks through a typed function alias', () => {
    const fixture = workerFixture({
      edits: {
        'client.ts': client + `
/** @effects \`localstorage.write(*)\` */
const alias: (value: string) => Promise<void> = remote.write;
/** @effects \`localstorage.write(*)\` */
function call() { alias({ toString: () => localStorage.clear() } as unknown as string); }
`,
      },
    });
    try {
      const result = fixture.check();
      expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(result.diagnostics.some(item => item.code === 'unsupported' || item.code === 'boundary')).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('pins transport model bytes before analysis', () => {
    const fixture = workerFixture({ edits: {} });
    try {
      fs.appendFileSync(path.join(fixture.root, 'transport.d.ts'), '\n// changed');
      expect(() => fixture.check()).toThrow('Reviewed effect model changed');
    } finally {
      fixture.dispose();
    }
  });

  it('rechecks Vue callback provenance after a remote method crosses a typed alias', () => {
    const vue = 'export declare function onMounted(callback: () => void): void;';
    const fixture = workerFixture({
      edits: {
        'vue.d.ts': vue,
        'client.ts': client + `\
import { onMounted } from './vue';
const alias: () => Promise<string> = remote.read;
/** @effects \`localstorage.read(*)\` */
function install() { onMounted(alias); }
`,
      },
    });
    fixture.config.vueModels = [{ file: 'vue.d.ts', sha256: digest({ content: vue }) }];
    try {
      const result = fixture.check();
      expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(result.diagnostics.some(item => item.code === 'boundary' && item.message.includes('Vue callback registration cannot use a remote method'))).toBe(true);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('rejects higher-order remote forwarding that is not yet modeled', () => {
    const fixture = workerFixture({
      edits: {
        'client.ts': client + `
/** @effects \`call(arg0)\` */
function invoke(callback: () => Promise<string>) { callback(); }
/** @effects \`localstorage.read(*)\` */
function wrapper() { invoke(remote.read); }
`,
      },
    });
    try {
      expect(fixture.check().diagnostics.some(item => item.message.includes('Higher-order remote forwarding'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });
});

describe('unsafe exceptions at reviewed worker boundaries', () => {
  const exception = '/** @effectsUNSAFE `localstorage.read(*)` -- "Reviewed worker probe." */';
  const maskedProvider = provider.replace('/** @effects `localstorage.read(*)` */', '/** @effects `none` */')
    .replace('  read() {', `  ${exception}\n  read() {`);
  const maskedContract = contract.replace('`localstorage.read(*)`', '`none`');
  const maskedClient = client.replace('`localstorage.read(*)`', '`none`');

  it('uses the provider public contract without losing its auditable body', () => {
    const fixture = workerFixture({ edits: { 'entry.ts': maskedProvider, 'contract.ts': maskedContract, 'client.ts': maskedClient } });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(effectRows({ analysis, label: 'inspect' })).toEqual([[]]);
      expect(effectRows({ analysis, label: 'save' })).toEqual([['localstorage.write(*)']]);
      expect(analysis.unsafeSuppressions[0]?.suppressed.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)']);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('retains network additions through a masked provider and fixes the shared declaration', () => {
    const fixture = workerFixture({
      edits: {
        'entry.ts': maskedProvider.replace('read() {', "read() { fetch('/unexpected');"),
        'contract.ts': maskedContract,
        'client.ts': maskedClient,
      },
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
      expect(effectRows({ analysis, label: 'inspect' })).toEqual([['network.http(*)']]);
      expect(effectRows({ analysis, label: 'save' })).toEqual([['localstorage.write(*)']]);
      const fixed = fixture.fix();
      expect(fixed.analysis.diagnostics).toEqual([]);
      expect(fixed.changedFiles.map(file => path.basename(file)).sort()).toEqual(['client.ts', 'contract.ts', 'entry.ts']);
      expect(fs.readFileSync(path.join(fixture.root, 'entry.ts'), 'utf8')).toContain(exception);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('cannot use a shared type declaration to exempt a provider body', () => {
    const fixture = workerFixture({ edits: { 'contract.ts': maskedContract.replace('  read():', `  ${exception}\n  read():`) } });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'boundary')).toBe(true);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('keeps provider checking enabled when only the client wrapper masks the call', () => {
    const fixture = workerFixture({
      edits: {
        'entry.ts': provider.replace('/** @effects `localstorage.read(*)` */', '/** @effects `none` */'),
        'client.ts': maskedClient.replace('export async function inspect()', `${exception}\nexport async function inspect()`),
      },
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'exceeds').map(item => path.basename(item.file))).toEqual(['entry.ts']);
      expect(effectRows({ analysis, label: 'inspect' })).toEqual([[]]);
      fixture.fix();
      expect(fixture.check().diagnostics).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });
});
