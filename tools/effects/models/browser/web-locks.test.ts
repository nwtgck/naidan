import { describe, expect, it } from 'vitest';
import { createFixture } from '../../test-support/project-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';
import { planEffectFix } from '../../fixes/plan.ts';

function inspect({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

describe('Web Locks argument conversion and callback propagation', () => {
  it.each(['AbortSignal', 'AbortSignal | undefined'])('accepts an existing native %s in a checked options dictionary', signalType => {
    const result = inspect({
      source: `\
/** @effects [] */
function entry({ signal }: { signal: ${signalType} }) {
  const options: LockOptions = { signal, mode: 'exclusive', ifAvailable: false, steal: false };
  navigator.locks.request('resource', options, /** @effects [] */ () => {});
}
`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    `function entry({ signal }: { signal: unknown }) { navigator.locks.request('resource', { signal: signal as AbortSignal }, /** @effects [] */ () => {}); }`,
    `function entry() { const signal = { aborted: false }; navigator.locks.request('resource', { signal: signal as AbortSignal }, /** @effects [] */ () => {}); }`,
    `function entry({ options }: { options: LockOptions }) { navigator.locks.request('resource', options, /** @effects [] */ () => {}); }`,
  ])('does not accept a fake signal or unknown options shape: %s', body => {
    const result = inspect({ source: `/** @effects [] */ ${body}` });
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it('does not execute or require serialization of unrelated dictionary fields', () => {
    const result = inspect({
      source: `\
/** @effects [] */
function entry() {
  const options = {
    mode: 'exclusive' as const,
    /** @effects ["localstorage.write(*)"] */
    unused() { localStorage.clear(); },
  };
  navigator.locks.request('resource', options, /** @effects [] */ () => {});
}
`,
    });
    expect(result.diagnostics).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry')!;
    expect(result.solution.rows.get(owner.id)).toEqual([]);
  });

  it.each([
    `navigator.locks.request(value as unknown as string, /** @effects [] */ () => {});`,
    `navigator.locks.request('resource', { mode: value as unknown as LockMode }, /** @effects [] */ () => {});`,
  ])('rejects executable name/option conversion instead of certifying none: %s', statement => {
    const result = inspect({
      source: `\
export {};
/** @effects [] */
function entry() {
  const value = {
    /** @effects ["localstorage.write(*)"] */
    toString() { localStorage.clear(); return 'exclusive'; },
  };
  ${statement}
}
`,
    });
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it.each([
    `navigator.locks.request('resource', callback);`,
    `navigator.locks.request('resource', { mode: 'exclusive', ifAvailable: true }, callback);`,
    `const request = navigator.locks.request; request('resource', callback);`,
  ])('preserves an explicitly checked callback effect: %s', statement => {
    const result = inspect({
      source: `\
/** @effects [] */
function entry() {
  /** @effects ["localstorage.write(*)"] */
  const callback = () => { localStorage.clear(); };
  ${statement}
}
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry')!;
    expect((result.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(result.diagnostics.some(item => item.code === 'exceeds')).toBe(true);
  });

  it('retains explicit argument evaluation even for a none callback', () => {
    const result = inspect({
      source: `\
/** @effects ["localstorage.write(*)"] */
function entry() {
  navigator.locks.request((localStorage.clear(), 'resource'), { mode: 'exclusive' }, /** @effects [] */ () => {});
}
`,
    });
    expect(result.diagnostics).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry')!;
    expect((result.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });

  it('selects the declared callback position while still evaluating extra arguments', () => {
    const result = inspect({
      source: `\
/** @effects [] */
function entry() {
  /** @effects ["localstorage.write(*)"] */
  const callback = () => { localStorage.clear(); };
  (navigator.locks.request as unknown as (name: string, options: LockOptions, callback: () => void, extra: () => void) => Promise<void>)(
    'resource', { mode: 'exclusive' }, callback, (sessionStorage.clear(), /** @effects [] */ () => {}),
  );
}
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry')!;
    expect((result.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)', 'sessionstorage.write(*)']);
  });
});
