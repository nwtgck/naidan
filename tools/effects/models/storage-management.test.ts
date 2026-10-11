import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';

// The 019 classification tests are adapted to the explicit 020 policy boundary,
// not removed: all three operations, separation, invalid names, widening, unsafe
// behavior and argument-spread refusal remain covered.
describe('browser storage accounting/policy is intentionally outside tracked I/O', () => {
  it.each(['persist', 'persisted', 'estimate'])('explicitly models navigator.storage.%s as none', method => {
    using fixture = createFixture({ files: { 'main.ts': `/** @effects [] */ function inspect() { navigator.storage.${method}(); }` }, entries: ['main.ts'] });
    const analysis = fixture.check();
    expect(analysis.diagnostics).toEqual([]);
    const owner = analysis.owners.find(item => item.label === 'inspect')!;
    expect(analysis.solution.rows.get(owner.id)).toEqual([]);
    expect(analysis.modelDecisions).toEqual([expect.objectContaining({
      operation: `navigator.storage.${method}`,
      disposition: 'intentional-none',
      effects: [],
      reason: expect.any(String),
    })]);
    expect(analysis.unsafeSuppressions).toEqual([]);
  });

  it('does not authorize localStorage writes, OPFS reads or HTTP requests', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */
function inspect() { navigator.storage.persist(); localStorage.clear(); navigator.storage.getDirectory(); fetch('/x'); }
`,
      },
      entries: ['main.ts'],
    });
    const violations = fixture.check().diagnostics.filter(item => item.code === 'exceeds');
    expect(violations).toHaveLength(3);
    for (const effect of ['localstorage.write(*)', 'opfs.read(*)', 'network.http(*)']) {
      expect(violations.some(item => item.message.startsWith(effect))).toBe(true);
    }
  });
});

describe('the policy boundary is explicit, not an ambient StorageManager exemption', () => {
  it.each(['persist', 'persisted', 'estimate'])('keeps content access visible beside %s', method => {
    using fixture = createFixture({ files: { 'main.ts': `/** @effects [] */ function inspect() { navigator.storage.${method}(); localStorage.clear(); }` }, entries: ['main.ts'] });
    const analysis = fixture.check();
    expect(analysis.diagnostics).toHaveLength(1);
    expect(analysis.diagnostics[0]?.code).toBe('exceeds');
    expect(analysis.diagnostics[0]?.message).toContain('localstorage.write');
  });

  it.each(['storage.manage', 'storage.metadata.read', 'storage.persistence.request'])('rejects retired %s instead of silently aliasing it to none', name => {
    using fixture = createFixture({ files: { 'main.ts': `/** @effects ["${name}(*)"] */ function inspect() { navigator.storage.persist(); }` }, entries: ['main.ts'] });
    expect(fixture.check().diagnostics.some(item => item.code === 'syntax')).toBe(true);
    expect(() => fixture.fix()).toThrow();
  });

  it('keeps a deliberately wider valid declaration during ordinary widening fixes', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["localstorage.read(*)","localstorage.write(*)"] */
function inspect() { navigator.storage.persisted(); }
`,
      },
      entries: ['main.ts'],
    });
    expect(fixture.fix().changedFiles).toEqual([]);
  });

  it('does not suppress a neighboring write when an explicit exception masks only a read', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.read(*)"],"reason":"Key probe only."} */
function inspect() { navigator.storage.persisted(); localStorage.getItem('x'); localStorage.clear(); }
function caller() { inspect(); }
`,
      },
      entries: ['main.ts'],
    });
    const fixed = fixture.fix();
    expect(fixed.analysis.diagnostics).toEqual([]);
    for (const label of ['inspect', 'caller']) {
      const owner = fixed.analysis.owners.find(item => item.label === label)!;
      expect(fixed.analysis.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    }
    expect(fixture.fix().changedFiles).toEqual([]);
  });

  it('keeps general argument spreads explicitly unsupported', () => {
    using fixture = createFixture({ files: { 'main.ts': 'function inspect() { navigator.storage.estimate(...([] as [])); }' }, entries: ['main.ts'] });
    expect(fixture.check().diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });
});
