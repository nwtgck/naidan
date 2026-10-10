import { describe, expect, it } from 'vitest';
import type { EffectsAnalysis } from './analyze.ts';
import { printEffect } from '../contracts/effects.ts';
import { createFixture } from '../test-support/project-fixture.ts';

function row({ analysis, label }: { analysis: EffectsAnalysis, label: string }): readonly string[] {
  const owner = analysis.owners.find(item => item.role === 'implementation' && item.label === label)!;
  return (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
}

describe('symbolic callback owners', () => {
  it.each([false, true])('keeps a shared interface local to each caller with reversed order %s', reverse => {
    const functions = [
      '/** @effects ["call(arg0.left.run)"] */ function first({ left }: { left: Operations }) { left.run(); }',
      '/** @effects ["call(arg0.right.run)"] */ function second({ right }: { right: Operations }) { right.run(); }',
    ];
    const fixture = createFixture({
      files: { 'main.ts': 'interface Operations { run(): void; }\n' + (reverse ? functions.reverse() : functions).join('\n') },
      entries: ['main.ts'],
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const analysis = fixture.check();
        expect(analysis.diagnostics).toEqual([]);
        expect(row({ analysis, label: 'first' })).toEqual(['call(arg0.left.run)']);
        expect(row({ analysis, label: 'second' })).toEqual(['call(arg0.right.run)']);
      }
    } finally {
      fixture.dispose();
    }
  });

  it('keeps two paths through the same interface distinct within one caller', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
interface Operations { run(): void; }
/** @effects ["call(arg0.left.run)","call(arg0.right.run)"] */
function both({ left, right }: { left: Operations; right: Operations }) { left.run(); right.run(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'both' })).toEqual(['call(arg0.left.run)', 'call(arg0.right.run)']);
    } finally {
      fixture.dispose();
    }
  });

  it('does not turn a concrete method signature into a caller parameter', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
interface Operations { run(): void; }
/** @effects ["call(arg0.ops.run)"] */
function invoke({ ops }: { ops: Operations }) { ops.run(); }
/** @effects [] */
function empty() { const ops: Operations = { run: () => {} }; invoke({ ops }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.map(item => [item.code, item.message])).toEqual([
        ['missing', 'Missing @effects contract for run.'],
      ]);
      expect(row({ analysis, label: 'invoke' })).toEqual(['call(arg0.ops.run)']);
      expect(row({ analysis, label: 'empty' })).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('substitutes each shared-interface callback without leaking another caller path', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
interface Operations { run(): void; }
/** @effects ["call(arg0.left.run)"] */
function first({ left }: { left: Operations }) { left.run(); }
/** @effects ["call(arg0.right.run)"] */
function second({ right }: { right: Operations }) { right.run(); }
/** @effects ["localstorage.write(*)"] */
function localEntry() { first({ left: { /** @effects ["localstorage.write(*)"] */ run: () => localStorage.clear() } }); }
/** @effects ["sessionstorage.write(*)"] */
function sessionEntry() { second({ right: { /** @effects ["sessionstorage.write(*)"] */ run: () => sessionStorage.clear() } }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'localEntry' })).toEqual(['localstorage.write(*)']);
      expect(row({ analysis, label: 'sessionEntry' })).toEqual(['sessionstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it('retains a fixed explicit interface contract across callers', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
interface Operations { /** @effects ["hoge"] */ run(): void; }
/** @effects ["hoge"] */
function first({ left }: { left: Operations }) { left.run(); }
/** @effects ["hoge"] */
function second({ right }: { right: Operations }) { right.run(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'first' })).toEqual(['hoge']);
      expect(row({ analysis, label: 'second' })).toEqual(['hoge']);
    } finally {
      fixture.dispose();
    }
  });

  it('binds an optional callback without merging its path into the callee', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["call(arg0.operation)"] */
function runCleanupStep({ operation }: { operation: () => void }) { operation(); }
/** @effects ["call(arg0.beforeRelease)"] */
function dispose({ beforeRelease }: { beforeRelease: (() => void) | undefined }) {
  if (beforeRelease !== undefined) runCleanupStep({ operation: beforeRelease });
}
/** @effects ["localstorage.write(*)"] */
function entry() { dispose({ /** @effects ["localstorage.write(*)"] */ beforeRelease: () => localStorage.clear() }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'runCleanupStep' })).toEqual(['call(arg0.operation)']);
      expect(row({ analysis, label: 'dispose' })).toEqual(['call(arg0.beforeRelease)']);
      expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it.each(['argument', 'parameter'])('keeps multiple callable %s alternatives unsupported', boundary => {
    const single = '(input: string) => void';
    const multiple = '((input: string) => void) | ((input: string, other?: number) => void)';
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["call(arg0.operation)"] */
function run({ operation }: { operation: ${boundary === 'parameter' ? multiple : single} }) { operation('x'); }
/** @effects ["call(arg0.operation)"] */
function forward({ operation }: { operation: ${boundary === 'argument' ? multiple : single} }) {
  run({ operation });
}
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message === `Ambiguous callback ${boundary} alternatives require an explicit contract.`)).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('substitutes a known absent optional callback without leaking its lexical path', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["call(arg0.operation)"] */
function run({ operation }: { operation: () => void }) { operation(); }
/** @effects ["call(arg0.beforeRelease)"] */
function dispose({ beforeRelease }: { beforeRelease: (() => void) | undefined }) {
  if (beforeRelease !== undefined) run({ operation: beforeRelease });
}
/** @effects [] */
function entry() { dispose({ beforeRelease: undefined }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'dispose' })).toEqual(['call(arg0.beforeRelease)']);
      expect(row({ analysis, label: 'entry' })).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });
});
