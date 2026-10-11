import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';

describe('ordinary for statement effects', () => {
  it.each([
    'for (;;) { localStorage.clear(); break; }',
    'for (let index = 0; index < 1; index++) { localStorage.clear(); }',
  ])('propagates a body operation through %s', loop => {
    using fixture = createFixture({ files: { 'main.ts': '/** @effects [] */ function run() { ' + loop + ' }' }, entries: ['main.ts'] });
    const analysis = fixture.check();
    const owner = analysis.owners.find(item => item.label === 'run' && item.role === 'implementation')!;
    expect(analysis.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(analysis.diagnostics.map(item => item.code)).toEqual(['exceeds']);
    expect(fixture.fix().analysis.diagnostics).toEqual([]);
    expect(fixture.fix().changedFiles).toEqual([]);
  });

  it('visits initializer, condition, incrementor and body expressions', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */ function run() {
  for (localStorage.getItem('init'); sessionStorage.getItem('condition'); localStorage.clear()) {
    sessionStorage.clear();
    break;
  }
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    const owner = analysis.owners.find(item => item.label === 'run' && item.role === 'implementation')!;
    expect(analysis.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual([
      'localstorage.read(*)', 'localstorage.write(*)', 'sessionstorage.read(*)', 'sessionstorage.write(*)',
    ]);
    expect(analysis.diagnostics.every(item => item.code === 'exceeds')).toBe(true);
  });

  it('evaluates declaration initializer and binding defaults', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */ function run() {
  for (let { value = localStorage.getItem('fallback') } = {}; false;) { void value; }
}
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    const owner = analysis.owners.find(item => item.label === 'run' && item.role === 'implementation')!;
    expect(analysis.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)']);
    expect(analysis.diagnostics.map(item => item.code)).toEqual(['exceeds']);
  });

  it('forwards a symbolic callback through a called function inside a retry loop', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["call(arg0.send)"] */
function attempt({ send }: { send: () => void }) { send(); }
/** @effects [] */
function retry({ send }: { send: () => void }) {
  for (;;) { attempt({ send }); break; }
}
/** @effects [] */
function entry() { retry({ send: () => localStorage.clear() }); }
`,
      },
      entries: ['main.ts'],
    });
    const analysis = fixture.check();
    const retry = analysis.owners.find(item => item.label === 'retry' && item.role === 'implementation')!;
    const entry = analysis.owners.find(item => item.label === 'entry' && item.role === 'implementation')!;
    expect(analysis.solution.rows.get(retry.id)?.map(effect => printEffect({ effect }))).toEqual(['call(arg0.send)']);
    expect(analysis.solution.rows.get(entry.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(false);
    expect(fixture.fix().analysis.diagnostics).toEqual([]);
  });
});
