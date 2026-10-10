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

function effects({ source }: { source: string }) {
  const result = inspect({ source });
  expect(result.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
  const owner = result.owners.find(item => item.label === 'entry')!;
  return {
    result,
    row: (result.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })),
  };
}

describe.each(['localStorage', 'sessionStorage'])('%s named reads', storage => {
  const effect = `${storage.toLowerCase()}.read(*)`;

  it.each([
    `void ${storage}.secret;`,
    `void ${storage}['secret'];`,
    `const store = window.${storage}; const key = 'secret'; void store[key];`,
    `const { secret } = ${storage}; void secret;`,
    `if (${storage}.secret) {}`,
    `void ${storage}.__unmodeledMember;`,
  ])('rejects an empty contract for a content getter: %s', statement => {
    const { result, row } = effects({ source: `/** @effects [] */ function entry() { ${statement} }` });
    expect(row).toEqual([effect]);
    expect(result.diagnostics.some(item => item.code === 'exceeds')).toBe(true);
    expect(result.modelDecisions.some(item => item.rule === `${storage.toLowerCase()}.property-read`
      && item.access === 'read' && item.disposition === 'tracked')).toBe(true);
  });

  it.each(['getItem', 'setItem', 'removeItem', 'key', 'clear', 'constructor', 'toString', 'hasOwnProperty', '__proto__'])('does not read stored content when obtaining %s', member => {
    const { result, row } = effects({ source: `/** @effects [] */ function entry() { void ${storage}['${member}']; }` });
    expect(result.diagnostics).toEqual([]);
    expect(row).toEqual([]);
    expect(result.modelDecisions).toEqual([]);
  });

  it('keeps an aliased method call distinct from obtaining its reference', () => {
    const { result, row } = effects({ source: `/** @effects ["${effect}"] */ function entry() { const { getItem } = ${storage}; void getItem('secret'); }` });
    expect(result.diagnostics).toEqual([]);
    expect(row).toEqual([effect]);
    expect(result.modelDecisions.filter(item => item.owner !== undefined).map(item => item.rule)).toEqual([`${storage.toLowerCase()}.read-method`]);
  });

  it('retains the length policy rather than treating length as a stored key', () => {
    const { result, row } = effects({ source: `/** @effects ["${effect}"] */ function entry() { void ${storage}.length; }` });
    expect(result.diagnostics).toEqual([]);
    expect(row).toEqual([effect]);
    expect(result.modelDecisions.some(item => item.rule === `${storage.toLowerCase()}.length`)).toBe(true);
  });

  it('allows getItem to retrieve a key hidden by a prototype member', () => {
    const { result, row } = effects({ source: `/** @effects ["${effect}"] */ function entry() { void ${storage}.getItem('toString'); }` });
    expect(result.diagnostics).toEqual([]);
    expect(row).toEqual([effect]);
  });

  it('keeps unknown dynamic keys unsupported', () => {
    const result = inspect({ source: `/** @effects [] */ function entry({ key }: { key: string }) { void ${storage}[key]; }` });
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('finite literal keys'))).toBe(true);
  });
});

it('uses the acquired storage value as data while retaining the read origin', () => {
  const { result, row } = effects({ source: `/** @effects ["localstorage.read(*)","network.http(*)"] */ function entry() { navigator.sendBeacon('/signal', localStorage.secret); }` });
  expect(result.diagnostics).toEqual([]);
  expect(row).toEqual(['localstorage.read(*)', 'network.http(*)']);
});

it('does not classify a local Storage lookalike as a browser content getter', () => {
  const { result, row } = effects({ source: `/** @effects [] */ function entry() { const localStorage = { secret: 'memory' }; void localStorage.secret; }` });
  expect(result.diagnostics).toEqual([]);
  expect(row).toEqual([]);
  expect(result.modelDecisions).toEqual([]);
});

