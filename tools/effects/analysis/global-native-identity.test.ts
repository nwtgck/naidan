import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EffectsAnalysis } from './analyze.ts';
import { printEffect } from '../contracts/effects.ts';
import { createFixture } from '../test-support/project-fixture.ts';

function inspect({ source, globals, dom }: { source: string, globals?: string, dom?: false }): EffectsAnalysis {
  const fixture = createFixture({
    files: { 'main.ts': source, ...(globals === undefined ? {} : { 'globals.d.ts': globals }) },
    entries: ['main.ts', ...(globals === undefined ? [] : ['globals.d.ts'])],
  });
  try {
    if (dom === false) {
      const file = path.join(fixture.root, 'tsconfig.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.compilerOptions.lib = ['ES2023'];
      fs.writeFileSync(file, JSON.stringify(config));
    }
    const analysis = fixture.check();
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    return analysis;
  } finally {
    fixture.dispose();
  }
}

function row({ analysis, label }: { analysis: EffectsAnalysis, label: string }): readonly string[] {
  const owner = analysis.owners.find(item => item.label === label && item.role === 'implementation')!;
  return (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
}

describe('global native member identity', () => {
  it.each([
    {
      globals: 'export {}; declare global { var localStorage: { getItem(key: string): string | null }; }',
      body: "void globalThis.localStorage.getItem('x');",
    },
    {
      globals: 'export {}; declare global { var navigator: { storage: { getDirectory(): Promise<object> } }; }',
      body: 'await globalThis.navigator.storage.getDirectory();',
    },
  ])('rejects custom globals without a DOM declaration: $body', ({ globals, body }) => {
    const analysis = inspect({ source: `export {}; /** @effects [] */ async function entry() { ${body} }`, globals, dom: false });
    expect(row({ analysis, label: 'entry' })).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message.includes('checked default-library identity'))).toBe(true);
  });

  it.each(['globalThis', 'window', 'self'])('keeps mixed value declarations unresolved through %s', root => {
    const analysis = inspect({
      source: `\
export {};
/** @effects [] */ function bare() { localStorage.setItem('x', 'saved'); }
/** @effects [] */ function entry() { ${root}.localStorage.setItem('x', 'saved'); }
`,
      globals: 'export {}; declare global { var localStorage: Storage; }',
    });
    expect(row({ analysis, label: 'bare' })).toEqual(['localstorage.write(*)']);
    expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)']);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message.includes('Ambient value localStorage'))).toBe(true);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message.includes('Global property localStorage'))).toBe(true);
  });

  it('retains genuine DOM aliases, destructuring and finite literal member access', () => {
    const analysis = inspect({
      source: `\
export {};
const root = globalThis;
const { localStorage: storage } = root;
const request = root['fetch'];
/** @effects ["localstorage.write(*)","network.http(*)","opfs.read(*)"] */
async function entry() {
  storage.setItem('x', 'saved');
  await request('/data');
  await root.navigator.storage.getDirectory();
}
`,
    });
    expect(analysis.diagnostics).toEqual([]);
    expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)', 'network.http(*)', 'opfs.read(*)']);
  });

  it('uses the canonical global member when a local variable has the same name', () => {
    const analysis = inspect({
      source: `\
export {};
const localStorage = { /** @effects ["sessionstorage.write(*)"] */ setItem() { sessionStorage.clear(); } };
/** @effects ["localstorage.write(*)"] */ function entry() { globalThis.localStorage.setItem('x', 'saved'); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
    expect(row({ analysis, label: 'entry' })).toEqual(['localstorage.write(*)']);
  });

  it.each([
    "const globalThis = { localStorage: { /** @effects [\"sessionstorage.write(*)\"] */ getItem() { sessionStorage.clear(); return ''; } } }; /** @effects [\"sessionstorage.write(*)\"] */ function entry() { void globalThis.localStorage.getItem(); }",
    "const root = { localStorage: { /** @effects [\"sessionstorage.write(*)\"] */ getItem() { sessionStorage.clear(); return ''; } } } as unknown as typeof globalThis; /** @effects [\"sessionstorage.write(*)\"] */ function entry() { void root.localStorage.getItem('x'); }",
    "const fake = { /** @effects [\"sessionstorage.write(*)\"] */ getItem() { sessionStorage.clear(); return ''; } } as unknown as Storage; /** @effects [\"sessionstorage.write(*)\"] */ function entry() { void fake.getItem('x'); }",
  ])('preserves shadow and cast implementation effects: %s', source => {
    const analysis = inspect({ source: `export {}; ${source}` });
    expect(analysis.diagnostics).toEqual([]);
    expect(row({ analysis, label: 'entry' })).toEqual(['sessionstorage.write(*)']);
  });

  it('does not accept an ambient namespace as the intrinsic root', () => {
    const analysis = inspect({
      source: "import { globalThis } from './globals'; /** @effects [] */ function entry() { void globalThis.localStorage.getItem('x'); }",
      globals: 'export declare namespace globalThis { const localStorage: { getItem(key: string): string | null }; }',
    });
    expect(row({ analysis, label: 'entry' })).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'boundary' && item.message.includes('Ambient value globalThis'))).toBe(true);
  });

  it('does not turn an unknown root cast into an intrinsic global', () => {
    const analysis = inspect({ source: 'export {}; /** @effects [] */ function entry({ root }: { root: unknown }) { void (root as typeof globalThis).localStorage.getItem("x"); }' });
    expect(row({ analysis, label: 'entry' })).toEqual([]);
    expect(analysis.diagnostics.some(item => item.message === 'Unverified property access: localStorage.')).toBe(true);
  });

  it('retains standard pure globals, constructors, typeof and intrinsic values', () => {
    const analysis = inspect({
      source: `\
export {};
/** @effects [] */ function entry() {
  void globalThis.String(123);
  void globalThis.Math.floor(1.5);
  void new globalThis.Error('message');
  void typeof globalThis;
  void globalThis.undefined;
  void globalThis.globalThis.Math.ceil(1.5);
}
`,
    });
    expect(analysis.diagnostics).toEqual([]);
    expect(row({ analysis, label: 'entry' })).toEqual([]);
  });

  it('preserves the existing Worker type-only augmentation exception', () => {
    const analysis = inspect({
      source: 'export {}; /** @effects [] */ function entry() { void globalThis.Worker; }',
      globals: 'export {}; declare global { interface Worker { readonly addedTypeOnlyMember: string; } }',
    });
    expect(analysis.diagnostics).toEqual([]);
  });
});
