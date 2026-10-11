import { describe, expect, it } from 'vitest';
import { printEffect } from '../contracts/effects.ts';
import { createFixture } from '../test-support/project-fixture.ts';

describe('callable signature shape discovery', () => {
  it('does not expand an unused method argument tree or lose a sibling method effect', () => {
    const wide = Array.from({ length: 13 }, (_, index) => `interface Wide${index} { left: ${index === 0 ? 'string' : `Wide${index - 1}`}; right: ${index === 0 ? 'string' : `Wide${index - 1}`}; }`).join('\n');
    using fixture = createFixture({
      files: {
        'node_modules/foreign/package.json': JSON.stringify({ name: 'foreign', types: 'index.d.ts' }),
        'node_modules/foreign/index.d.ts': `${wide}
export interface Api {
  unused({ context }: { context: Wide12 }): void;
  /** @effects ["localstorage.write(*)"] */ run(): void;
}
`,
        'main.ts': `\
import type { Api } from 'foreign';
/** @effects [] */ function api(): Api { throw new Error('unused factory'); }
/** @effects ["localstorage.write(*)"] */ function entry() { api().run(); }
`,
      },
      entries: ['main.ts'],
    });
    fixture.config.analysisBudget = 2_000;
    const analysis = fixture.check();
    const entry = analysis.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect((analysis.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(analysis.diagnostics.some(item => item.message.includes('analysis budget'))).toBe(false);
    expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  });

  it.each([
    { deepFirst: true, bound: '' },
    { deepFirst: false, bound: '' },
    { deepFirst: true, bound: '/** @effects ["call(arg0.run)"] */' },
    { deepFirst: false, bound: '/** @effects ["call(arg0.run)"] */' },
  ])('preserves an external typed callback slot (deepFirst=$deepFirst, bound=$bound)', ({ deepFirst, bound }) => {
    const deep = Array.from({ length: 24 }, (_, index) => `export interface Deep${index} { ${index === 0 ? 'fn: Fn' : `next: Deep${index - 1}`} }`).join('\n');
    const discovery = '/** @effects [] */ function discover(): Deep23 { throw new Error("unused factory"); }';
    const slot = '/** @effects ["call(arg0.run)"] */ const invoke: Fn = ({ run }) => run();';
    using fixture = createFixture({
      files: {
        'node_modules/foreign/package.json': JSON.stringify({ name: 'foreign', types: 'index.d.ts' }),
        'node_modules/foreign/index.d.ts': `${bound} export type Fn = ({ run }: { run: () => void }) => void;
${deep}
`,
        'main.ts': `\
import type { Fn, Deep23 } from 'foreign';
${deepFirst ? discovery + '\n' + slot : slot + '\n' + discovery}
/** @effects ["localstorage.write(*)"] */ function writer() { localStorage.clear(); }
/** @effects ["localstorage.write(*)"] */ function entry() { invoke({ run: writer }); }
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    const entry = analysis.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect((analysis.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(analysis.diagnostics.filter(item => item.code === 'syntax' || item.code === 'typescript')).toEqual([]);
  });

  it('validates an explicit callback reference even when the signature is not invoked', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["call(arg0.absent)"] */ type Callback = () => void;
/** @effects [] */ function expose(): Callback { throw new Error('unused factory'); }
`,
      },
      entries: ['main.ts'],
    });
    expect(fixture.check().diagnostics.some(item => item.code === 'syntax' && item.message === 'Unbound effect reference: call(arg0.absent).')).toBe(true);
  });
});
