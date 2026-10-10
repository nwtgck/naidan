import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';
import { planEffectFix } from '../fixes/plan.ts';

function checkSource({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'source.ts': source }, entries: ['source.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

describe('production effect analysis', () => {
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
/** @effects \`localstorage.write(*)\` */
function fetch() { localStorage.clear(); }
/** @effects \`localstorage.write(*)\` */
function caller() { fetch(); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('keeps subset assignments valid and does not charge the installer', () => {
    const analysis = checkSource({
      source: `\
const actions = {
  /** @effects \`localstorage.write(*)\`, \`hoge\` */
  run: () => {},
};
/** @effects \`localstorage.write(*)\` */
function writer() { localStorage.clear(); }
/** @effects \`none\` */
function install() { actions.run = writer; }
/** @effects \`localstorage.write(*)\`, \`hoge\` */
function execute() { actions.run(); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('rejects the reverse subset assignment', () => {
    const analysis = checkSource({
      source: `\
const actions = { /** @effects \`none\` */ run: () => {} };
/** @effects \`localstorage.write(*)\` */
function writer() { localStorage.clear(); }
/** @effects \`none\` */
function install() { actions.run = writer; }
`,
    });
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'exceeds')).toBe(true);
  });

  it('does not narrow a broad slot because its initial function is empty', () => {
    const analysis = checkSource({
      source: `\
const actions = { /** @effects \`localstorage.write(*)\` */ run: () => {} };
/** @effects \`none\` */
function execute() { actions.run(); }
`,
    });
    expect(analysis.diagnostics.some(diagnostic => diagnostic.message.includes('localstorage.write(*) exceeds'))).toBe(true);
  });

  it('rejects widening a shared writable view, even though TypeScript accepts it', () => {
    const analysis = checkSource({
      source: `\
interface Empty { /** @effects \`none\` */ run: () => void; }
interface Writable { /** @effects \`localstorage.write(*)\` */ run: () => void; }
const original: Empty = { /** @effects \`none\` */ run: () => {} };
const alias: Writable = original;
`,
    });
    expect(analysis.diagnostics.filter(diagnostic => diagnostic.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'exceeds')).toBe(true);
  });

  it('specializes a named callback and does not contaminate another caller', () => {
    const analysis = checkSource({
      source: `\
/** @effects \`call(arg0.operation)\` */
function invoke({ operation }: { operation: () => void }) { operation(); }
/** @effects \`localstorage.write(*)\` */
function writer() { localStorage.clear(); }
/** @effects \`none\` */
function empty() {}
/** @effects \`localstorage.write(*)\` */
function save() { invoke({ operation: writer }); }
/** @effects \`none\` */
function inspect() { invoke({ operation: empty }); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('uses all possible destinations for a finite-key assignment', () => {
    const analysis = checkSource({
      source: `\
const actions = {
  /** @effects \`none\` */ inspect: () => {},
  /** @effects \`localstorage.write(*)\` */ save: () => {},
};
/** @effects \`localstorage.write(*)\` */
function writer() { localStorage.clear(); }
/** @effects \`none\` */
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
 * // @effects \`network.http(*)\`
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
      expect(output).toContain('// @effects `network.http(*)`');
      expect(output).toContain('/** @effects `localstorage.write(*)` */');
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('reads multiline dedicated declarations', () => {
    const analysis = checkSource({
      source: `\
/** @effects
 * \`localstorage.read(*)\`,
 * \`localstorage.write(*)\`
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
const memory = { /** @effects \`none\` */ write: () => {} };
/** @effects \`none\` */
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
