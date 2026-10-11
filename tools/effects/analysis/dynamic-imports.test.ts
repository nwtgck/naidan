import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';
import { applyEffectFix } from '../fixes/apply.ts';
import { executableTokens } from '../fixes/executable.ts';
import { planUnresolvedEffectFix, UNVERIFIED_EFFECT_NOTE } from '../maintenance/unverified.ts';

function inspect({ fixture }: { fixture: ReturnType<typeof createFixture> }) {
  const analysis = fixture.check();
  expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
  expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  const rows = Object.fromEntries(analysis.owners.filter(owner => owner.role === 'module' || owner.role === 'implementation').map(owner => [
    path.basename(owner.location.file) + ':' + owner.label,
    (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })),
  ]));
  return { analysis, rows };
}

describe('partial local literal dynamic imports', () => {
  it('keeps lazy module initialization on the calling function', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `export async function load() { await import('./storage.ts'); } export function untouched() {}`,
        'storage.ts': `localStorage.clear(); export {};`,
      },
      entries: ['main.ts'],
    });
    const { analysis, rows } = inspect({ fixture });
    expect(rows).toEqual({ 'main.ts:<module>': [], 'storage.ts:<module>': ['localstorage.write(*)'], 'main.ts:load': ['localstorage.write(*)'], 'main.ts:untouched': [] });
    expect(analysis.diagnostics.some(item => item.message.includes('Dynamic import loading and namespace settlement'))).toBe(true);
    expect(() => fixture.fix()).toThrow('Effect fix refused');
  });

  it('propagates top-level dynamic import and transitive static initialization', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `void import('./storage.ts'); export {};`,
        'storage.ts': `import './leaf.ts'; export {};`,
        'leaf.ts': `sessionStorage.clear(); export {};`,
      },
      entries: ['main.ts'],
    });
    expect(inspect({ fixture }).rows).toEqual({ 'main.ts:<module>': ['sessionstorage.write(*)'], 'storage.ts:<module>': ['sessionstorage.write(*)'], 'leaf.ts:<module>': ['sessionstorage.write(*)'] });
  });

  it.each([
    `const api = await import('./storage.ts'); api.write();`,
    `const { write } = await import('./storage.ts'); write();`,
    `await import('./storage.ts').then(api => api.write());`,
  ])('reuses a checked namespace export through %s', body => {
    using fixture = createFixture({
      files: {
        'main.ts': `export async function load() { ${body} }`,
        'storage.ts': `export { write } from './leaf.ts';`,
        'leaf.ts': `export function write() { localStorage.clear(); }`,
      },
      entries: ['main.ts'],
    });
    const { rows } = inspect({ fixture });
    expect(rows['main.ts:load']).toEqual(['localstorage.write(*)']);
    expect(rows['main.ts:<module>']).toEqual([]);
    expect(rows['storage.ts:<module>']).toEqual([]);
  });

  it('keeps returning an export separate from invoking it', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `export async function load() { return (await import('./storage.ts')).write; } export async function entry() { const write = await load(); write(); }`,
        'storage.ts': `export function write() { localStorage.clear(); }`,
      },
      entries: ['main.ts'],
    });
    const { rows } = inspect({ fixture });
    expect(rows['main.ts:load']).toEqual([]);
    expect(rows['main.ts:entry']).toEqual(['localstorage.write(*)']);
  });

  it('retains unknown namespace then settlement rather than declaring a complete promise', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `export async function load() { await import('./storage.ts'); }`,
        'storage.ts': `export function then(resolve: (value: number) => void) { localStorage.clear(); resolve(1); }`,
      },
      entries: ['main.ts'],
    });
    const { analysis } = inspect({ fixture });
    expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Unverified Promise settlement'))).toBe(true);
    expect(() => fixture.fix()).toThrow('Effect fix refused');
  });

  it.each([
    { body: `const source = './storage.ts'; await import(source);`, expected: [] },
    { body: `await import('./storage.ts', options());`, expected: ['localstorage.write(*)'] },
  ])('keeps unsupported computed or option-bearing imports explicit: $body', ({ body, expected }) => {
    using fixture = createFixture({
      files: {
        'main.ts': `function options() { localStorage.clear(); return { with: { type: 'json' } }; } export async function load() { ${body} }`,
        'storage.ts': `sessionStorage.clear(); export {};`,
      },
      entries: ['main.ts'],
    });
    const { analysis, rows } = inspect({ fixture });
    expect(rows['main.ts:load']).toEqual(expected);
    expect(analysis.coverage.files).toEqual([path.join(fixture.root, 'main.ts')]);
    expect(analysis.diagnostics.some(item => item.message.includes('ImportKeyword'))).toBe(true);
  });

  it.each([
    { specifier: './storage', dependency: 'storage.d.ts', text: `export declare function write(): void;` },
    { specifier: './storage.test.ts', dependency: 'storage.test.ts', text: `localStorage.clear(); export function write() {}` },
  ])('does not execute an unchecked source body at $specifier', ({ specifier, dependency, text }) => {
    using fixture = createFixture({
      files: {
        'main.ts': `export async function load() { await import('${specifier}'); }`,
        [dependency]: text,
      },
      entries: ['main.ts'],
    });
    const { analysis, rows } = inspect({ fixture });
    expect(rows['main.ts:load']).toEqual([]);
    expect(analysis.coverage.files).toEqual([path.join(fixture.root, 'main.ts')]);
    expect(() => fixture.fix()).toThrow('Effect fix refused');
  });

  it('keeps draft candidates unverified and preserves explicit upper bounds', () => {
    using fixture = createFixture({
      files: {
        'main.ts': `/** @effects ["network.http(*)"] */ export async function load() { await import('./storage.ts'); }`,
        'storage.ts': `/** @effectsModule ["network.http(*)","localstorage.write(*)"] */ localStorage.clear(); export {};`,
      },
      entries: ['main.ts'],
    });
    const before = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
    const { analysis, rows } = inspect({ fixture });
    expect(rows['main.ts:load']).toEqual(['localstorage.write(*)', 'network.http(*)']);
    applyEffectFix({ root: fixture.root, plan: planUnresolvedEffectFix({ analysis, root: fixture.root, files: ['main.ts', 'storage.ts'], mode: 'fix' }) });
    const after = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
    expect(after).toContain(UNVERIFIED_EFFECT_NOTE);
    expect(after).toContain('/** @effects ["localstorage.write(*)","network.http(*)"] */');
    expect(executableTokens({ source: after, file: 'main.ts' })).toEqual(executableTokens({ source: before, file: 'main.ts' }));
    const repeat = inspect({ fixture }).analysis;
    expect(planUnresolvedEffectFix({ analysis: repeat, root: fixture.root, files: ['main.ts', 'storage.ts'], mode: 'fix' }).edits).toEqual([]);
    expect(() => fixture.fix()).toThrow('Effect fix refused');
  });
});
