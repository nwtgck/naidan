import { describe, expect, it } from 'vitest';
import { printEffect } from '../contracts/effects.ts';
import { createFixture } from '../test-support/project-fixture.ts';

describe('mapped callable parameter records', () => {
  it.each([
    { type: "Pick<Storage, 'getItem'>", method: 'getItem', body: "return storage.getItem('key');", callback: 'call(arg0.storage.getItem)' },
    { type: "Readonly<Pick<Storage, 'setItem'>>", method: 'setItem', body: "storage.setItem('key', 'value');", callback: 'call(arg0.storage.setItem)' },
  ])('preserves the symbolic method slot of $type', item => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["${item.callback}"] */
function access({ storage }: { storage: ${item.type} }) { ${item.body} }
/** @effects ["sessionstorage.write(*)"] */
function entry() {
  access({ storage: { /** @effects ["sessionstorage.write(*)"] */ ${item.method}() { sessionStorage.clear(); return 'value'; } } });
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    const access = analysis.owners.find(owner => owner.label === 'access' && owner.role === 'implementation')!;
    const entry = analysis.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect([...access.callbackPaths]).toEqual([item.callback]);
    expect((analysis.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['sessionstorage.write(*)']);
    expect(analysis.diagnostics).toEqual([]);
  });

  it('does not certify a getter hidden by a mapped method type', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["call(arg0.storage.getItem)"] */
function access({ storage }: { storage: Pick<Storage, 'getItem'> }) { return storage.getItem('key'); }
/** @effects [] */
function entry() {
  access({ storage: { get getItem() { sessionStorage.clear(); return () => 'value'; } } });
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    expect(analysis.diagnostics.some(item => item.message.includes('accessors') || item.message.includes('Accessors'))).toBe(true);
    expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  });

  it.each(["Pick<Getter, 'getItem'>", "Readonly<Pick<Getter, 'getItem'>>"])(
    'retains accessor diagnostics through %s', type => {
      using fixture = createFixture({
        files: {
          'main.ts': `\
interface Getter { get getItem(): (key: string) => string; }
/** @effects [] */
function access({ storage }: { storage: ${type} }) { return storage.getItem('key'); }
`,
        },
        entries: ['main.ts'],
      });
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.message === 'Accessors need an explicit effect model; they are not passive data properties.')).toBe(true);
      expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    },
  );
});
