import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { planEffectFix } from '../fixes/plan.ts';
import { printEffect } from '../contracts/effects.ts';

function analyze({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

const writer = '/** @effects ["localstorage.write(*)"] */ function writer() { localStorage.clear(); }';
const stringify = 'const tricky = { /** @effects ["localstorage.write(*)"] */ toString() { localStorage.clear(); return "x"; } };';

describe('contract boundary adversarial cases', () => {
  it.each([
    'localStorage.setItem("x", tricky as unknown as string);',
    'String(tricky);',
    'Math.abs(tricky as unknown as number);',
    '"x".includes(tricky as unknown as string);',
    'new Error(tricky as unknown as string);',
    'const result = `${tricky}`; void result;',
    'const result = +(tricky as unknown as number); void result;',
    'const result = (tricky as unknown as number) + 1; void result;',
    'fetch(tricky as unknown as string);',
  ])('does not certify implicit object coercion: %s', expression => {
    const result = analyze({
      source: `${stringify}
/** @effects ["localstorage.write(*)","network.http(*)"] */
function run() { ${expression} }`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it('does not infer a property deletion from a logical expression typed as a narrower view', () => {
    const result = analyze({
      source: `
${writer}
const original = { x: '', then: writer };
const view: { x: string } = original;
/** @effects [] */
async function run() { await (view || { x: '' }); }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not reuse a closed initial shape after replacing a variable with a larger object', () => {
    const result = analyze({
      source: `
${writer}
let value = { x: '' };
const other = { x: '', then: writer };
/** @effects [] */
async function run() { value = other; await value; }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not reuse a closed nested shape after replacing a shared field', () => {
    const result = analyze({
      source: `
${writer}
const holder = { value: { x: '' } };
const other = { x: '', then: writer };
/** @effects [] */ async function run() { holder.value = other; await holder.value; }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not lose a fulfilled writer when adding a rejection handler', () => {
    const result = analyze({
      source: `
${writer}
/** @effects [] */ function empty() {}
/** @effects [] */ async function run() {
  const callback = await Promise.resolve(writer).catch(/** @effects [] */ () => empty);
  callback();
}
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const run = result.owners.find(owner => owner.label === 'run');
    expect(run).toBeDefined();
    expect((result.solution.rows.get(run!.id) ?? []).map(effect => printEffect({ effect }))).toContain('localstorage.write(*)');
  });

  it('keeps factory execution separate from the writer that it returns', () => {
    const result = analyze({
      source: `
${writer}
/** @effects ["network.http(*)"] */ function create() { fetch('/prepare'); return writer; }
const actions = { /** @effects ["localstorage.write(*)"] */ run: () => {} };
/** @effects ["network.http(*)"] */ function install() { actions.run = create(); }
/** @effects ["localstorage.write(*)"] */ function execute() { actions.run(); }
`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('does not make an unknown caller safe merely because it forms a recursion cycle', () => {
    const result = analyze({ source: '/** @effects [] */ async function settle<T>(value: T): Promise<void> { await value; settle(value); }' });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('retains an extra copied method through a structural alias', () => {
    const result = analyze({
      source: `
${writer}
const source = { run: writer, x: '' };
const view: { x: string } = source;
const destination = { /** @effects [] */ run: () => {}, x: '' };
/** @effects [] */ function install() { Object.assign(destination, view); }
/** @effects [] */ function execute() { destination.run(); }
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const execute = result.owners.find(owner => owner.label === 'execute');
    expect((result.solution.rows.get(execute!.id) ?? []).map(effect => printEffect({ effect }))).toContain('localstorage.write(*)');
    const install = result.owners.find(owner => owner.label === 'install');
    expect(result.solution.rows.get(install!.id)).toEqual([]);
  });

  it('does not certify getters hidden from a data view', () => {
    const result = analyze({ source: '/** @effects [] */ async function run() { const original = { x: "", get then() { localStorage.clear(); return undefined; } }; const view: { x: string } = original; await view; }' });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('allows object identity comparison without invoking a conversion hook', () => {
    const result = analyze({
      source: `${stringify}
/** @effects [] */ function inspect() { return tricky === tricky; }`,
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe('unmodeled built-in objects retain their native boundary', () => {
  it.each(['Map<string, () => void>', 'Set<() => void>'])('does not invent application contracts in standard library declarations: %s', type => {
    const result = analyze({ source: `/** @effects [] */ function inspect({ value }: { value: ${type} }) { void value; }` });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('explicit effect model'))).toBe(true);
    expect(result.diagnostics.some(item => item.code === 'missing' || item.code === 'syntax')).toBe(false);
    expect(result.owners.every(owner => owner.location.file.endsWith('/main.ts'))).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });
});

describe('local class method candidates keep their unresolved boundaries', () => {
  it.each([
    {
      label: 'native I/O and an ordinary callee',
      source: `\
function write() { sessionStorage.clear(); }
class Service { publish() { localStorage.clear(); write(); } }
const service = new Service();
function entry() { service.publish(); }
`,
      effects: ['localstorage.write(*)', 'sessionstorage.write(*)'],
    },
    {
      label: 'another method through this',
      source: `\
class Service {
  inner() { localStorage.clear(); }
  publish() { this.inner(); }
}
const service = new Service();
function entry() { service.publish(); }
`,
      effects: ['localstorage.write(*)'],
    },
    {
      label: 'a forwarded callback',
      source: `\
class Service {
  withLock({ fn }: { fn: () => void }) { fn(); }
  publish() { this.withLock({ fn: () => localStorage.clear() }); }
}
const service = new Service();
function entry() { service.publish(); }
`,
      effects: ['localstorage.write(*)'],
    },
  ])('collects $label while leaving the class call unverified', ({ source, effects }) => {
    const result = analyze({ source });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const entry = result.owners.find(owner => owner.label === 'entry');
    expect(entry).toBeDefined();
    expect((result.solution.rows.get(entry!.id) ?? []).map(effect => printEffect({ effect }))).toEqual(effects);
    expect(result.diagnostics.some(item => item.message === 'Unsupported effect statement: ClassDeclaration.')).toBe(true);
    expect(result.diagnostics.some(item => item.message === 'Unverified property access: publish.')).toBe(true);
    expect(result.diagnostics.some(item => item.message === 'The call target has no checked effect contract.')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it.each([
    { label: 'a constructor', member: "constructor() { sessionStorage.clear(); }" },
    { label: 'a field initializer', member: 'field = sessionStorage.clear();' },
  ])('keeps $label unverified when it discovers a method body', ({ member }) => {
    const result = analyze({
      source: `\
class Service {
  ${member}
  publish() { localStorage.clear(); }
}
const service = new Service();
function entry() { service.publish(); }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const entry = result.owners.find(owner => owner.label === 'entry');
    expect((result.solution.rows.get(entry!.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(result.diagnostics.some(item => item.message === 'Unsupported effect statement: ClassDeclaration.')).toBe(true);
    expect(result.diagnostics.some(item => item.message === 'The call target has no checked effect contract.')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it('does not turn a method return type into a verified native receiver', () => {
    const result = analyze({
      source: `\
class Service {
  echo({ file }: { file: FileSystemFileHandle }): FileSystemFileHandle {
    localStorage.clear();
    return file;
  }
}
const service = new Service();
async function entry({ input }: { input: FileSystemFileHandle }) {
  const file = service.echo({ file: input });
  const writable = await file.createWritable();
  await writable.write('saved');
}
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const entry = result.owners.find(owner => owner.label === 'entry');
    expect((result.solution.rows.get(entry!.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    expect(result.diagnostics.some(item => item.message === 'Unverified property access: createWritable.')).toBe(true);
    expect(result.diagnostics.some(item => item.message === 'Unverified property access: write.')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it.each([
    {
      label: 'a getter',
      source: `\
class Service { get publish() { return () => localStorage.clear(); } }
const service = new Service();
function entry() { service.publish(); }
`,
      message: 'Unverified property access: publish.',
    },
    {
      label: 'a dynamic member',
      source: `\
class Service { publish() { localStorage.clear(); } }
const service = new Service();
function entry({ key }: { key: string }) { service[key as 'publish'](); }
`,
      message: 'Element access requires finite literal keys.',
    },
    {
      label: 'an ambient class',
      source: `\
declare class Service { publish(): void; }
declare const service: Service;
function entry() { service.publish(); }
`,
      message: 'Unverified property access: publish.',
    },
  ])('does not treat $label as a checked method body', ({ source, message }) => {
    const result = analyze({ source });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const entry = result.owners.find(owner => owner.label === 'entry');
    expect(result.solution.rows.get(entry!.id)).toEqual([]);
    expect(result.diagnostics.some(item => item.message === message)).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it('keeps a custom object method when a cast claims it is a class instance', () => {
    const result = analyze({
      source: `\
class Service { publish() { localStorage.clear(); } }
const service = { publish() { sessionStorage.clear(); } } as Service;
function entry() { service.publish(); }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const entry = result.owners.find(owner => owner.label === 'entry');
    expect((result.solution.rows.get(entry!.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['sessionstorage.write(*)']);
    expect(result.diagnostics.some(item => item.message === 'Unsupported effect statement: ClassDeclaration.')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });
});
