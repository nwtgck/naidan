import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';

function inspect({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

describe('native Promise executor effects', () => {
  it.each(['', 'async '])('propagates immediate executor writes through a %sfunction', prefix => {
    const result = inspect({
      source: `\
/** @effects [] */
${prefix}function entry(): Promise<boolean> {
  return new Promise<boolean>(/** @effects ["localstorage.write(*)"] */ resolve => {
    localStorage.clear(); resolve(true);
  });
}
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const entry = result.owners.find(owner => owner.label === 'entry')!;
    expect((result.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(result.diagnostics.some(item => item.code === 'exceeds' && item.start === entry.location.start)).toBe(true);
  });

  it('propagates a captured verifier and then handlers through the executor to its caller', () => {
    const result = inspect({
      source: `\
/** @effects ["call(arg0.verifyPeer)"] */
async function verify({ verifyPeer }: { verifyPeer: () => Promise<boolean> }): Promise<boolean> {
  return new Promise<boolean>(/** @effects ["call(arg0.verifyPeer)"] */ (resolve, reject) => {
    Promise.resolve().then(/** @effects ["call(arg0.verifyPeer)"] */ () => verifyPeer()).then(resolve, reject);
  });
}
/** @effects ["localstorage.write(*)"] */
async function writer(): Promise<boolean> { localStorage.clear(); return true; }
/** @effects ["localstorage.write(*)"] */
function entry() { verify({ verifyPeer: writer }); }
`,
    });
    expect(result.diagnostics).toEqual([]);
    const verify = result.owners.find(owner => owner.label === 'verify')!;
    expect((result.solution.rows.get(verify.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['call(arg0.verifyPeer)']);
    const entry = result.owners.find(owner => owner.label === 'entry')!;
    expect((result.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });

  it('ignores executor return values and does not assimilate rejection reasons', () => {
    const result = inspect({
      source: `\
/** @effects [] */
function entry() {
  const thenable = { /** @effects ["localstorage.write(*)"] */ then() { localStorage.clear(); } };
  new Promise<boolean>(/** @effects [] */ (_resolve, reject) => { reject(thenable); return thenable; });
}
`,
    });
    expect(result.diagnostics).toEqual([]);
    const entry = result.owners.find(owner => owner.label === 'entry')!;
    expect(result.solution.rows.get(entry.id)).toEqual([]);
  });

  it.each([
    'const value = { /** @effects ["localstorage.write(*)"] */ then(resolve: (value: boolean) => void) { localStorage.clear(); resolve(true); } };',
    'const value: PromiseLike<boolean> = source;',
  ])('retains the unsupported settlement boundary for custom or unknown thenables: %s', declaration => {
    const result = inspect({
      source: `\
/** @effects [] */
function entry({ source }: { source: PromiseLike<boolean> }) {
  ${declaration}
  return new Promise<unknown>(/** @effects [] */ resolve => { resolve(value); });
}
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('settlement'))).toBe(true);
  });

  it('keeps shared executors unsupported while still propagating their body effects', () => {
    const result = inspect({
      source: `\
/** @effects ["localstorage.write(*)","call(arg0)"] */
function executor(resolve: (value: boolean) => void) { localStorage.clear(); resolve(true); }
/** @effects [] */
function entry() { return new Promise<boolean>(executor); }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('direct inline executor'))).toBe(true);
    const entry = result.owners.find(owner => owner.label === 'entry')!;
    expect((result.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }))).toContain('localstorage.write(*)');
  });
});
