import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';

function analyze({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

describe('conditional own-property contracts', () => {
  it('accepts the Naidan TEST_ONLY conditional shape without evaluating callbacks at construction', () => {
    const result = analyze({
      source: `\
function create({ enabled }: { enabled: boolean }) {
  return { ...((enabled && { TEST_ONLY: { save: () => { localStorage.clear(); } } }) || {}) };
}
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(owner => owner.label === 'create')!;
    expect(result.solution.rows.get(owner.id)).toEqual([]);
  });

  it('unions conditional callable values without forgetting either possible effect', () => {
    const result = analyze({
      source: `\
function read() { localStorage.getItem('x'); }
function write() { localStorage.clear(); }
function use({ enabled }: { enabled: boolean }) {
  const actions = { ...(enabled ? { run: read } : { run: write }) };
  actions.run();
}
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(owner => owner.label === 'use')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)', 'localstorage.write(*)']);
  });

  it('checks every candidate against an existing destination slot', () => {
    const result = analyze({
      source: `\
function write() { localStorage.clear(); }
function read() { localStorage.getItem('x'); }
function use({ enabled }: { enabled: boolean }) {
  const actions = { /** @effects \`none\` */ run: () => {}, ...(enabled ? { run: write } : { run: read }) };
  actions.run();
}
`,
    });
    expect(result.diagnostics.some(item => item.code === 'exceeds')).toBe(true);
  });

  it.each([
    'const result = { ...(input || {}) };',
    'const result = { ...(enabled ? input : {}) };',
    'const result = { ...((enabled && input) || {}) };',
  ])('does not turn an open structural shape into closed copy evidence: %s', expression => {
    const result = analyze({ source: `function test({ input, enabled }: { input: { visible: string }, enabled: boolean }) { ${expression} }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Object spread needs'))).toBe(true);
  });

  it('does not drop expression effects when the resulting record is conditional', () => {
    const result = analyze({
      source: `\
function enabled() { localStorage.clear(); return true; }
function create() { return { ...((enabled() && { value: '' }) || {}) }; }
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(owner => owner.label === 'create')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });

  it('keeps a fallback callback when a modeled browser member can be unavailable', () => {
    const result = analyze({
      source: `\
const run = navigator.storage.persist || (async () => { localStorage.clear(); return false; });
function execute() { run(); }
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(owner => owner.label === 'execute')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toContain('localstorage.write(*)');
  });

  it('does not treat an ambient function declaration as a checked implementation', () => {
    const fixture = createFixture({ files: { 'ambient.d.ts': 'export declare function run(): void;', 'main.ts': "import { run } from './ambient'; function use() { run(); }" }, entries: ['main.ts'] });
    try {
      expect(fixture.check().diagnostics.some(item => item.code === 'boundary')).toBe(true);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });
});

describe('conditional scalar alternatives keep types and callable candidates separate', () => {
  it('retains literal keys for a conditional dynamic call', () => {
    const result = analyze({
      source: `\
const actions = { read: () => { localStorage.getItem('x'); }, write: () => { localStorage.clear(); } };
function use({ enabled }: { enabled: boolean }) { actions[enabled ? 'read' : 'write'](); }
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(owner => owner.label === 'use')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)', 'localstorage.write(*)']);
  });

  it('checks every destination when a conditional key is used for a write', () => {
    const result = analyze({
      source: `\
const actions = { /** @effects \`none\` */ read: () => {}, /** @effects \`localstorage.write(*)\` */ write: () => {} };
/** @effects \`localstorage.write(*)\` */ function writer() { localStorage.clear(); }
function install({ enabled }: { enabled: boolean }) { actions[enabled ? 'read' : 'write'] = writer; }
`,
    });
    expect(result.diagnostics.some(item => item.code === 'exceeds' && item.message.includes('read'))).toBe(true);
    const owner = result.owners.find(owner => owner.label === 'install')!;
    expect(result.solution.rows.get(owner.id)).toEqual([]);
  });

  it('does not mistake a conditional callable for a scalar', () => {
    const result = analyze({
      source: `\
function writer() { localStorage.clear(); }
function noop() {}
function use({ enabled }: { enabled: boolean }) { const selected = enabled ? writer : noop; selected(); }
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const owner = result.owners.find(owner => owner.label === 'use')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });
});
