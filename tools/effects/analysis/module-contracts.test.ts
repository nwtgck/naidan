import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';
import { applyEffectFix } from '../fixes/apply.ts';
import { executableTokens } from '../fixes/executable.ts';
import { planUnresolvedEffectFix, UNVERIFIED_EFFECT_NOTE } from '../maintenance/unverified.ts';
import { runEffectTidy } from '../maintenance/tidy.ts';
import { readModuleAnnotation } from '../syntax/annotations.ts';
import { digest } from '../project.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../models/registry.ts';

function moduleRows({ fixture }: { fixture: ReturnType<typeof createFixture> }) {
  const analysis = fixture.check();
  return Object.fromEntries(analysis.owners.filter(owner => owner.role === 'module').map(owner => [
    path.relative(fixture.root, owner.location.file),
    (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })),
  ]));
}

describe('module initialization contracts', () => {
  it('requires nonempty module bounds and widens explicit bounds transitively through cycles', () => {
    const fixture = createFixture({
      files: {
        'main.ts': '/** @effectsModule [] */ import "./a"; export { value } from "./b";',
        'a.ts': 'import "./b"; localStorage.clear();',
        'b.ts': 'import "./a"; export const value = 0;',
      },
      entries: ['main.ts'],
    });
    try {
      expect(moduleRows({ fixture })).toEqual({ 'main.ts': ['localstorage.write(*)'], 'a.ts': ['localstorage.write(*)'], 'b.ts': ['localstorage.write(*)'] });
      expect(fixture.check().diagnostics.filter(item => item.code === 'missing')).toHaveLength(2);
      fixture.fix();
      expect(fixture.check().diagnostics).toEqual([]);
      for (const file of ['main.ts', 'a.ts', 'b.ts']) expect(fs.readFileSync(path.join(fixture.root, file), 'utf8')).toContain('/** @effectsModule ["localstorage.write(*)"] */');
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('leaves empty modules unannotated and does not invoke an imported function definition', () => {
    const fixture = createFixture({ files: { 'main.ts': 'import { save } from "./storage"; export { save };', 'storage.ts': '/** @effects ["localstorage.write(*)"] */ export function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      expect(moduleRows({ fixture })).toEqual({ 'main.ts': [], 'storage.ts': [] });
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    { statement: 'import type { Marker } from "./storage"; export type Result = Marker;', effect: false },
    { statement: 'export type { Marker } from "./storage";', effect: false },
    { statement: 'import { type Marker } from "./storage"; export type Result = Marker;', effect: true },
    { statement: 'export { type Marker } from "./storage";', effect: true },
  ])('follows emitted runtime edges for $statement', ({ statement, effect }) => {
    const fixture = createFixture({ files: { 'main.ts': statement, 'storage.ts': '/** @effectsModule ["sessionstorage.write(*)"] */ sessionStorage.clear(); export type Marker = string;' }, entries: ['main.ts'] });
    try {
      const config = path.join(fixture.root, 'tsconfig.json');
      const value = JSON.parse(fs.readFileSync(config, 'utf8')) as { compilerOptions: { verbatimModuleSyntax?: boolean } };
      value.compilerOptions.verbatimModuleSyntax = true;
      fs.writeFileSync(config, JSON.stringify(value));
      expect(moduleRows({ fixture })['main.ts']).toEqual(effect ? ['sessionstorage.write(*)'] : []);
    } finally {
      fixture.dispose();
    }
  });

  it.each(['import { value } from "./external";', 'export { value } from "./external";'])('retains unknown initialization at %s', statement => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effectsModule [] */ ' + statement, 'external.d.ts': 'export declare const value: number;' }, entries: ['main.ts'] });
    fixture.config.models = [{ file: 'external.d.ts', export: 'value', effects: [], returnValue: 'scalar-value', sha256: digest({ content: 'export declare const value: number;' }) }];
    try {
      expect(fixture.check().diagnostics).toEqual([expect.objectContaining({ code: 'unsupported', message: expect.stringContaining('Runtime import initialization') })]);
      expect(() => fixture.fix()).toThrow('Effect fix refused');
      const analysis = fixture.check();
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: ['main.ts'], mode: 'fix' });
      expect(plan.edits[0]?.after).toContain(UNVERIFIED_EFFECT_NOTE);
      expect(plan.edits[0]?.after).toContain('/** @effectsModule [] */');
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    '/** @effectsModule [] */ /** @effectsModule [] */ export const value = 0;',
    '/** @effectsModule ["call(arg0.run)"] */ export const value = 0;',
    'export const value = 0; /** @effectsModule [] */',
    'function value() { /** @effectsModule [] */ }',
    'function value() { return; /** @effectsModule [] */ }',
    'const value = { /** @effectsModule [] */ };',
    '/** @effectsModule {"effects":[]} */ export const value = 0;',
  ])('rejects duplicate, misplaced or invalid module metadata: %s', source => {
    const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
    expect(() => readModuleAnnotation({ source: file, definitions: DEFAULT_EFFECT_DEFINITIONS })).toThrow();
  });

  it('ignores module directive examples in strings and templates', () => {
    const source = ts.createSourceFile('main.ts', 'const text = "/** @effectsModule [] */"; const template = `value ${text} /** @effectsModule [] */`;', ts.ScriptTarget.Latest, true);
    expect(readModuleAnnotation({ source, definitions: DEFAULT_EFFECT_DEFINITIONS })).toBeUndefined();
  });

  it.each([
    'function send() { localStorage.clear(); } send();',
    '/** @effects [] */ function send() { localStorage.clear(); } send();',
    `\
/** Author explanation. */
// eslint-disable-next-line local-rule/example
function send() { localStorage.clear(); } send();`,
    `\
#!/usr/bin/env node
/// <reference lib="dom" />
"use strict";
function send() { localStorage.clear(); } send();`,
    '\uFEFFfunction send() { localStorage.clear(); } send();',
    ['function send() { localStorage.clear(); }', 'send();', ''].join(String.fromCharCode(13, 10)),
  ])('adds independent file and first callable bounds without changing tokens: %s', before => {
    const fixture = createFixture({ files: { 'main.ts': before }, entries: ['main.ts'] });
    try {
      fixture.fix();
      const after = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(after).toContain('/** @effectsModule ["localstorage.write(*)"] */');
      expect(after).toContain('/** @effects ["localstorage.write(*)"] */');
      expect(executableTokens({ source: after, file: 'main.ts' })).toBe(executableTokens({ source: before, file: 'main.ts' }));
      if (before.includes(String.fromCharCode(13, 10))) expect(after).toContain(String.fromCharCode(13, 10));
      if (before.startsWith('#!')) expect(after.startsWith(`\
#!/usr/bin/env node
/** @effectsModule`)).toBe(true);
      if (before.startsWith('\uFEFF')) expect(after.startsWith('\uFEFF/** @effectsModule')).toBe(true);
      if (before.includes('eslint-disable-next-line')) expect(after).toContain(`\
// eslint-disable-next-line local-rule/example
function send`);
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('narrows selected module declarations while preserving explicit empty bounds', () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effectsModule ["network.http(*)","localstorage.write(*)"] */ localStorage.clear();', 'empty.ts': '/** @effectsModule ["network.http(*)"] */ export const value = 0;' }, entries: ['main.ts', 'empty.ts'] });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      const result = runEffectTidy({ root: fixture.root, config: fixture.config, files: ['main.ts', 'empty.ts'], write: 'write', inputSnapshots: new Map() });
      expect(result.changes).toHaveLength(2);
      expect(fs.readFileSync(path.join(fixture.root, 'empty.ts'), 'utf8')).toContain('/** @effectsModule [] */');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('/** @effectsModule ["localstorage.write(*)"] */');
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(runEffectTidy({ root: fixture.root, config: fixture.config, files: ['main.ts', 'empty.ts'], write: 'preview', inputSnapshots: new Map() }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('retains author module bounds and warnings during repeated candidate fix and tidy', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effectsModule ["network.http(*)"] */
function send() { localStorage.clear(); unmodeled(); } send();`,
      },
      entries: ['main.ts'],
    });
    try {
      let analysis = fixture.check();
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: ['main.ts'], mode: 'fix' });
      applyEffectFix({ root: fixture.root, plan });
      const after = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(after).toContain('/** @effectsModule ["localstorage.write(*)","network.http(*)"] */');
      expect(after).toContain('/** @effects ["localstorage.write(*)"] */');
      expect(after.startsWith(UNVERIFIED_EFFECT_NOTE)).toBe(true);
      analysis = fixture.check();
      expect(planUnresolvedEffectFix({ analysis, root: fixture.root, files: ['main.ts'], mode: 'fix' }).edits).toEqual([]);
      expect(planUnresolvedEffectFix({ analysis, root: fixture.root, files: ['main.ts'], mode: 'tidy' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps an unselected dependency module bound fixed during tidy', () => {
    const fixture = createFixture({
      files: {
        'main.ts': '/** @effectsModule ["network.http(*)","localstorage.write(*)"] */ import "./dep";',
        'dep.ts': '/** @effectsModule ["network.http(*)","localstorage.write(*)"] */ localStorage.clear();',
      },
      entries: ['main.ts'],
    });
    try {
      expect(runEffectTidy({ root: fixture.root, config: fixture.config, files: ['main.ts'], write: 'preview', inputSnapshots: new Map() }).edits).toEqual([]);
      expect(runEffectTidy({ root: fixture.root, config: fixture.config, files: ['main.ts', 'dep.ts'], write: 'write', inputSnapshots: new Map() }).changes).toHaveLength(2);
      expect(moduleRows({ fixture })).toEqual({ 'main.ts': ['localstorage.write(*)'], 'dep.ts': ['localstorage.write(*)'] });
    } finally {
      fixture.dispose();
    }
  });

  it('co-locates new module and callable candidates with one persistent warning', () => {
    const fixture = createFixture({ files: { 'main.ts': 'function send() { localStorage.clear(); unmodeled(); } send();' }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      applyEffectFix({ root: fixture.root, plan: planUnresolvedEffectFix({ analysis, root: fixture.root, files: ['main.ts'], mode: 'fix' }) });
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(UNVERIFIED_EFFECT_NOTE + `\

/** @effectsModule ["localstorage.write(*)"] */
/** @effects ["localstorage.write(*)"] */
function send() { localStorage.clear(); unmodeled(); } send();`);
      const repeat = fixture.check();
      expect(planUnresolvedEffectFix({ analysis: repeat, root: fixture.root, files: ['main.ts'], mode: 'fix' }).edits).toEqual([]);
      expect(planUnresolvedEffectFix({ analysis: repeat, root: fixture.root, files: ['main.ts'], mode: 'tidy' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('retains the unchecked boundary while propagating a known dynamic module body', () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effectsModule [] */ /** @effects [] */ export async function load() { await import("./storage"); }', 'storage.ts': 'localStorage.clear(); export {};' }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Dynamic import loading'))).toBe(true);
      expect(analysis.coverage.files).toEqual([path.join(fixture.root, 'main.ts'), path.join(fixture.root, 'storage.ts')]);
      const load = analysis.owners.find(owner => owner.label === 'load')!;
      expect(analysis.solution.rows.get(load.id)?.map(effect => printEffect({ effect }))).toContain('localstorage.write(*)');
      expect(() => fixture.fix()).toThrow('Effect fix refused');
    } finally {
      fixture.dispose();
    }
  });
});