describe.each(['localStorage', 'sessionStorage'])('native Window.%s handles', storage => {
  const prefix = storage.toLowerCase();

  it('obtains a storage handle without reading its content', () => {
    const { result, row } = effects({ source: `/** @effects [] */ function entry({ window }: { window: Window }) { void window.${storage}; }` });
    expect(result.diagnostics).toEqual([]);
    expect(row).toEqual([]);
    expect(result.modelDecisions.map(item => [item.rule, item.disposition, item.effects])).toEqual([
      [`window.${storage}`, 'intentional-none', []],
    ]);
  });

  it('retains content effects through an acquired native handle', () => {
    const { result, row } = effects({ source: `/** @effects ["${prefix}.read(*)","${prefix}.write(*)"] */ function entry({ window }: { window: Window }) { const store = window.${storage}; store.getItem('theme'); store.setItem('theme', 'dark'); }` });
    expect(result.diagnostics).toEqual([]);
    expect(row).toEqual([`${prefix}.read(*)`, `${prefix}.write(*)`]);
  });

  it('binds a receiver-preserving wrapper through an ordinary symbolic method slot', () => {
    const { result, row } = effects({
      source: `\
/** @effects ["call(arg0.storage.setItem)"] */
function write({ storage }: { storage: { setItem(key: string, value: string): void } }) { storage.setItem('theme', 'dark'); }
/** @effects ["${prefix}.write(*)"] */
function entry({ window }: { window: Window }) {
  const store = window.${storage};
  write({ storage: { /** @effects ["${prefix}.write(*)"] */ setItem: (key, value) => store.setItem(key, value) } });
}
`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(row).toEqual([`${prefix}.write(*)`]);
  });
});

it('keeps a shadowed Window type and custom storage method on their callback path', () => {
  const { result, row } = effects({
    source: `\
export {};
interface Window { localStorage: { setItem(key: string, value: string): void } }
/** @effects ["call(arg0.window.localStorage.setItem)"] */
function entry({ window }: { window: Window }) { window.localStorage.setItem('theme', 'dark'); }
/** @effects ["sessionstorage.write(*)"] */
function custom() { entry({ window: { localStorage: { /** @effects ["sessionstorage.write(*)"] */ setItem: () => sessionStorage.clear() } } }); }
`,
  });
  expect(result.diagnostics).toEqual([]);
  expect(row).toEqual(['call(arg0.window.localStorage.setItem)']);
  const custom = result.owners.find(owner => owner.label === 'custom')!;
  expect((result.solution.rows.get(custom.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['sessionstorage.write(*)']);
  expect(result.modelDecisions.some(item => item.rule === 'window.localStorage' || item.rule === 'localstorage.write-method')).toBe(false);
});

it.each([
  `const target = {} as unknown as Window; target.localStorage.setItem('theme', 'dark');`,
  `const target = { get localStorage() { sessionStorage.clear(); return localStorage; } }; target.localStorage.setItem('theme', 'dark');`,
])('does not replace an unchecked receiver or custom getter with native storage: %s', body => {
  const result = inspect({ source: `/** @effects [] */ function entry() { ${body} }` });
  expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  expect(result.modelDecisions.some(item => item.rule === 'window.localStorage')).toBe(false);
  expect(() => planEffectFix({ analysis: result })).toThrow();
});

it('retains the conversion boundary for an explicitly typed fake Window', () => {
  const result = inspect({ source: `/** @effects [] */ function entry() { const target: Window = {} as unknown as Window; target.localStorage.setItem('theme', 'dark'); }` });
  expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  expect(result.diagnostics.some(item => item.message === 'Unsupported or unresolved effect value conversion: record to native.')).toBe(true);
  expect(() => planEffectFix({ analysis: result })).toThrow();
});

it('retains the native-to-symbolic storage argument boundary without an adapter', () => {
  const result = inspect({
    source: `\
/** @effects ["call(arg0.storage.setItem)"] */
function write({ storage }: { storage: { setItem(key: string, value: string): void } }) { storage.setItem('theme', 'dark'); }
/** @effects [] */
function entry({ window }: { window: Window }) { write({ storage: window.localStorage }); }
`,
  });
  expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  expect(result.diagnostics.some(item => item.message === 'Unsupported or unresolved effect value conversion: native to record.')).toBe(true);
  expect(() => planEffectFix({ analysis: result })).toThrow();
});

it.each(['Storage', "Pick<Storage, 'setItem'>"])('does not make an arbitrary %s parameter native', type => {
  const result = inspect({ source: `/** @effects [] */ function entry({ storage }: { storage: ${type} }) { storage.setItem('theme', 'dark'); }` });
  expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(false);
  expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.startsWith('Built-in type '))).toBe(true);
  expect(result.modelDecisions.some(item => item.rule === 'localstorage.write-method' || item.rule === 'sessionstorage.write-method')).toBe(false);
  expect(() => planEffectFix({ analysis: result })).toThrow();
});
