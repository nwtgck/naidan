import { describe, expect, it } from 'vitest';
import { createFixture } from './test-support/project-fixture.ts';
import { reviewEffects } from './review.ts';

function review({ source, label, budget }: { source: string, label: string, budget: number }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const result = reviewEffects({ analysis, budget });
    expect(reviewEffects({ analysis, budget })).toEqual(result);
    return result.find(entry => entry.label === label)!;
  } finally {
    fixture.dispose();
  }
}

describe('effect contract review is explanatory, not an automatic unexpected-effect policy', () => {
  it('explains a direct browser operation even if its comment already includes the effect', () => {
    const result = review({ source: '/** @effects ["indexeddb.read(*)"] */ function inspect() { indexedDB.databases(); }', label: 'inspect', budget: 100 });
    expect(result.missing).toEqual([]);
    expect(result.witnesses[0]?.basis).toBe('modeled-operation');
    expect(result.witnesses[0]?.path.at(-1)?.reason).toContain('Modeled operation: indexedDB.databases');
  });

  it('distinguishes a deliberately broad contract from an executed operation', () => {
    const result = review({ source: '/** @effects ["localstorage.write(*)","hoge"] */ function noop() {}', label: 'noop', budget: 100 });
    expect(result.outward).toEqual(['hoge', 'localstorage.write(*)']);
    expect(result.witnesses.every(item => item.basis === 'declared-upper-bound')).toBe(true);
  });

  it('keeps a dependency witness after the whole chain has been fixed', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
function save() { localStorage.clear(); }
function middle() { save(); }
function entry() { middle(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const before = fixture.check();
      const beforeResult = reviewEffects({ analysis: before, budget: 100 }).find(entry => entry.label === 'entry')!;
      expect(beforeResult.missing).toEqual(['localstorage.write(*)']);
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      const afterResult = reviewEffects({ analysis: result.analysis, budget: 100 }).find(entry => entry.label === 'entry')!;
      expect(afterResult.missing).toEqual([]);
      expect(afterResult.witnesses[0]?.basis).toBe('modeled-operation');
      expect(afterResult.witnesses[0]?.path.map(step => step.label)).toEqual(['entry', 'middle', 'save']);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not trace a suppressed operation back into a caller', () => {
    const result = review({
      source: `\
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Isolated test-only probe boundary."} */
function hidden() { localStorage.clear(); }
/** @effects [] */
function caller() { hidden(); }
`,
      label: 'caller',
      budget: 100,
    });
    expect(result.outward).toEqual([]);
    expect(result.witnesses).toEqual([]);
  });

  it('uses a separate unsuppressed path for an operation also hidden on another path', () => {
    const result = review({
      source: `\
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Isolated probe."} */
function hidden() { localStorage.clear(); }
function ordinary() { localStorage.setItem('x', 'y'); }
function caller() { hidden(); ordinary(); }
`,
      label: 'caller',
      budget: 100,
    });
    expect(result.witnesses[0]?.path.map(step => step.label)).toEqual(['caller', 'ordinary']);
  });

  it('explains a callback substitution using that call site, not another invocation', () => {
    const source = `\
/** @effects ["call(arg0.operation)"] */
function invoke({ operation }: { operation: () => void }) { operation(); }
/** @effects ["localstorage.read(*)"] */
function reader() { localStorage.getItem('x'); }
/** @effects ["localstorage.write(*)"] */
function writer() { localStorage.clear(); }
function readOnly() { invoke({ operation: reader }); }
function writeOnly() { invoke({ operation: writer }); }
`;
    const result = review({ source, label: 'readOnly', budget: 100 });
    expect(result.outward).toEqual(['localstorage.read(*)']);
    expect(result.witnesses[0]?.basis).toBe('modeled-operation');
    expect(result.witnesses[0]?.path.map(step => step.label)).toEqual(['readOnly', 'reader']);
    expect(result.witnesses[0]?.path[0]?.reason).toContain('substitute call(arg0.operation)');
  });

  it('retains unresolved callback contracts as symbolic witnesses', () => {
    const result = review({ source: '/** @effects ["call(arg0)"] */ function invoke(callback: () => void) { callback(); }', label: 'invoke', budget: 100 });
    expect(result.outward).toEqual(['call(arg0)']);
    expect(result.witnesses[0]?.basis).toBe('declared-upper-bound');
  });

  it('terminates for cyclic calls and still finds a concrete operation', () => {
    const result = review({
      source: `\
function a() { b(); }
function b() { c(); }
function c() { a(); localStorage.clear(); }
`,
      label: 'a',
      budget: 100,
    });
    expect(result.witnesses[0]?.basis).toBe('modeled-operation');
    expect(result.witnesses[0]?.path.map(step => step.label)).toEqual(['a', 'b', 'c']);
  });

  it('marks a bounded search as truncated rather than certifying an empty effect', () => {
    const result = review({ source: 'function a() { b(); } function b() { localStorage.clear(); }', label: 'a', budget: 1 });
    expect(result.outward).toEqual(['localstorage.write(*)']);
    expect(result.witnesses[0]?.basis).toBe('truncated');
  });

  it('validates the review budget without changing the analysis', () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects [] */ function a() {}' }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      for (const budget of [0, -1, 0.5, NaN, Infinity]) expect(() => reviewEffects({ analysis, budget })).toThrow('budget');
      expect(analysis.diagnostics).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });
});

describe('effect review guards', () => {
  it('does not shrink an already broad declaration just because a native model became more precise', () => {
    const source = '/** @effects ["indexeddb.read(*)","indexeddb.write(*)"] */ function compare() { indexedDB.cmp(1, 2); }';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      expect(result.changedFiles).toEqual([]);
      const entry = reviewEffects({ analysis: result.analysis, budget: 100 }).find(item => item.label === 'compare')!;
      expect(entry.outward).toEqual(['indexeddb.read(*)', 'indexeddb.write(*)']);
      expect(entry.witnesses.every(item => item.basis === 'declared-upper-bound')).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('retains ordinary call propagation through a named arrow and a function-valued property', () => {
    const entry = review({
      source: `\
const writer = () => { localStorage.clear(); };
const actions = { run: writer };
function invoke() { actions.run(); }
`,
      label: 'invoke',
      budget: 100,
    });
    expect(entry.witnesses[0]?.path.at(-1)?.label).toBe('writer');
    expect(entry.witnesses[0]?.basis).toBe('modeled-operation');
  });
});
