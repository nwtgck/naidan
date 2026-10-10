import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { digest } from '../project.ts';
import { createFixture } from '../test-support/project-fixture.ts';
import { vueFixture } from '../test-support/vue-fixture.ts';
import { runEffectTidy } from './tidy.ts';

function tidy({ fixture, write, files }: {
  fixture: ReturnType<typeof createFixture>, write: 'preview' | 'write', files: readonly string[],
}) {
  return runEffectTidy({ root: fixture.root, config: fixture.config, files, write, inputSnapshots: new Map() });
}

function contents({ fixture, file }: { fixture: ReturnType<typeof createFixture>, file: string }): string {
  return fs.readFileSync(path.join(fixture.root, file), 'utf8');
}

describe('opt-in effect contract maintenance', () => {
  it('previews a transitive contraction without writing and is idempotent after explicit write', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `import { read } from './read';
/** @effects \`localstorage.read(*)\`, \`network.http(*)\` */
export function entry() { read(); }
`,
        'read.ts': '/** @effects `localstorage.read(*)`, `network.http(*)` */ export function read() { localStorage.getItem("x"); }',
      },
      entries: ['main.ts', 'read.ts'],
    });
    try {
      const before = contents({ fixture, file: 'main.ts' });
      expect(fixture.check().diagnostics).toEqual([]); // Broad valid contracts are not errors.
      const preview = tidy({ fixture, write: 'preview', files: fixture.config.files });
      expect(preview.changes).toHaveLength(2);
      expect(preview.changes.every(change => change.after.join(',') === 'localstorage.read(*)')).toBe(true);
      expect(preview.changedFiles).toEqual([]);
      expect(contents({ fixture, file: 'main.ts' })).toBe(before);
      expect(tidy({ fixture, write: 'write', files: fixture.config.files }).changedFiles).toHaveLength(2);
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(tidy({ fixture, write: 'preview', files: fixture.config.files }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not infer through an unselected callee contract or edit its file', () => {
    const fixture = createFixture({
      files: {
        'main.ts': "import { task } from './dep'; /** @effects `network.http(*)` */ export function run() { task(); }",
        'dep.ts': '/** @effects `network.http(*)` */ export function task() {}',
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toEqual([]);
      expect(result.selections.some(item => item.label === 'task' && item.disposition === 'preserve')).toBe(true);
      expect(result.changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    '/** @effects `network.http(*)` */ function a() { a(); }',
    '/** @effects `network.http(*)` */ function a() { b(); } /** @effects `network.http(*)` */ function b() { a(); }',
    '/** @effects `network.http(*)`, `localstorage.write(*)` */ function a() { b(); } /** @effects `network.http(*)`, `localstorage.write(*)` */ function b() { a(); localStorage.clear(); }',
  ])('restarts cyclic inference from actual operations: %s', source => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      const expected = source.includes('localStorage.clear') ? ['localstorage.write(*)'] : [];
      expect(result.changes.every(change => JSON.stringify(change.after) === JSON.stringify(expected))).toBe(true);
      expect(result.changes.length).toBeGreaterThan(0);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps future permissions on a callable property even when its initializer is empty', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `const actions = {
  /** @effects \`localstorage.write(*)\`, \`network.http(*)\` */
  run: () => {},
};
/** @effects \`localstorage.write(*)\`, \`network.http(*)\`, \`hoge\` */
function execute() { actions.run(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toMatchObject([{ label: 'execute', after: ['localstorage.write(*)', 'network.http(*)'] }]);
      expect(result.selections.find(item => item.label === 'run')?.disposition).toBe('preserve');
      expect(contents({ fixture, file: 'main.ts' })).toContain(`\
/** @effects \`localstorage.write(*)\`, \`network.http(*)\` */
  run`);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps variable bindings and explicit signatures fixed rather than narrowing shared aliases', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `/** @effects \`localstorage.write(*)\` */ type Job = () => void;
/** @effects \`localstorage.write(*)\` */ function empty() {}
/** @effects \`localstorage.write(*)\` */ const alias: Job = empty;
/** @effects \`localstorage.write(*)\` */ function run() { alias(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'preview', files: ['main.ts'] });
      expect(result.changes).toMatchObject([{ label: 'empty', after: [] }]);
      expect(result.changes.some(change => change.label === 'run')).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps callback polymorphism while removing unrelated operations', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `/** @effects \`call(arg0.operation)\`, \`network.http(*)\` */
function invoke({ operation }: { operation: () => void }) { operation(); }
/** @effects \`localstorage.read(*)\` */ function read() { localStorage.getItem('x'); }
/** @effects \`localstorage.write(*)\` */ function write() { localStorage.clear(); }
/** @effects \`localstorage.read(*)\`, \`network.http(*)\` */ function readEntry() { invoke({ operation: read }); }
/** @effects \`localstorage.write(*)\`, \`network.http(*)\` */ function writeEntry() { invoke({ operation: write }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'invoke', after: ['call(arg0.operation)'] }),
        expect.objectContaining({ label: 'readEntry', after: ['localstorage.read(*)'] }),
        expect.objectContaining({ label: 'writeEntry', after: ['localstorage.write(*)'] }),
      ]));
    } finally {
      fixture.dispose();
    }
  });

  it('preserves unsafe text and independently checks the suppressed implementation', () => {
    const directive = '/** @effectsUNSAFE `opfs.write(*)` -- "Reviewed probe, not a sandbox." */';
    const fixture = createFixture({
      files: {
        'main.ts': `/** @effects \`opfs.write(*)\` */
function write() { /* broad callee contract is intentionally pinned below */ }
/** @effects \`network.http(*)\` */
${directive}
function probe() { write(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      // Narrowing write would make the exception stale. Refuse the entire plan,
      // rather than silently removing the exception or writing partial changes.
      const before = contents({ fixture, file: 'main.ts' });
      expect(() => tidy({ fixture, write: 'write', files: ['main.ts'] })).toThrow('Unused unsafe');
      expect(contents({ fixture, file: 'main.ts' })).toBe(before);
    } finally {
      fixture.dispose();
    }
  });

  it('can narrow outward effects without changing a valid unsafe boundary', () => {
    const directive = '/** @effectsUNSAFE `localstorage.write(*)` -- "Reviewed capability probe." */';
    const fixture = createFixture({
      files: {
        'main.ts': `/** @effects \`network.http(*)\` */
${directive}
function probe() { localStorage.clear(); }
/** @effects \`network.http(*)\` */ function entry() { probe(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toHaveLength(2);
      expect(result.analysis.unsafeSuppressions).toHaveLength(1);
      expect(contents({ fixture, file: 'main.ts' })).toContain(directive);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'function run() {}',
    '/** @effects `none` */ function run() { localStorage.clear(); }',
    '/** @effects `network.http(*)` */ function run() { unknownCall(); }',
    '/** @effects `misspelled(*)` */ function run() {}',
    'const x: number = "bad"; /** @effects `none` */ function run() {}',
    '/** @effects `none` */ /** @effectsUNSAFE `network.http(*)` -- "Old exception." */ function run() {}',
  ])('does not write on invalid input: %s', source => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      expect(() => tidy({ fixture, write: 'write', files: ['main.ts'] })).toThrow('clean ordinary check');
      expect(contents({ fixture, file: 'main.ts' })).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('leaves ordinary test annotations and source text untouched', () => {
    const source = '/** @effects `network.http(*)` */ function unusedTest() {}';
    const fixture = createFixture({ files: { 'normal.test.ts': source }, entries: ['normal.test.ts'] });
    try {
      expect(tidy({ fixture, write: 'write', files: ['normal.test.ts'] }).changes).toEqual([]);
      expect(contents({ fixture, file: 'normal.test.ts' })).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('rejects an unanalysed file instead of quietly expanding the rollout', () => {
    const fixture = createFixture({ files: { 'main.ts': '', 'outside.ts': '/** @effects `network.http(*)` */ function outside() {}' }, entries: ['main.ts'] });
    try {
      expect(() => tidy({ fixture, write: 'write', files: ['outside.ts'] })).toThrow('outside the analyzed scope');
    } finally {
      fixture.dispose();
    }
  });

  it('preserves comment prose, CRLF, and executable source', () => {
    const source = ['/** Documentation stays byte-for-byte. */', '/** @effects `network.http(*)` */', 'export function task() {}', ''].join(String.fromCharCode(13, 10));
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.edits[0]?.after).toBe(source.replace('`network.http(*)`', '`none`'));
    } finally {
      fixture.dispose();
    }
  });

  it('retains a mutable callable slot and its assigned implementations', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `/** @effects \`localstorage.write(*)\` */ let run = () => {};
/** @effects \`localstorage.write(*)\` */ function writer() { localStorage.clear(); }
/** @effects \`none\` */ function install() { run = writer; }
/** @effects \`localstorage.write(*)\` */ function entry() { run(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      expect(tidy({ fixture, write: 'preview', files: ['main.ts'] }).changes).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('recomputes cleanup dependencies without assigning them to Vue state writes', () => {
    const fixture = vueFixture({
      source: `const state = ref('');
/** @effects \`network.http(*)\`, \`sessionstorage.write(*)\` */
function cleanup() { sessionStorage.clear(); }
/** @effects \`network.http(*)\`, \`localstorage.write(*)\`, \`sessionstorage.write(*)\` */
function callback() { localStorage.clear(); onWatcherCleanup(cleanup); }
const handle = watch(state, callback);
/** @effects \`network.http(*)\`, \`sessionstorage.write(*)\` */
function stop() { handle.stop(); }
/** @effects \`none\` */ function update() { state.value = 'next'; }
`,
      extra: {},
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes.find(change => change.label === 'stop')?.after).toEqual(['sessionstorage.write(*)']);
      expect(fixture.check().diagnostics).toEqual([]);
      expect(result.changes.some(change => change.label === 'update')).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('does not write if a configuration snapshot changed', () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects `network.http(*)` */ function task() {}' }, entries: ['main.ts'] });
    try {
      expect(() => runEffectTidy({
        root: fixture.root,
        config: fixture.config,
        files: ['main.ts'],
        write: 'write',
        inputSnapshots: new Map([[path.join(fixture.root, 'tsconfig.json'), 'stale']]),
      })).toThrow('changed after analysis');
    } finally {
      fixture.dispose();
    }
  });

  it('rolls back an earlier replacement on a later write failure', () => {
    const fixture = createFixture({
      files: {
        'a.ts': '/** @effects `network.http(*)` */ export function a() {}',
        'b.ts': '/** @effects `network.http(*)` */ export function b() {}',
      },
      entries: ['a.ts', 'b.ts'],
    });
    try {
      const before = fixture.config.files.map(file => contents({ fixture, file }));
      const original = fs.renameSync;
      let calls = 0;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (++calls === 2) throw new Error('Injected second-file rename failure');
        original(from, to);
      });
      try {
        expect(() => tidy({ fixture, write: 'write', files: fixture.config.files })).toThrow('rolled back');
      } finally {
        spy.mockRestore();
      }
      expect(fixture.config.files.map(file => contents({ fixture, file }))).toEqual(before);
    } finally {
      fixture.dispose();
    }
  });
});

describe('tidy preserves additional contract boundaries', () => {
  it('keeps a worker shared signature fixed while tidying an independent implementation helper', () => {
    const transport = `\
export declare function wrapWorkerRemote<T>(args: { endpoint: Worker }): { readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
export declare function exposeWorkerRemote<T>(args: { api: T; endpoint: undefined }): void;
`;
    const fixture = createFixture({
      files: {
        'transport.d.ts': transport,
        'contract.ts': 'export interface Service { /** @effects `localstorage.read(*)`, `network.http(*)` */ read(): string; }',
        'entry.ts': `\
import type { Service } from './contract';
import { exposeWorkerRemote } from './transport';
/** @effects \`localstorage.read(*)\`, \`network.http(*)\` */
function helper() { return localStorage.getItem('x') ?? ''; }
const service = {
  /** @effects \`localstorage.read(*)\`, \`network.http(*)\` */
  read() { return helper(); },
};
exposeWorkerRemote<Service>({ api: service, endpoint: undefined });
`,
        'client.ts': `\
import type { Service } from './contract';
import { wrapWorkerRemote } from './transport';
const endpoint = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
const remote = wrapWorkerRemote<Service>({ endpoint });
/** @effects \`localstorage.read(*)\`, \`network.http(*)\` */
export async function inspect() { return await remote.read(); }
`,
      },
      entries: ['client.ts'],
    });
    fixture.config.workerTransports = [{ file: 'transport.d.ts', sha256: digest({ content: transport }), wrapExport: 'wrapWorkerRemote', exposeExport: 'exposeWorkerRemote' }];
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      const result = tidy({ fixture, write: 'write', files: ['client.ts', 'entry.ts', 'contract.ts'] });
      expect(result.changes).toMatchObject([{ label: 'helper', after: ['localstorage.read(*)'] }]);
      expect(result.selections.find(item => item.label === 'read' && item.file.endsWith('contract.ts'))?.disposition).toBe('preserve');
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(tidy({ fixture, write: 'preview', files: ['client.ts', 'entry.ts', 'contract.ts'] }).changes).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('refuses an unrelated imported implementation boundary before changing declarations', () => {
    const fixture = createFixture({
      files: {
        'main.ts': '/** @effects `network.http(*)` */ export function task() {}',
        'external.d.ts': 'export declare function external(): void;',
        'other.ts': "import { external } from './external'; /** @effects `none` */ external();",
      },
      entries: ['main.ts', 'other.ts'],
    });
    try {
      // An unmodeled imported body is a real boundary failure, not excess effects.
      const before = contents({ fixture, file: 'main.ts' });
      expect(() => tidy({ fixture, write: 'write', files: ['main.ts'] })).toThrow('clean ordinary check');
      expect(contents({ fixture, file: 'main.ts' })).toBe(before);
    } finally {
      fixture.dispose();
    }
  });

  it('preserves a returned callable signature rather than replacing its permission with the current body', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects \`network.http(*)\` */ type Job = () => void;
/** @effects \`network.http(*)\` */ function empty() {}
/** @effects \`network.http(*)\` */ function factory(): Job { return empty; }
/** @effects \`network.http(*)\` */ function execute() { factory()(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'empty', after: [] }),
        expect.objectContaining({ label: 'factory', after: [] }),
      ]));
      expect(result.changes.some(change => change.label === 'execute')).toBe(false);
      expect(contents({ fixture, file: 'main.ts' })).toContain('/** @effects `network.http(*)` */ type Job');
    } finally {
      fixture.dispose();
    }
  });

  it('does not turn known model assumptions into an inferred empty external contract', () => {
    const declaration = 'export declare function read(): string;';
    const fixture = createFixture({
      files: {
        'external.d.ts': declaration,
        'main.ts': "import { read } from './external'; /** @effects `localstorage.read(*)`, `network.http(*)` */ export function run() { read(); }",
      },
      entries: ['main.ts'],
    });
    fixture.config.models = [{ file: 'external.d.ts', export: 'read', effects: ['localstorage.read(*)'], returnValue: 'scalar', sha256: digest({ content: declaration }) }];
    try {
      const result = tidy({ fixture, write: 'preview', files: ['main.ts'] });
      expect(result.changes).toMatchObject([{ label: 'run', after: ['localstorage.read(*)'] }]);
      expect(result.analysis.assumptions.length).toBeGreaterThan(0);
    } finally {
      fixture.dispose();
    }
  });

  it('checks model pins on preview as well as write', () => {
    const fixture = createFixture({ files: { 'model.d.ts': 'export declare const X: string;', 'main.ts': '/** @effects `network.http(*)` */ function task() {}' }, entries: ['main.ts'] });
    fixture.config.models = [{ file: 'model.d.ts', export: 'X', effects: [], returnValue: 'scalar-value', sha256: 'a'.repeat(64) }];
    try {
      expect(() => tidy({ fixture, write: 'preview', files: ['main.ts'] })).toThrow('Reviewed effect model changed');
    } finally {
      fixture.dispose();
    }
  });

  it('keeps default-argument evaluation and finally effects in the reduced contract', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects \`network.http(*)\`, \`localstorage.write(*)\`, \`sessionstorage.write(*)\` */
export function run({ value = (localStorage.clear(), 'default') }: { value?: string }) {
  try { return value; } finally { sessionStorage.clear(); }
}
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toMatchObject([{ label: 'run', after: ['localstorage.write(*)', 'sessionstorage.write(*)'] }]);
    } finally {
      fixture.dispose();
    }
  });

  it('distinguishes an unused callback contract from callback execution during inference', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects \`call(arg0.operation)\`, \`network.http(*)\` */
function ignore({ operation }: { operation: () => void }) { void operation; }
/** @effects \`localstorage.write(*)\` */
function writer() { localStorage.clear(); }
/** @effects \`localstorage.write(*)\`, \`network.http(*)\` */
function run() { ignore({ operation: writer }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'ignore', after: [] }),
        expect.objectContaining({ label: 'run', after: [] }),
      ]));
    } finally {
      fixture.dispose();
    }
  });

  it('includes operations in a recursive group without retaining declaration-only permission', () => {
    // Build real source from a seeded graph; compare to an independent reachability
    // closure, not another invocation of the production solver.
    let state = 117;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state;
    };
    for (let iteration = 0; iteration < 12; iteration++) {
      const size = 7;
      const calls = Array.from({ length: size }, () => Array.from({ length: 2 }, () => next() % size));
      const direct = Array.from({ length: size }, () => next() % 3 === 0);
      const source = calls.map((targets, index) => '/** @effects `network.http(*)`, `localstorage.write(*)` */ function f' + index + '() { '
        + (direct[index] ? 'localStorage.clear(); ' : '') + targets.map(target => 'f' + target + '();').join(' ') + ' }').join('\n');
      const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
      try {
        const result = tidy({ fixture, write: 'preview', files: ['main.ts'] });
        for (let index = 0; index < size; index++) {
          const reachable = new Set([index]);
          const pending = [index];
          for (let head = 0; head < pending.length; head++) {
            for (const target of calls[pending[head]!]!) if (!reachable.has(target)) {
              reachable.add(target); pending.push(target);
            }
          }
          const expected = [...reachable].some(target => direct[target]) ? ['localstorage.write(*)'] : [];
          expect(result.changes.find(change => change.label === 'f' + index)?.after).toEqual(expected);
        }
      } finally {
        fixture.dispose();
      }
    }
  }, 30_000);
});

describe('tidy keeps the requested permission lattice', () => {
  it('allows a smaller implementation without tightening the annotated destination', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects \`localstorage.write(*)\`, \`hoge\` */
function writer() { localStorage.clear(); }
const actions = {
  /** @effects \`localstorage.write(*)\`, \`hoge\` */
  run: writer,
};
/** @effects \`localstorage.write(*)\`, \`hoge\` */
function execute() { actions.run(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = tidy({ fixture, write: 'write', files: ['main.ts'] });
      expect(result.changes).toMatchObject([{ label: 'writer', after: ['localstorage.write(*)'] }]);
      expect(contents({ fixture, file: 'main.ts' })).toContain(`\
/** @effects \`localstorage.write(*)\`, \`hoge\` */
  run: writer`);
      expect(result.changes.some(change => change.label === 'execute')).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('does not narrow a callee by using its one currently-pure callback argument', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects \`call(arg0.operation)\` */ function invoke({ operation }: { operation: () => void }) { operation(); }
/** @effects \`none\` */ function noop() {}
/** @effects \`none\` */ function run() { invoke({ operation: noop }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      expect(tidy({ fixture, write: 'write', files: ['main.ts'] }).changes).toEqual([]);
      expect(contents({ fixture, file: 'main.ts' })).toContain('call(arg0.operation)');
    } finally {
      fixture.dispose();
    }
  });
});
