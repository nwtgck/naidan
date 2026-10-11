import { describe, expect, it } from 'vitest';
import type { EffectsAnalysis } from './analyze.ts';
import { printEffect } from '../contracts/effects.ts';
import { createFixture } from '../test-support/project-fixture.ts';

function row({ analysis, label }: { analysis: EffectsAnalysis, label: string }): readonly string[] {
  const owner = analysis.owners.find(item => item.role === 'implementation' && item.label === label)!;
  return (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
}

describe('finite property keys', () => {
  it('keeps a choice of literal scalar fields safe for template conversion', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */ function entry({ key }: { key: 'left' | 'right' }) {
  const labels = { left: 'Left', right: 'Right' };
  return \`Selected: \${labels[key]}\`;
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    expect(analysis.diagnostics).toEqual([]);
    expect(row({ analysis, label: 'entry' })).toEqual([]);
  });

  it('retains communication performed while evaluating a finite key', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["localstorage.write(*)"] */ function selectKey(): 'left' | 'right' { localStorage.clear(); return 'left'; }
/** @effects ["localstorage.write(*)"] */ function entry() {
  const labels = { left: 'Left', right: 'Right' };
  return \`Selected: \${labels[selectKey()]}\`;
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    expect(analysis.diagnostics).toEqual([]);
    expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)']);
  });

  it('does not treat a possible object conversion hook as a scalar alternative', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["localstorage.write(*)"] */ function convert() { localStorage.clear(); return 'Right'; }
/** @effects [] */ function entry({ key }: { key: 'left' | 'right' }) {
  const values = { left: 'Left', right: { toString: convert } };
  return \`Selected: \${values[key]}\`;
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message === 'Template conversion may execute user-defined hooks.')).toBe(true);
  });

  it('retains both callable alternatives and their communication', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["localstorage.write(*)"] */ function local() { localStorage.clear(); }
/** @effects ["sessionstorage.write(*)"] */ function session() { sessionStorage.clear(); }
/** @effects ["localstorage.write(*)","sessionstorage.write(*)"] */ function entry({ key }: { key: 'left' | 'right' }) {
  const operations = { left: local, right: session };
  operations[key]();
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    expect(analysis.diagnostics).toEqual([]);
    expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)', 'sessionstorage.write(*)']);
  });
});
