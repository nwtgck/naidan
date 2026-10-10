import { describe, expect, it } from 'vitest';
import type { EffectsAnalysis } from './analyze.ts';
import { printEffect } from '../contracts/effects.ts';
import { createFixture } from '../test-support/project-fixture.ts';

const cleanup = `\
/** @effects ["call(arg0.operation)"] */
function runCleanupStep({ operation }: { operation: () => void }) { operation(); }
/** @effects ["call(arg0.beforeRelease)"] */
function dispose({ beforeRelease }: { beforeRelease: (() => void) | undefined }) {
  if (beforeRelease !== undefined) runCleanupStep({ operation: beforeRelease });
}
`;

function row({ analysis, label }: { analysis: EffectsAnalysis, label: string }): readonly string[] {
  const owner = analysis.owners.find(item => item.role === 'implementation' && item.label === label)!;
  return (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
}

function emptyOwners({ analysis }: { analysis: EffectsAnalysis }): number {
  return analysis.owners.filter(owner => owner.label === '<absent callback>').length;
}

describe('known absent callback arguments', () => {
  it('substitutes undefined like a checked empty callback without erasing the callee slot', () => {
    const fixture = createFixture({
      files: {
        'main.ts': cleanup + `\
/** @effects [] */ function noop() {}
/** @effects [] */ function absent() { dispose({ beforeRelease: undefined }); }
/** @effects [] */ function explicit() { dispose({ beforeRelease: noop }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const analysis = fixture.check();
        expect(analysis.diagnostics).toEqual([]);
        expect(row({ analysis, label: 'dispose' })).toEqual(['call(arg0.beforeRelease)']);
        expect(row({ analysis, label: 'absent' })).toEqual([]);
        expect(row({ analysis, label: 'explicit' })).toEqual([]);
        expect(emptyOwners({ analysis })).toBe(1);
        expect(analysis.coverage.functions).toBe(5);
      }
    } finally {
      fixture.dispose();
    }
  });

  it('preserves direct const and conditional evidence and keeps a writer separate', () => {
    const fixture = createFixture({
      files: {
        'main.ts': cleanup + `\
/** @effects ["localstorage.write(*)"] */ function writer() { localStorage.clear(); }
/** @effects [] */ function absent({ flag }: { flag: boolean }) {
  const missing: undefined = undefined;
  dispose({ beforeRelease: missing });
  dispose({ beforeRelease: flag ? undefined : void 0 });
}
/** @effects ["localstorage.write(*)"] */ function present() { dispose({ beforeRelease: writer }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'absent' })).toEqual([]);
      expect(row({ analysis, label: 'present' })).toEqual(['localstorage.write(*)']);
      expect(emptyOwners({ analysis })).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it('substitutes omitted optional record callbacks without leaving their lexical path in a caller', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
interface Contact { confirm(): void; }
/** @effects ["call(arg0.contact.confirm)"] */
function confirmContact({ contact }: { contact: Contact }) { contact.confirm(); }
/** @effects ["call(arg0.contact.confirm)","call(arg0.verifyPeer)"] */
function establish({ contact, verifyPeer }: { contact?: Contact; verifyPeer: (() => void) | undefined }) {
  if (contact !== undefined) confirmContact({ contact });
  if (verifyPeer !== undefined) runCleanupStep({ operation: verifyPeer });
}
/** @effects ["call(arg0.operation)"] */
function runCleanupStep({ operation }: { operation: () => void }) { operation(); }
/** @effects [] */ function entry() { establish({ verifyPeer: undefined }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'establish' })).toEqual(['call(arg0.contact.confirm)', 'call(arg0.verifyPeer)']);
      expect(row({ analysis, label: 'entry' })).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('evaluates a void operand before using its undefined result', () => {
    const fixture = createFixture({
      files: {
        'main.ts': cleanup + `\
/** @effects ["localstorage.write(*)"] */ function writer() { localStorage.clear(); }
/** @effects ["localstorage.write(*)"] */ function entry() { dispose({ beforeRelease: void writer() }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'let value: undefined = 12 as unknown as undefined;',
    'let value = undefined; value = 12 as unknown as undefined;',
    'let value = undefined; if (flag) value = 12 as unknown as undefined;',
    'let value = undefined; value = 12 as unknown as undefined; const combined = value || undefined;',
    'const args = { beforeRelease: undefined }; args.beforeRelease = 12 as unknown as undefined;',
    'const args = { beforeRelease: undefined }; const alias = args; alias.beforeRelease = 12 as unknown as undefined;',
  ])('forgets absence in mutable storage: %s', setup => {
    const actual = setup.includes('const args') ? 'args' : setup.includes('const combined') ? '{ beforeRelease: combined }' : '{ beforeRelease: value }';
    const fixture = createFixture({
      files: {
        'main.ts': cleanup + `\
/** @effects [] */ function entry({ flag }: { flag: boolean }) { ${setup} dispose(${actual}); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
      expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
      expect(row({ analysis, label: 'entry' })).toContain('call(arg0.beforeRelease)');
      expect(emptyOwners({ analysis })).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    '12 as unknown as undefined',
    'value as undefined',
    'typedReturn()',
    'voidReturn() as undefined',
  ])('does not turn a scalar or return-type claim into absence: %s', actual => {
    const fixture = createFixture({
      files: {
        'main.ts': cleanup + `\
/** @effects [] */ function typedReturn(): undefined { return 12 as unknown as undefined; }
/** @effects [] */ function voidReturn(): void {}
/** @effects [] */ function entry({ value }: { value: unknown }) { dispose({ beforeRelease: ${actual} }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
      expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
      expect(row({ analysis, label: 'entry' })).toContain('call(arg0.beforeRelease)');
      expect(emptyOwners({ analysis })).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps a writer reachable through a mutable value instead of narrowing with its initial falsiness', () => {
    const fixture = createFixture({
      files: {
        'main.ts': cleanup + `\
/** @effects ["localstorage.write(*)"] */ function writer() { localStorage.clear(); }
/** @effects [] */ function entry() {
  let value = undefined;
  value = 12 as unknown as undefined;
  dispose({ beforeRelease: (value && writer) || undefined });
}
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
      expect(analysis.diagnostics.some(item => item.code === 'exceeds')).toBe(true);
      expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)']);
      expect(emptyOwners({ analysis })).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps a shadowing callback named undefined and a cast writer executable', () => {
    const fixture = createFixture({
      files: {
        'main.ts': cleanup + `\
/** @effects ["localstorage.write(*)"] */ function writer() { localStorage.clear(); }
/** @effects ["call(arg0.undefined)"] */ function shadow({ undefined }: { undefined: () => void }) {
  dispose({ beforeRelease: undefined });
}
/** @effects ["localstorage.write(*)"] */ function entry() { dispose({ beforeRelease: writer as unknown as undefined }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(row({ analysis, label: 'shadow' })).toEqual(['call(arg0.undefined)']);
      expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)']);
      expect(emptyOwners({ analysis })).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it('does not choose one of multiple optional callable contracts', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["call(arg0.callback)"] */
function use({ callback }: { callback: ((value: string) => void) | ((value: string, extra?: number) => void) | undefined }) {
  if (callback !== undefined) callback('x');
}
/** @effects [] */ function entry() { use({ callback: undefined }); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
      expect(emptyOwners({ analysis })).toBe(0);
    } finally {
      fixture.dispose();
    }
  });
});
