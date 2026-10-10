import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';
import { planEffectFix } from '../fixes/plan.ts';
import { executeEffectsCommand } from '../cli.ts';
import { analyzeEffects } from '../index.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { planUnresolvedEffectFix } from '../maintenance/unverified.ts';

function checkSource({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'source.ts': source }, entries: ['source.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

describe('production effect analysis', () => {
  it.each([
    { source: '/** @effects ["call(arg0.operation)"] */ function run({ operation }: { operation: () => void }) { operation(); }', syntax: 0 },
    { source: '/** @effects ["call(arg0.nested.operation)"] */ function run({ nested }: { nested: { operation: () => void } }) { nested.operation(); }', syntax: 0 },
    { source: '/** @effects [] */ function make({ operation }: { operation: () => void }) { return /** @effects ["call(arg0.operation)"] */ () => operation(); }', syntax: 0 },
    { source: '/** @effects [] */ function make(_unused: number, { operation }: { operation: () => void }) { return /** @effects ["call(arg1.operation)"] */ () => operation(); }', syntax: 0 },
    { source: '/** @effects ["call(arg9.operation)"] */ function run({ operation }: { operation: () => void }) { operation(); }', syntax: 1 },
    { source: '/** @effects ["call(arg0.operation) trailing"] */ function run({ operation }: { operation: () => void }) { operation(); }', syntax: 1 },
    { source: '/** @effects ["call(arg0)"] */ function run(value: number) { void value; }', syntax: 1 },
    { source: '/** @effects ["call(arg0.operation)"] */ function run(value: any) { void value; }', syntax: 1 },
  ])('distinguishes budget-blocked references from invalid contracts: $source', ({ source, syntax }) => {
    const prelude = Array.from({ length: 8 }, (_, index) => `const value${index}: number = ${index};`).join('\n');
    const fixture = createFixture({ files: { 'main.ts': prelude + '\n' + source }, entries: ['main.ts'] });
    try {
      const ordinary = fixture.check();
      expect(ordinary.diagnostics.filter(item => item.code === 'syntax')).toHaveLength(syntax);
      fixture.config.analysisBudget = 4;
      const limited = fixture.check();
      expect(limited.diagnostics.filter(item => item.code === 'syntax')).toHaveLength(syntax);
      expect(limited.diagnostics.some(item => item.message.includes('budget prevented validation'))).toBe(syntax === 0);
      expect(limited.owners.filter(owner => owner.role === 'implementation').every(owner => owner.callbackPaths.size === 0)).toBe(true);
      expect(limited.owners.map(owner => owner.declared)).toEqual(ordinary.owners.filter(owner => owner.role !== 'symbolic').map(owner => owner.declared));
    } finally {
      fixture.dispose();
    }
  });

  it('retains atomic message types and modeled native reads after the type budget is exhausted', () => {
    let payload = 'string';
    for (let depth = 0; depth < 16; depth++) payload = `{ next: ${payload} }`;
    const fixture = createFixture({
      files: {
        'main.ts': 'import "./pressure"; import "./message"; import "./native"; import "./unknown";',
        'pressure.ts': `/** @effects [] */ export function pressure({ payload }: { payload: ${payload} }) {}`,
        'message.ts': 'export const message = (): string => "Folder";',
        'native.ts': '/** @effects [] */ export function read(file: FileSystemFileHandle): void { void file.getFile(); }',
        'unknown.ts': '/** @effects [] */ export function format(value: unknown): string { return `${value}`; }',
      },
      entries: ['main.ts'],
    });
    try {
      const program = createEffectsProgram({ root: fixture.root, config: fixture.config, overlays: new Map() });
      const low = analyzeEffects({ root: fixture.root, config: { ...fixture.config, analysisBudget: 10 }, program });
      const high = analyzeEffects({ root: fixture.root, config: fixture.config, program });
      expect(low.diagnostics.some(item => item.file === path.join(fixture.root, 'pressure.ts') && item.message === 'Effect type expansion exceeded its explicit analysis budget.')).toBe(true);
      expect(low.diagnostics.filter(item => item.file === path.join(fixture.root, 'message.ts'))).toEqual([]);
      const nativeRow = ({ analysis }: { analysis: ReturnType<typeof analyzeEffects> }) => analysis.owners.find(owner => owner.label === 'read' && owner.role === 'implementation')!.direct.map(effect => printEffect({ effect }));
      expect(nativeRow({ analysis: low })).toEqual(['hostfs.read(*)', 'opfs.read(*)']);
      expect(nativeRow({ analysis: low })).toEqual(nativeRow({ analysis: high }));
      const unknown = path.join(fixture.root, 'unknown.ts');
      expect(low.diagnostics.filter(item => item.file === unknown)).toEqual(high.diagnostics.filter(item => item.file === unknown));
      expect(low.diagnostics.some(item => item.file === unknown && item.message === 'Template conversion may execute user-defined hooks.')).toBe(true);
      const plan = planUnresolvedEffectFix({ analysis: low, root: fixture.root, files: low.coverage.files, mode: 'fix' });
      expect(plan.edits.some(edit => edit.file === path.join(fixture.root, 'message.ts'))).toBe(false);
      expect(() => planEffectFix({ analysis: low })).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    { name: 'native parameter binding', parameter: 'handle: FileSystemFileHandle', body: '' },
    { name: 'one native field', parameter: 'item: { handle: FileSystemFileHandle }', body: 'const handle = item.handle;' },
    { name: 'optional native narrowed at its reference', parameter: 'handle: FileSystemFileHandle | undefined', body: 'if (!handle) return;' },
  ])('recovers $name after record expansion stops without verifying the body', ({ parameter, body }) => {
    const fields = Array.from({ length: 128 }, (_, index) => `field${index}: number`).join(',');
    const argument = parameter.startsWith('item:') ? 'item' : 'handle';
    const source = `\
/** @effects [] */ function pressure({ payload }: { payload: { ${fields} } }) { void payload; }
/** @effects ["network.http(*)"] */
export async function entry({ ${argument} }: { ${parameter} }) {
  ${body}
  const file = await handle.getFile(); void file;
  const writer = await handle.createWritable(); await writer.write("bytes");
}
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const program = createEffectsProgram({ root: fixture.root, config: fixture.config, overlays: new Map() });
      expect(typescriptDiagnostics({ program })).toEqual([]);
      const low = analyzeEffects({ root: fixture.root, config: { ...fixture.config, analysisBudget: 64 }, program });
      const high = analyzeEffects({ root: fixture.root, config: fixture.config, program });
      const entry = ({ analysis }: { analysis: ReturnType<typeof analyzeEffects> }) => analysis.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
      const lowEntry = entry({ analysis: low });
      const effects = ['hostfs.read(*)', 'hostfs.write(*)', 'opfs.read(*)', 'opfs.write(*)'];
      expect(lowEntry.direct.map(effect => printEffect({ effect }))).toEqual(effects);
      expect(lowEntry.direct).toEqual(entry({ analysis: high }).direct);
      expect(lowEntry.declared.map(effect => printEffect({ effect }))).toEqual(['network.http(*)']);
      expect([...lowEntry.callbackPaths]).toEqual([]);
      expect(low.diagnostics.some(item => item.message === 'Effect type expansion exceeded its explicit analysis budget.')).toBe(true);
      expect(low.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Unverified property access'))).toBe(true);
      expect(() => planEffectFix({ analysis: low })).toThrow();
      const draft = planUnresolvedEffectFix({ analysis: low, root: fixture.root, files: low.coverage.files, mode: 'fix' });
      const edited = draft.edits.find(edit => edit.file === path.join(fixture.root, 'main.ts'))!.after;
      expect(edited).toContain('UNVERIFIED effect candidates');
      expect(edited).toContain('network.http(*)');
      for (const effect of effects) expect(edited).toContain(effect);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    { name: 'ordinary unknown', source: 'export function entry({ handle }: { handle: unknown }) { void (handle as FileSystemFileHandle).getFile(); }' },
    { name: 'cast record alias', source: 'export function entry({ item }: { item: { opaque: unknown } }) { const alias = item.opaque as { handle: FileSystemFileHandle }; void alias.handle.getFile(); }' },
    { name: 'inline record cast', source: 'export function entry({ item }: { item: { opaque: unknown } }) { void (item.opaque as { handle: FileSystemFileHandle }).handle.getFile(); }' },
    { name: 'ordinary local alias', source: 'export function entry({ item }: { item: { handle: FileSystemFileHandle } }) { const alias = item; void alias.handle.getFile(); }' },
    { name: 'explicit getter', source: 'interface Holder { get handle(): FileSystemFileHandle; } export function entry({ item }: { item: Holder }) { void item.handle.getFile(); }' },
    { name: 'native name shadow', source: 'interface FileSystemFileHandle { getFile(): Promise<File>; } export function entry({ handle }: { handle: FileSystemFileHandle }) { void handle.getFile(); }' },
    { name: 'union at reference', source: 'export function entry({ handle }: { handle: FileSystemFileHandle | undefined }) { void handle?.getFile(); }' },
    { name: 'predicate from unknown', source: 'function isFile(value: unknown): value is FileSystemFileHandle { return true; } export function entry({ handle }: { handle: unknown }) { if (isFile(handle)) void handle.getFile(); }' },
    { name: 'predicate from unknown field', source: 'function isItem(value: { handle: unknown }): value is { handle: FileSystemFileHandle } { return true; } export function entry({ item }: { item: { handle: unknown } }) { if (isItem(item)) void item.handle.getFile(); }' },
    { name: 'predicate from custom type', source: 'interface FakeHandle { getFile(): Promise<File>; } function isFile(value: FakeHandle): value is FileSystemFileHandle { return true; } export function entry({ handle }: { handle: FakeHandle }) { if (isFile(handle)) void handle.getFile(); }' },
  ])('does not recover budget-blocked native identity through $name', ({ source }) => {
    const fields = Array.from({ length: 128 }, (_, index) => `field${index}: number`).join(',');
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */ function pressure({ payload }: { payload: { ${fields} } }) { void payload; }
` + source,
      },
      entries: ['main.ts'],
    });
    try {
      const program = createEffectsProgram({ root: fixture.root, config: fixture.config, overlays: new Map() });
      expect(typescriptDiagnostics({ program })).toEqual([]);
      const low = analyzeEffects({ root: fixture.root, config: { ...fixture.config, analysisBudget: 64 }, program });
      const entry = low.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
      expect(entry.direct).toEqual([]);
      expect(low.solution.rows.get(entry.id)).toEqual([]);
      expect(low.diagnostics.some(item => item.message === 'Effect type expansion exceeded its explicit analysis budget.')).toBe(true);
      expect(() => planEffectFix({ analysis: low })).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('keeps known effects and author bounds when type expansion exhausts its budget', async () => {
    const source = `\
/** @effects ["network.http(*)"] */
export function send({ payload }: { payload: { a: { value: string }, b: { value: string }, c: { value: string }, d: { value: string } } }) {
  localStorage.clear();
  return payload.a.value;
}
send({ payload: { a: { value: "a" }, b: { value: "b" }, c: { value: "c" }, d: { value: "d" } } });
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const ordinary = fixture.check();
      expect(ordinary.diagnostics.filter(diagnostic => diagnostic.code === 'unsupported' || diagnostic.code === 'typescript')).toEqual([]);
      expect(ordinary.owners.map(owner => ordinary.solution.rows.get(owner.id)?.map(effect => printEffect({ effect })))).toEqual(Array(2).fill(['localstorage.write(*)', 'network.http(*)']));
      fs.writeFileSync(path.join(fixture.root, 'effects.config.ts'), 'export default ' + JSON.stringify({ ...fixture.config, analysisBudget: 3 }) + ';');
      const blocked = await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--json'] });
      expect(blocked.exitCode).toBe(2);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
      const candidate = await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--allow-unresolved', '--json'] });
      expect(candidate.exitCode).toBe(0);
      const report = JSON.parse(candidate.stdout);
      expect(report.verification).toBe('unverified');
      expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported', message: 'Effect type expansion exceeded its explicit analysis budget.' })]));
      expect(report.contracts).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'send', effects: ['localstorage.write(*)', 'network.http(*)'] }),
        expect.objectContaining({ label: '<module>', effects: ['localstorage.write(*)', 'network.http(*)'] }),
      ]));
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('UNVERIFIED effect candidates');
      const checked = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--json'] });
      expect(checked.exitCode).toBe(1);
      expect(JSON.parse(checked.stdout).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported', message: 'Effect type expansion exceeded its explicit analysis budget.' })]));
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it.each(['localStorage', 'sessionStorage'])('detects native writes and propagation: %s', storage => {
    const analysis = checkSource({
      source: `\
function save() { ${storage}.setItem('key', 'value'); }
function middle() { save(); }
function outer() { middle(); }
`,
    });
    expect(analysis.diagnostics.filter(diagnostic => diagnostic.code === 'unsupported' || diagnostic.code === 'typescript')).toEqual([]);
    const rows = analysis.owners.filter(owner => owner.role !== 'module').map(owner => analysis.solution.rows.get(owner.id)?.map(effect => printEffect({ effect })));
    expect(rows).toEqual(Array(3).fill([`${storage.toLowerCase()}.write(*)`]));
  });

  it('does not classify a local function by its fetch name', () => {
    const analysis = checkSource({
      source: `\
export {};
/** @effects ["localstorage.write(*)"] */
function fetch() { localStorage.clear(); }
/** @effects ["localstorage.write(*)"] */
function caller() { fetch(); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('keeps subset assignments valid and does not charge the installer', () => {
    const analysis = checkSource({
      source: `\
const actions = {
  /** @effects ["localstorage.write(*)","hoge"] */
  run: () => {},
};
/** @effects ["localstorage.write(*)"] */
function writer() { localStorage.clear(); }
/** @effects [] */
function install() { actions.run = writer; }
/** @effects ["localstorage.write(*)","hoge"] */
function execute() { actions.run(); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('rejects the reverse subset assignment', () => {
    const analysis = checkSource({
      source: `\
const actions = { /** @effects [] */ run: () => {} };
/** @effects ["localstorage.write(*)"] */
function writer() { localStorage.clear(); }
/** @effects [] */
function install() { actions.run = writer; }
`,
    });
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'exceeds')).toBe(true);
  });

  it('does not narrow a broad slot because its initial function is empty', () => {
    const analysis = checkSource({
      source: `\
const actions = { /** @effects ["localstorage.write(*)"] */ run: () => {} };
/** @effects [] */
function execute() { actions.run(); }
`,
    });
    expect(analysis.diagnostics.some(diagnostic => diagnostic.message.includes('localstorage.write(*) exceeds'))).toBe(true);
  });

  it('rejects widening a shared writable view, even though TypeScript accepts it', () => {
    const analysis = checkSource({
      source: `\
interface Empty { /** @effects [] */ run: () => void; }
interface Writable { /** @effects ["localstorage.write(*)"] */ run: () => void; }
const original: Empty = { /** @effects [] */ run: () => {} };
const alias: Writable = original;
`,
    });
    expect(analysis.diagnostics.filter(diagnostic => diagnostic.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'exceeds')).toBe(true);
  });

  it('specializes a named callback and does not contaminate another caller', () => {
    const analysis = checkSource({
      source: `\
/** @effects ["call(arg0.operation)"] */
function invoke({ operation }: { operation: () => void }) { operation(); }
/** @effects ["localstorage.write(*)"] */
function writer() { localStorage.clear(); }
/** @effects [] */
function empty() {}
/** @effects ["localstorage.write(*)"] */
function save() { invoke({ operation: writer }); }
/** @effects [] */
function inspect() { invoke({ operation: empty }); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('uses all possible destinations for a finite-key assignment', () => {
    const analysis = checkSource({
      source: `\
const actions = {
  /** @effects [] */ inspect: () => {},
  /** @effects ["localstorage.write(*)"] */ save: () => {},
};
/** @effects ["localstorage.write(*)"] */
function writer() { localStorage.clear(); }
/** @effects [] */
function install({ key }: { key: 'inspect' | 'save' }) { actions[key] = writer; }
`,
    });
    expect(analysis.diagnostics.filter(diagnostic => diagnostic.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'exceeds')).toBe(true);
  });

  it('preserves call targets through import, re-export and alias', () => {
    const fixture = createFixture({
      files: {
        'storage.ts': 'export function save() { localStorage.clear(); }',
        'barrel.ts': "export { save as persist } from './storage';",
        'main.ts': "import { persist } from './barrel'; export function main() { persist(); }",
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(diagnostic => diagnostic.code === 'unsupported' || diagnostic.code === 'typescript')).toEqual([]);
      expect(analysis.owners.filter(owner => owner.role !== 'module').length).toBe(2);
      const fixed = fixture.fix();
      expect(fixed.analysis.diagnostics).toEqual([]);
      expect(fixed.changedFiles).toHaveLength(2);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps an existing explanation and does not turn its example into a contract', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** Example only:
 * \`\`\`ts
 * // @effects ["network.http(*)"]
 * \`\`\`
 */
function save() { localStorage.clear(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      const output = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(output).toContain('// @effects ["network.http(*)"]');
      expect(output).toContain('/** @effects ["localstorage.write(*)"] */');
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('reads multiline dedicated declarations', () => {
    const analysis = checkSource({
      source: `\
/** @effects
 * ["localstorage.read(*)","localstorage.write(*)"]
 */
function save() { localStorage.setItem('x', localStorage.getItem('x') ?? ''); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it.each(['`none()`', '`none(localstorage.write(*))`', '`localstorage.write(*)`,, `hoge`'])('blocks fix for an invalid declaration %s', text => {
    const analysis = checkSource({ source: `/** @effects ${text} */ function save() { localStorage.clear(); }` });
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'syntax')).toBe(true);
    expect(() => planEffectFix({ analysis })).toThrow('refused');
  });

  it.each([
    'const value = { then: () => localStorage.clear() }; await value;',
    'const value: { x: string } = { x: "x", then: () => localStorage.clear() } as { x: string }; await value;',
  ])('never accepts an unresolved thenable as pure', body => {
    const analysis = checkSource({ source: `async function main() { ${body} }` });
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'unsupported')).toBe(true);
    expect(() => planEffectFix({ analysis })).toThrow();
  });

  it.each([
    'eval("localStorage.clear()")',
    'Reflect.set({}, "x", () => localStorage.clear())',
    'Object.assign({}, { run: () => localStorage.clear() })',
    'new Proxy({}, {})',
  ])('rejects an unmodeled reflective operation: %s', body => {
    expect(checkSource({ source: `function main() { ${body}; }` }).diagnostics.some(diagnostic => diagnostic.code === 'unsupported')).toBe(true);
  });

  it('does not require or fix contracts in ordinary test files', () => {
    const fixture = createFixture({ files: { 'main.test.ts': 'function testBody() { localStorage.clear(); }' }, entries: ['main.test.ts'] });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not make a production import of a test become pure', () => {
    const fixture = createFixture({ files: { 'main.ts': "import './test.test';", 'test.test.ts': 'localStorage.clear();' }, entries: ['main.ts'] });
    try {
      expect(fixture.check().diagnostics.some(diagnostic => diagnostic.code === 'boundary')).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it.each(['true', 'false'])('classifies OPFS create=%s without merging read and write', create => {
    const analysis = checkSource({
      source: `\
async function inspect() {
  const root = await navigator.storage.getDirectory();
  await root.getDirectoryHandle('models', { create: ${create} });
}
`,
    });
    expect(analysis.diagnostics.filter(diagnostic => diagnostic.code === 'typescript' || diagnostic.code === 'unsupported')).toEqual([]);
    const inspect = analysis.owners.find(owner => owner.label === 'inspect')!;
    const row = analysis.solution.rows.get(inspect.id)!.map(effect => printEffect({ effect }));
    expect(row).toEqual(create === 'true' ? ['opfs.read(*)', 'opfs.write(*)'] : ['opfs.read(*)']);
  });

  it('does not identify a memory writer as an OPFS writer', () => {
    const analysis = checkSource({
      source: `\
const memory = { /** @effects [] */ write: () => {} };
/** @effects [] */
function main() { memory.write(); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('detects native storage calls through a constant function alias', () => {
    const analysis = checkSource({ source: 'const put = localStorage.setItem; function main() { put("x", "y"); }' });
    expect(analysis.diagnostics.some(diagnostic => diagnostic.message.includes('localstorage.write(*) exceeds'))).toBe(true);
  });

  it('refuses to fix ordinary TypeScript errors', () => {
    const fixture = createFixture({ files: { 'main.ts': 'function main(): number { return "bad"; }' }, entries: ['main.ts'] });
    try {
      expect(() => fixture.fix()).toThrow('refused');
    } finally {
      fixture.dispose();
    }
  });
});
