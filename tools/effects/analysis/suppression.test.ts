import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';
import { planEffectFix } from '../fixes/plan.ts';

type Analysis = ReturnType<ReturnType<typeof createFixture>['check']>;
const unsafeWrite = '/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Reviewed local probe."} */';
const none = '/** @effects [] */';
const writes = '/** @effects ["localstorage.write(*)"] */';

function row({ analysis, label }: { analysis: Analysis, label: string }) {
  const owner = analysis.owners.find(item => item.label === label && item.role !== 'body');
  expect(owner).toBeDefined();
  return (analysis.solution.rows.get(owner!.id) ?? []).map(effect => printEffect({ effect }));
}

function fixtureFor({ source }: { source: string }) {
  return createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
}

describe('unsafe effect suppression is a checked implementation boundary', () => {
  it('hides the selected operation from callers but records the body and reason', () => {
    const fixture = fixtureFor({
      source: `\
${none} ${unsafeWrite}
function probe() { localStorage.clear(); }
${none} function caller() { probe(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'probe' })).toEqual([]);
      expect(row({ analysis, label: 'caller' })).toEqual([]);
      const audit = analysis.unsafeSuppressions[0]!;
      expect(audit.label).toBe('probe');
      expect(audit.reason).toBe('Reviewed local probe.');
      expect(audit.body.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
      expect(audit.suppressed.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
      expect(audit.outward).toEqual([]);
      expect(analysis.assumptions.some(value => value.includes('UNSAFE effect suppression'))).toBe(true);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('propagates unsuppressed operations and fixes public rows without editing the exception', () => {
    const fixture = fixtureFor({
      source: `\
${none} ${unsafeWrite}
export function probe() { localStorage.clear(); fetch('/probe'); }
${none} function caller() { probe(); }
`,
    });
    try {
      const before = fixture.check();
      expect(before.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
      expect(row({ analysis: before, label: 'caller' })).toEqual(['network.http(*)']);
      const fixed = fixture.fix();
      expect(fixed.analysis.diagnostics).toEqual([]);
      expect(fixed.changedFiles).toHaveLength(1);
      const after = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(after).toContain(unsafeWrite);
      expect(after.match(/@effects \["network.http\(\*\)"\]/g)).toHaveLength(2);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps callee violations visible under a caller exception', () => {
    const fixture = createFixture({
      files: {
        'storage.ts': `${none} export function write() { localStorage.clear(); }`,
        'main.ts': `import { write } from './storage';\n${none} ${unsafeWrite} function probe() { write(); }`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'exceeds').map(item => path.basename(item.file))).toEqual(['storage.ts']);
      expect(row({ analysis, label: 'probe' })).toEqual([]);
      fixture.fix();
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not make a read-only exception suppress writes', () => {
    const source = `\
${none}
/** @effectsUNSAFE {"effects":["localstorage.read(*)"],"reason":"Read probe only."} */
function probe() { localStorage.getItem('x'); localStorage.clear(); }
${none} function caller() { probe(); }
`;
    const fixture = fixtureFor({ source });
    try {
      const analysis = fixture.check();
      expect(row({ analysis, label: 'caller' })).toEqual(['localstorage.write(*)']);
      expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
      fixture.fix();
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps function-declaration reassignment violations despite an exception', () => {
    const fixture = fixtureFor({
      source: `\
${none} ${unsafeWrite} function probe() { localStorage.clear(); }
${writes} function replacement() { localStorage.clear(); }
${none} function install() { probe = replacement; }
${none} function caller() { probe(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(row({ analysis, label: 'install' })).toEqual([]);
      expect(row({ analysis, label: 'caller' })).toEqual(['localstorage.write(*)']);
      expect(analysis.diagnostics.filter(item => item.code === 'exceeds')).toHaveLength(2);
      // TypeScript rejects rebinding this declaration; the exception cannot hide that.
      expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(true);
      expect(() => fixture.fix()).toThrow('refused');
    } finally {
      fixture.dispose();
    }
  });

  it.each(['const', 'let'])('keeps %s arrow implementation suppression separate from alias/assignment contracts', kind => {
    const source = `\
${none} ${unsafeWrite} ${kind} probe = () => { localStorage.clear(); };
${none} const alias = probe;
${none} function caller() { alias(); }
`;
    const fixture = fixtureFor({ source });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'caller' })).toEqual([]);
      expect(analysis.unsafeSuppressions).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it('cannot use an initial property implementation to suppress future slot assignments', () => {
    const fixture = fixtureFor({
      source: `\
const actions = { ${none} ${unsafeWrite} run: () => { localStorage.clear(); } };
${writes} function replacement() { localStorage.clear(); }
${none} function install() { actions.run = replacement; }
${none} function caller() { actions.run(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
      expect(row({ analysis, label: 'install' })).toEqual([]);
      expect(row({ analysis, label: 'caller' })).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it('never applies a factory exception to a returned callback', () => {
    const fixture = fixtureFor({
      source: `\
${none} ${unsafeWrite} function factory() {
  localStorage.clear();
  return ${writes} () => { localStorage.clear(); };
}
${writes} function caller() { const callback = factory(); callback(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'factory' })).toEqual([]);
      expect(row({ analysis, label: 'caller' })).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it('does not exempt an uncalled nested function from checking its own body', () => {
    const fixture = fixtureFor({
      source: `\
${none} ${unsafeWrite} function outer() {
  localStorage.clear();
  ${none} function unused() { localStorage.clear(); }
}
`,
    });
    try {
      const analysis = fixture.check();
      expect(row({ analysis, label: 'outer' })).toEqual([]);
      expect(analysis.diagnostics.filter(item => item.code === 'exceeds')).toHaveLength(1);
      expect(analysis.diagnostics[0]?.message).toContain('unused');
    } finally {
      fixture.dispose();
    }
  });

  it('supports a concrete callback call without exempting the callback declaration', () => {
    const fixture = fixtureFor({
      source: `\
/** @effects ["call(arg0.operation)"] */
function invoke({ operation }: { operation: () => void }) { operation(); }
${writes} function write() { localStorage.clear(); }
${none} ${unsafeWrite} function probe() { invoke({ operation: write }); }
${none} function caller() { probe(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'caller' })).toEqual([]);
      expect(row({ analysis, label: 'write' })).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it('refuses an unrepresentable residual effect row instead of hiding symbolic callbacks', () => {
    const fixture = fixtureFor({
      source: `\
/** @effects ["call(arg0.operation)"] */ ${unsafeWrite}
function probe({ operation }: { operation: () => void }) { localStorage.clear(); operation(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.message.includes('residual callback rows'))).toBe(true);
      expect(() => fixture.fix()).toThrow('refused');
    } finally {
      fixture.dispose();
    }
  });

  it('terminates recursion without losing an independent caller effect', () => {
    const fixture = fixtureFor({
      source: `\
${none} ${unsafeWrite} function probe() { localStorage.clear(); again(); }
${none} function again() { probe(); }
${writes} function other() { again(); localStorage.clear(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'again' })).toEqual([]);
      expect(row({ analysis, label: 'other' })).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it('includes default-argument and finally work in the implementation boundary', () => {
    const fixture = fixtureFor({
      source: `\
${writes} function initial() { localStorage.clear(); return 1; }
${none} ${unsafeWrite}
function probe(value = initial()) { try { return value; } finally { localStorage.clear(); } }
${none} function caller() { probe(); }
`,
    });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps mutable let-slot reassignment outside the implementation exception', () => {
    const source = `\
${none} ${unsafeWrite} let probe = () => { localStorage.clear(); };
${writes} function replacement() { localStorage.clear(); }
${none} function install() { probe = replacement; }
${none} function caller() { probe(); }
`;
    const fixture = fixtureFor({ source });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
      expect(row({ analysis, label: 'caller' })).toEqual(['localstorage.write(*)']);
      expect(row({ analysis, label: 'install' })).toEqual([]);
      expect(() => fixture.fix()).toThrow('disjoint');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('includes destructured default expressions in the body before filtering', () => {
    const source = `\
${none}
/** @effectsUNSAFE {"effects":["localstorage.read(*)"],"reason":"Default capability lookup."} */
function probe({ value = localStorage.getItem('x') }: { value?: string | null }) { return value; }
${none} function caller() { probe({}); }
`;
    const fixture = fixtureFor({ source });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.unsafeSuppressions[0]?.suppressed.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it('checks a default callback against its declared parameter contract', () => {
    const source = `\
${writes} function write() { localStorage.clear(); }
interface Options { /** @effects [] */ callback: () => void; }
${none} function invoke({ callback = write }: Options) { if (callback) callback(); }
`;
    const fixture = fixtureFor({ source });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
      expect(analysis.diagnostics.some(item => item.code === 'exceeds')).toBe(true);
      expect(row({ analysis, label: 'invoke' })).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    `${unsafeWrite} const value = 3;`,
    `${unsafeWrite} interface Actions { run(): void; }`,
    `interface Actions { ${none} ${unsafeWrite} run(): void; }`,
    `${unsafeWrite} type Run = () => void;`,
    `${writes} function write() { localStorage.clear(); } ${none} ${unsafeWrite} const alias = write;`,
    `${none} function caller() { ${unsafeWrite} localStorage.clear(); }`,
    `${none} function f() {}\n${unsafeWrite}`,
  ])('rejects an exception without an owning implementation: %s', source => {
    const fixture = fixtureFor({ source });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'boundary')).toBe(true);
      expect(() => fixture.fix()).toThrow();
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    `${none} ${unsafeWrite} function f() {}`,
    `${writes} ${unsafeWrite} function f() { localStorage.clear(); }`,
    `${none} /** @effectsUNSAFE {"effects":["localstorage.write(\\"x\\")"],"reason":"Not a wildcard."} */ function f() { localStorage.clear(); }`,
  ])('rejects unused, contradictory or insufficiently precise exceptions: %s', source => {
    const fixture = fixtureFor({ source });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'boundary')).toBe(true);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('does not suppress unknown calls or ordinary type errors', () => {
    const fixture = fixtureFor({
      source: `\
${none} ${unsafeWrite} function f({ callback }: { callback: unknown }) { localStorage.clear(); callback(); }
`,
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(true);
      expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
      expect(() => planEffectFix({ analysis })).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('generates a missing public row but never generates or rewrites an exception', () => {
    const fixture = fixtureFor({ source: `${unsafeWrite}\nfunction f() { localStorage.clear(); }` });
    try {
      expect(fixture.check().diagnostics.map(item => item.code)).toEqual(['missing']);
      fixture.fix();
      const result = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(result).toContain(unsafeWrite);
      expect(result).toContain(none);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not inspect or modify ordinary test file exceptions', () => {
    const source = '/** @effectsUNSAFE malformed fixture */ function test() { localStorage.clear(); }';
    const fixture = createFixture({ files: { 'example.test.ts': source }, entries: ['example.test.ts'] });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'example.test.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });
});
