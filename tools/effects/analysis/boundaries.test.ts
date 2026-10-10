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

const writer = '/** @effects `localstorage.write(*)` */ function writer() { localStorage.clear(); }';
const stringify = 'const tricky = { /** @effects `localstorage.write(*)` */ toString() { localStorage.clear(); return "x"; } };';

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
    const result = analyze({ source: `${stringify}\n/** @effects \`localstorage.write(*)\`, \`network.http(*)\` */\nfunction run() { ${expression} }` });
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
/** @effects \`none\` */
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
/** @effects \`none\` */
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
/** @effects \`none\` */ async function run() { holder.value = other; await holder.value; }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not lose a fulfilled writer when adding a rejection handler', () => {
    const result = analyze({
      source: `
${writer}
/** @effects \`none\` */ function empty() {}
/** @effects \`none\` */ async function run() {
  const callback = await Promise.resolve(writer).catch(/** @effects \`none\` */ () => empty);
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
/** @effects \`network.http(*)\` */ function create() { fetch('/prepare'); return writer; }
const actions = { /** @effects \`localstorage.write(*)\` */ run: () => {} };
/** @effects \`network.http(*)\` */ function install() { actions.run = create(); }
/** @effects \`localstorage.write(*)\` */ function execute() { actions.run(); }
`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('does not make an unknown caller safe merely because it forms a recursion cycle', () => {
    const result = analyze({ source: '/** @effects `none` */ async function settle<T>(value: T): Promise<void> { await value; settle(value); }' });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('retains an extra copied method through a structural alias', () => {
    const result = analyze({
      source: `
${writer}
const source = { run: writer, x: '' };
const view: { x: string } = source;
const destination = { /** @effects \`none\` */ run: () => {}, x: '' };
/** @effects \`none\` */ function install() { Object.assign(destination, view); }
/** @effects \`none\` */ function execute() { destination.run(); }
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const execute = result.owners.find(owner => owner.label === 'execute');
    expect((result.solution.rows.get(execute!.id) ?? []).map(effect => printEffect({ effect }))).toContain('localstorage.write(*)');
    const install = result.owners.find(owner => owner.label === 'install');
    expect(result.solution.rows.get(install!.id)).toEqual([]);
  });

  it('does not certify getters hidden from a data view', () => {
    const result = analyze({ source: '/** @effects `none` */ async function run() { const original = { x: "", get then() { localStorage.clear(); return undefined; } }; const view: { x: string } = original; await view; }' });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('allows object identity comparison without invoking a conversion hook', () => {
    const result = analyze({ source: `${stringify}\n/** @effects \`none\` */ function inspect() { return tricky === tricky; }` });
    expect(result.diagnostics).toEqual([]);
  });
});
