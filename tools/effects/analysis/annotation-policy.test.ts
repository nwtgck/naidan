import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';
import { planEffectFix } from '../fixes/plan.ts';
import { planUnresolvedEffectFix } from '../maintenance/unverified.ts';
import { mayOmitEffectAnnotation } from './annotation-policy.ts';

describe('implicit empty bounds for trivial function implementations', () => {
  it('checks trivial arrows and ordinary functions without adding comments', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
function noop() {}
const expression = function () {};
const empty = () => {};
const number = () => 123;
const string = () => 'ready';
const boolean = () => true;
const bigint = () => 1n;
const missing = () => void 0;
const nullValue = () => null;
const template = () => \`ready\`;
const block = () => { return 'ready'; };
function literal() { return 123; }
`,
      },
      entries: ['main.ts'],
    });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).not.toContain('@effects');
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'const callback = ({ value = localStorage.clear() }: { value?: void }) => {};',
    'const callback = (value: string) => value;',
    'const callback = () => String("ready");',
    'const callback = () => { const value = "ready"; return value; };',
    'const callback = () => undefined;',
    'const api = { callback() {} };',
    'function* generator() {}',
  ])('still requires a contract outside the narrow trivial subset: %s', source => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      expect(fixture.check().diagnostics.some(item => item.code === 'missing')).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('does not treat a shadowed undefined value as a fixed primitive', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */ function factory({ undefined }: { undefined: () => void }) {
  return () => undefined;
}
`,
      },
      entries: ['main.ts'],
    });
    try {
      expect(fixture.check().diagnostics.some(item => item.code === 'missing' && item.message.includes('<anonymous>'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps callable type signatures explicit', () => {
    const fixture = createFixture({ files: { 'main.ts': 'type Callback = () => void; const callback: Callback = () => {};' }, entries: ['main.ts'] });
    try {
      expect(fixture.check().diagnostics.some(item => item.code === 'missing')).toBe(true);
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toMatch(/\/\*\* @effects \[\] \*\/\s+type Callback/);
    } finally {
      fixture.dispose();
    }
  });

  it('preserves explicit annotations on trivial implementations', () => {
    const source = '/** @effects ["localstorage.write(*)"] */ const callback = () => {}; /** @effects [] */ function noop() {}';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('requires widening a stored empty function before assigning a writer', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects ["localstorage.write(*)"] */ function writer() { localStorage.clear(); }
const actions = { run: () => {} };
/** @effects [] */ function install() { actions.run = writer; }
/** @effects [] */ function execute() { actions.run(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'exceeds' && item.message.includes('localstorage.write(*)'))).toBe(true);
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      const source = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(source).toContain('/** @effects ["localstorage.write(*)"] */ run: () => {}');
      expect(source).toContain('/** @effects [] */ function install()');
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each(['en', 'ja', 'zh-Hans', 'pt-BR', 'es', 'ko', 'de'])('omits only the exact message implementation in the %s locale', locale => {
    const file = `src/strings/messages/TestLabel__text/${locale}.ts`;
    const fixture = createFixture({
      files: { [file]: 'export const TestLabel__text = ({ name }: { name: string }): string => `Hello ${name}`;' },
      entries: [file],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      const message = analysis.owners.find(owner => owner.label === 'TestLabel__text' && owner.role === 'implementation')!;
      expect(message.parameterBoundary).toBe('boundary-string');
      expect(mayOmitEffectAnnotation({ owner: message })).toBe(true);
      expect(analysis.owners.filter(owner => owner.role !== 'implementation').every(owner => !mayOmitEffectAnnotation({ owner }))).toBe(true);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'export const TestLabel__text = ({ "display-name": name }: { "display-name": string | undefined }): string => `Hello ${(name)}`;',
    'export const TestLabel__text = ({ 1: count, flag }: { 1: number; flag: boolean }): string => `${count} / ${flag}`;',
    'export function TestLabel__text({ mode }: { mode: "a" | "b" }) { return `Mode ${mode}`; }',
  ])('accepts static primitive bindings and a single return: %s', source => {
    const file = 'src/strings/messages/TestLabel__text/en.ts';
    const fixture = createFixture({ files: { [file]: source }, entries: [file] });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'export const TestLabel__text = ({ count }: { count: number }): string => `${count.toLocaleString()}`;',
    'export const TestLabel__text = ({ user }: { user: { name: string } }): string => `${user.name}`;',
    'export const TestLabel__text = ({ name = "ready" }: { name?: string }): string => `Hello ${name}`;',
    'export const TestLabel__text = ({ name }: { name: string } = { name: "ready" }): string => `Hello ${name}`;',
    'export const TestLabel__text = ({ count }: { count: number }): string => `${count === 1 ? "item" : "items"}`;',
    'export const TestLabel__text = ({ name }: { name: string | undefined }): string => `${name ?? "ready"}`;',
    'export const TestLabel__text = ({ count }: { count: number }): string => `${count + 1}`;',
    'export const TestLabel__text = ({ name }: { name: string }): string => name;',
    'export const TestLabel__text = ({ name }: { name: string }): string => "ready";',
    'export const TestLabel__text = ({ name }: { name: string }) => {};',
    'export const TestLabel__text = ({ name }: { name: string }): string => `${name as string}`;',
    'const captured = "ready"; export const TestLabel__text = ({ name }: { name: string }): string => `${captured}`;',
    'export const TestLabel__text = ({ name }: { name: string }): string => `${`Hello ${name}`}`;',
    'export const TestLabel__text = ({ name }: { name: string }): string => `${1}`;',
    'export const TestLabel__text = ({ name }: { name: string }): string => { const prefix = "Hello"; return `${name}`; };',
    'export const TestLabel__text = ({ value }: { value: Date }): string => `${value}`;',
    'type Args = { name: string }; export const TestLabel__text = ({ name }: Args): string => `${name}`;',
    'export const TestLabel__text: ({ name }: { name: string }) => string = ({ name }) => `${name}`;',
    'export const TestLabel__text = async ({ name }: { name: string }): Promise<string> => `${name}`;',
    'export function* TestLabel__text({ name }: { name: string }) { yield `${name}`; }',
    'export const TestLabel__text = <T>({ name }: { name: string }): string => `${name}`;',
    'export default function TestLabel__text({ name }: { name: string }): string { return `${name}`; }',
  ])('keeps annotations required beyond direct primitive template interpolation: %s', source => {
    const file = 'src/strings/messages/TestLabel__text/en.ts';
    const fixture = createFixture({ files: { [file]: source }, entries: [file] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(analysis.diagnostics.some(item => item.code === 'missing')).toBe(true);
      const message = analysis.owners.find(owner => owner.label === 'TestLabel__text' && owner.role === 'implementation');
      if (message !== undefined) expect(mayOmitEffectAnnotation({ owner: message })).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'source.ts',
    'src/strings/messages-old/TestLabel__text/en.ts',
    'src/strings/messages/nested/TestLabel__text/en.ts',
    'src/strings/messages/TestLabel__text/en-US.ts',
  ])('does not grant the Strings boundary to a lookalike path: %s', file => {
    const source = 'export const TestLabel__text = ({ name }: { name: string }): string => `Hello ${name}`;';
    const fixture = createFixture({ files: { [file]: source }, entries: [file] });
    try {
      const analysis = fixture.check();
      const message = analysis.owners.find(owner => owner.label === 'TestLabel__text' && owner.role === 'implementation')!;
      expect(message.parameterBoundary).toBeUndefined();
      expect(analysis.diagnostics.some(item => item.code === 'missing')).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('does not grant a message boundary to other helpers in the same module', () => {
    const file = 'src/strings/messages/TestLabel__text/en.ts';
    const fixture = createFixture({
      files: { [file]: 'export const TestLabel__text = ({ name }: { name: string }): string => `Hello ${name}`; function helper({ name }: { name: string }) { return `${name}`; }' },
      entries: [file],
    });
    try {
      const analysis = fixture.check();
      const helper = analysis.owners.find(owner => owner.label === 'helper' && owner.role === 'implementation')!;
      expect(helper.parameterBoundary).toBeUndefined();
      expect(analysis.diagnostics.some(item => item.code === 'missing' && item.message.includes('helper'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps eligibility stable under a type budget cutoff without hiding unresolved diagnostics', () => {
    const file = 'src/strings/messages/TestLabel__text/en.ts';
    const pressure = Array.from({ length: 16 }, (_, index) => `const value${index}: number = ${index};`).join('\n');
    const fixture = createFixture({ files: { [file]: pressure + '\nexport const TestLabel__text = ({ name }: { name: string }): string => `Hello ${name}`;' }, entries: [file] });
    try {
      const high = fixture.check();
      expect(high.diagnostics).toEqual([]);
      fixture.config.analysisBudget = 4;
      const low = fixture.check();
      for (const analysis of [low, high]) {
        const message = analysis.owners.find(owner => owner.label === 'TestLabel__text' && owner.role === 'implementation')!;
        expect(mayOmitEffectAnnotation({ owner: message })).toBe(true);
        expect(analysis.diagnostics.some(item => item.code === 'missing' && item.message.includes('TestLabel__text'))).toBe(false);
      }
      expect(low.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('analysis budget'))).toBe(true);
      expect(() => planEffectFix({ analysis: low })).toThrow();
      const draft = planUnresolvedEffectFix({ analysis: low, root: fixture.root, files: low.coverage.files, mode: 'fix' });
      expect(draft.edits.some(edit => edit.after.includes('UNVERIFIED effect candidates'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('retains caller effects and rejects getter argument objects', () => {
    const file = 'src/strings/messages/TestLabel__text/en.ts';
    const fixture = createFixture({
      files: {
        [file]: `\
export const TestLabel__text = ({ name }: { name: string }): string => ` + '`Hello ${name}`' + `;
/** @effects [] */ function caller() { TestLabel__text({ name: (localStorage.clear(), "ready") }); }
TestLabel__text({ get name() { localStorage.clear(); return "ready"; } });
`,
      },
      entries: [file],
    });
    try {
      const analysis = fixture.check();
      const caller = analysis.owners.find(owner => owner.label === 'caller' && owner.role === 'implementation')!;
      expect(analysis.solution.rows.get(caller.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
      expect(analysis.diagnostics.some(item => item.code === 'exceeds' && item.message.includes('caller'))).toBe(true);
      expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('accessors'))).toBe(true);
      expect(() => planEffectFix({ analysis })).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('preserves author bounds in widening fixes and only removes redundant empty message annotations in draft tidy', () => {
    const file = 'src/strings/messages/TestLabel__text/en.ts';
    const empty = '/** @effects [] */ export const TestLabel__text = ({ name }: { name: string }): string => `Hello ${name}`;';
    const fixture = createFixture({ files: { [file]: empty }, entries: [file] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
      const tidy = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'tidy' });
      expect(tidy.edits).toHaveLength(1);
      expect(tidy.edits[0]!.after).not.toContain('@effects');
      const wide = empty.replace('@effects []', '@effects ["network.http(*)"]');
      fs.writeFileSync(path.join(fixture.root, file), wide);
      const broad = fixture.check();
      expect(broad.diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(planUnresolvedEffectFix({ analysis: broad, root: fixture.root, files: broad.coverage.files, mode: 'tidy' }).edits).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, file), 'utf8')).toBe(wide);
    } finally {
      fixture.dispose();
    }
  });
});
