import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { executableTokens } from '../fixes/executable.ts';
import { applyEffectFix } from '../fixes/apply.ts';
import { printEffect } from '../contracts/effects.ts';
import { UNVERIFIED_EFFECT_NOTE, planUnresolvedEffectFix, planVerifiedEffectFix, unverifiedEffectNotes } from './unverified.ts';

describe('unverified effect candidates', () => {
  it.each(['', ': PublicView'])('does not publish a returned method\'s captured parameter as a caller parameter: %s', returnType => {
    const source = `\
interface PublicView { start(): void; }
/** @effects [] */
function createRunner({ publish }: { publish: () => void }) {
  return { /** @effects ["call(arg0.publish)"] */ start() { publish(); } };
}
/** @effects [] */
function outer({ generation }: { generation: number })${returnType} {
  const runner = createRunner({ publish: /** @effects [] */ () => {} });
  /** @effects [] */ function start() { runner.start(); }
  return { start };
}
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      const caller = analysis.owners.filter(owner => owner.role === 'implementation' && owner.label === 'start').at(-1)!;
      expect(caller.callbackPaths.has('call(arg0.publish)')).toBe(false);
      expect((analysis.solution.rows.get(caller.id) ?? []).map(effect => printEffect({ effect }))).toContain('call(arg0.publish)');
      expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.start === caller.location.start && item.message.includes('outside its lexical contract'))).toBe(true);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      applyEffectFix({ root: fixture.root, plan });
      const written = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(written).toContain(UNVERIFIED_EFFECT_NOTE);
      expect(written).toContain('/** @effects [] */ function start() { runner.start(); }');
      expect(written).toContain('/** @effects ["call(arg0.publish)"] */ start() { publish(); }');
      const after = fixture.check();
      expect(after.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('outside its lexical contract'))).toBe(true);
      expect(planUnresolvedEffectFix({ analysis: after, root: fixture.root, files: after.coverage.files, mode: 'fix' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps a zero-argument closure\'s genuine outer parameter callback bound', () => {
    const source = `\
interface PublicView { start(): void; }
/** @effects [] */
function outer(_unused: number, { publish }: { publish: () => void }): PublicView {
  /** @effects ["call(arg1.publish)"] */ function start() { publish(); }
  return { start };
}
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      const captured = analysis.owners.find(owner => owner.role === 'implementation' && owner.label === 'start')!;
      expect(captured.callbackPaths.has('call(arg1.publish)')).toBe(true);
      expect(captured.declared.map(effect => printEffect({ effect }))).toEqual(['call(arg1.publish)']);
      expect(analysis.diagnostics.some(item => item.code === 'typescript' || item.code === 'syntax')).toBe(false);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      applyEffectFix({ root: fixture.root, plan });
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('/** @effects ["call(arg1.publish)"] */ function start() { publish(); }');
    } finally {
      fixture.dispose();
    }
  });

  it('does not add header-only warnings to already exempt helpers because another module is unresolved', () => {
    const files = {
      'main.ts': "import { message } from './literal'; import { noop } from './empty'; import { number } from './number'; void message; void noop; void number; unmodeled();",
      'literal.ts': 'export const message = () => "hello";',
      'empty.ts': 'export function noop() {}',
      'number.ts': 'export function number() { return 123; }',
    };
    const fixture = createFixture({ files, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.every(item => item.file === path.join(fixture.root, 'main.ts'))).toBe(true);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits.map(edit => edit.file)).toEqual([path.join(fixture.root, 'main.ts')]);
      applyEffectFix({ root: fixture.root, plan });
      for (const file of ['literal.ts', 'empty.ts', 'number.ts'] as const) expect(fs.readFileSync(path.join(fixture.root, file), 'utf8')).toBe(files[file]);
      const after = fixture.check();
      expect(after.diagnostics.some(item => item.message === UNVERIFIED_EFFECT_NOTE)).toBe(true);
      expect(planUnresolvedEffectFix({ analysis: after, root: fixture.root, files: after.coverage.files, mode: 'fix' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps existing warnings without marking clean implementations that have no dependencies', () => {
    const marked = UNVERIFIED_EFFECT_NOTE + '\nexport const message = () => "hello";';
    const fixture = createFixture({
      files: { 'marked.ts': marked, 'nontrivial.ts': '/** @effects [] */ export function role() { return 1 + 1; }' },
      entries: ['marked.ts', 'nontrivial.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE)).toEqual([]);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits).toEqual([]);
      applyEffectFix({ root: fixture.root, plan });
      expect(fs.readFileSync(path.join(fixture.root, 'marked.ts'), 'utf8')).toBe(marked);
      expect(fs.readFileSync(path.join(fixture.root, 'nontrivial.ts'), 'utf8')).toBe('/** @effects [] */ export function role() { return 1 + 1; }');
    } finally {
      fixture.dispose();
    }
  });

  it('does not add header-only warnings to unchanged formatters and data modules in an unresolved closure', () => {
    const files = {
      'main.ts': `\
import { version } from './version';
import { more } from './more';
import { steps } from './steps';
import { key } from './constants';
void version; void more; void steps; void key;
JSON.stringify(1);
`,
      'version.ts': '/** @effects [] */ export const version = ({ value }: { value: string }): string => `Version ${value}`;',
      'more.ts': '/** @effects [] */ export const more = ({ count }: { count: number }): string => `and ${count} more`;',
      'steps.ts': '/** @effects [] */ export const steps = ({ count }: { count: number }): string => `${count} thinking step${count === 1 ? "" : "s"}`;',
      'constants.ts': 'export const prefix = "app:"; export const key = `${prefix}storage`; export const endpoints = [{ url: "http://localhost:1234" }] as const;',
    };
    const fixture = createFixture({ files, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.length).toBeGreaterThan(0);
      expect(analysis.diagnostics.every(item => item.file === path.join(fixture.root, 'main.ts') && item.code === 'unsupported')).toBe(true);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits.map(edit => path.basename(edit.file))).toEqual(['main.ts']);
      applyEffectFix({ root: fixture.root, plan });
      for (const file of ['version.ts', 'more.ts', 'steps.ts', 'constants.ts'] as const) expect(fs.readFileSync(path.join(fixture.root, file), 'utf8')).toBe(files[file]);
      expect(fixture.check().diagnostics.some(item => item.message === UNVERIFIED_EFFECT_NOTE)).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps warnings on dependency targets even when an unsupported body is diagnosed only in the callee', () => {
    const fixture = createFixture({
      files: {
        'bad.ts': '/** @effects [] */ export function bad() { JSON.stringify(1); }',
        'caller.ts': 'import { bad } from "./bad"; /** @effects [] */ export function caller() { bad(); }',
        'pure.ts': '/** @effects [] */ export function pure() { return 1 + 1; }',
        'pure-caller.ts': 'import { pure } from "./pure"; /** @effects [] */ export function caller() { return pure(); }',
      },
      entries: ['caller.ts', 'pure-caller.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.map(item => ({ file: path.basename(item.file), code: item.code }))).toEqual([{ file: 'bad.ts', code: 'unsupported' }]);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits.map(edit => path.basename(edit.file)).sort()).toEqual(['bad.ts', 'caller.ts', 'pure-caller.ts']);
      expect(plan.edits.every(edit => edit.after === UNVERIFIED_EFFECT_NOTE + '\n' + edit.before)).toBe(true);
      applyEffectFix({ root: fixture.root, plan });
      const after = fixture.check();
      expect(after.diagnostics.filter(item => item.message === UNVERIFIED_EFFECT_NOTE).map(item => path.basename(item.file)).sort()).toEqual(['bad.ts', 'caller.ts', 'pure-caller.ts']);
      expect(after.diagnostics.some(item => item.file === path.join(fixture.root, 'bad.ts') && item.message !== UNVERIFIED_EFFECT_NOTE)).toBe(true);
      expect(planUnresolvedEffectFix({ analysis: after, root: fixture.root, files: after.coverage.files, mode: 'fix' }).edits).toEqual([]);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('keeps warnings for unsupported classes, local diagnostics, new candidates and module I/O', () => {
    const files = {
      'class.ts': 'export class Holder { run() { localStorage.clear(); } }',
      'unsupported.ts': 'export const message = () => "hello"; unmodeled();',
      'writer.ts': 'export function write() { localStorage.clear(); }',
      'module.ts': 'localStorage.clear(); export const message = () => "hello";',
    };
    const fixture = createFixture({ files, entries: Object.keys(files) });
    try {
      const analysis = fixture.check();
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits.map(edit => path.basename(edit.file)).sort()).toEqual(Object.keys(files).sort());
      expect(plan.edits.every(edit => edit.after.startsWith(UNVERIFIED_EFFECT_NOTE))).toBe(true);
      expect(plan.edits.find(edit => path.basename(edit.file) === 'writer.ts')?.after).toContain('/** @effects ["localstorage.write(*)"] */');
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'function entry({ endpoint }: { endpoint: Channel }) { const channel: Channel = { send: () => endpoint.send() }; invoke({ channel }); }',
    'function entry() { const channel: Channel = { send: () => localStorage.clear() }; invoke({ channel }); }',
  ])('does not fix an undeclared shared signature while generating caller candidates: %s', entry => {
    const declaration = 'interface Channel { send(): void; }';
    const source = `\
${declaration}
function invoke({ channel }: { channel: Channel }) { channel.send(); }
${entry}
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
      expect(() => fixture.fix()).toThrow();
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits[0]?.after).toContain(declaration);
      expect(plan.edits[0]?.after).toContain('call(arg0.channel.send)');
      applyEffectFix({ root: fixture.root, plan });
      const after = fixture.check();
      expect(after.owners.find(owner => owner.role === 'signature' && owner.label === 'send')?.annotation).toBeUndefined();
      expect(after.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
      expect(after.diagnostics.some(item => item.code === 'missing' && item.message.includes('send'))).toBe(true);
      expect(after.diagnostics.some(item => item.message === UNVERIFIED_EFFECT_NOTE)).toBe(true);
      expect(planUnresolvedEffectFix({ analysis: after, root: fixture.root, files: after.coverage.files, mode: 'fix' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not publish another owner\'s callback path on a shared signature', () => {
    const source = `\
interface Operations { /** @effects ["network.http(*)"] */ run(): void; }
function create({ callback }: { callback: () => void }): Operations {
  return { run: () => { localStorage.clear(); callback(); } };
}
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
      const signature = analysis.owners.find(owner => owner.role === 'signature' && owner.label === 'run')!;
      expect((analysis.solution.rows.get(signature.id) ?? []).map(effect => printEffect({ effect }))).toContain('call(arg0.callback)');
      expect(signature.callbackPaths.has('call(arg0.callback)')).toBe(false);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits[0]?.after).toContain(UNVERIFIED_EFFECT_NOTE);
      applyEffectFix({ root: fixture.root, plan });
      const after = fixture.check();
      const published = after.owners.find(owner => owner.role === 'signature' && owner.label === 'run')!;
      expect(published.declared.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)', 'network.http(*)']);
      expect(after.owners.some(owner => owner.role === 'implementation' && owner.declared.some(effect => printEffect({ effect }) === 'call(arg0.callback)'))).toBe(true);
      expect(after.diagnostics.some(item => item.code === 'syntax')).toBe(false);
      expect(after.diagnostics.some(item => item.message === UNVERIFIED_EFFECT_NOTE)).toBe(true);
      expect(planUnresolvedEffectFix({ analysis: after, root: fixture.root, files: after.coverage.files, mode: 'fix' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    {
      label: 'a class method materialized by a return type',
      source: `\
class Memory { allocate() { return 1 + 1; } }
function produce(): Memory { throw new Error('Unavailable'); }
function entry({ memory }: { memory: Memory }) { return memory.allocate(); }
`,
      effects: [],
    },
    {
      label: 'an object method',
      source: `\
const memoryPrototype = { allocate() { localStorage.clear(); return 1 + 1; } };
function entry({ memory }: { memory: typeof memoryPrototype }) { return memory.allocate(); }
`,
      effects: ['localstorage.write(*)'],
    },
    {
      label: 'an object arrow',
      source: `\
const memoryPrototype = { allocate: () => { localStorage.clear(); return 1 + 1; } };
function entry({ memory }: { memory: typeof memoryPrototype }) { return memory.allocate(); }
`,
      effects: ['localstorage.write(*)'],
    },
  ])('keeps symbolic caller paths bound while drafting $label', ({ source, effects }) => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      const member = analysis.owners.find(owner => owner.role === 'implementation' && owner.label === 'allocate')!;
      expect(analysis.owners.some(owner => owner.role === 'symbolic' && owner.anchor === member.anchor)).toBe(true);
      expect((analysis.solution.rows.get(member.id) ?? []).map(effect => printEffect({ effect }))).toEqual(effects);
      expect(analysis.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      applyEffectFix({ root: fixture.root, plan });
      const candidate = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(candidate).toContain(UNVERIFIED_EFFECT_NOTE);
      const after = fixture.check();
      const keptMember = after.owners.find(owner => owner.role === 'implementation' && owner.label === 'allocate')!;
      expect(keptMember.annotation).toBeUndefined();
      expect((after.solution.rows.get(keptMember.id) ?? []).map(effect => printEffect({ effect }))).toEqual(effects);
      const entry = after.owners.find(owner => owner.role === 'implementation' && owner.label === 'entry')!;
      expect(entry.declared.map(effect => printEffect({ effect }))).toEqual(['call(arg0.memory.allocate)']);
      expect(after.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
      expect(after.diagnostics.some(item => item.code === 'missing' && item.message.includes('allocate'))).toBe(true);
      expect(after.diagnostics.some(item => item.message === UNVERIFIED_EFFECT_NOTE)).toBe(true);
      expect(planUnresolvedEffectFix({ analysis: after, root: fixture.root, files: after.coverage.files, mode: 'fix' }).edits).toEqual([]);
      expect(() => fixture.fix()).toThrow();
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(candidate);
    } finally {
      fixture.dispose();
    }
  });

  it('still drafts a member that has no symbolic use and can later verify it', () => {
    const fixture = createFixture({
      files: { 'main.ts': 'const operations = { run() { localStorage.clear(); } }; function entry() { operations.run(); }' },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      const member = analysis.owners.find(owner => owner.role === 'implementation' && owner.label === 'run')!;
      expect(analysis.owners.some(owner => owner.role === 'symbolic' && owner.anchor === member.anchor)).toBe(false);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      applyEffectFix({ root: fixture.root, plan });
      const after = fixture.check();
      expect(after.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE)).toEqual([]);
      const drafted = after.owners.find(owner => owner.role === 'implementation' && owner.label === 'run')!;
      expect(drafted.declared.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
      fixture.fix();
      expect(fixture.check().diagnostics).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).not.toContain(UNVERIFIED_EFFECT_NOTE);
    } finally {
      fixture.dispose();
    }
  });

  it('preserves an author member bound while drafting its caller', () => {
    const declaration = '/** @effects ["network.http(*)"] */ allocate() { return 1 + 1; }';
    const fixture = createFixture({
      files: {
        'main.ts': `\
const memoryPrototype = { ${declaration} };
function entry({ memory }: { memory: typeof memoryPrototype }) { return memory.allocate(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      applyEffectFix({ root: fixture.root, plan });
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain(declaration);
      const after = fixture.check();
      expect(after.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE)).toEqual([]);
      const entry = after.owners.find(owner => owner.role === 'implementation' && owner.label === 'entry')!;
      expect(entry.declared.map(effect => printEffect({ effect }))).toEqual(['network.http(*)']);
    } finally {
      fixture.dispose();
    }
  });

  it('writes known effects beside an explicit file warning without pretending unknown calls are pure', () => {
    const fixture = createFixture({ files: { 'main.ts': 'function run() { localStorage.clear(); unmodeled(); }' }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      const edit = plan.edits[0]!;
      expect(edit.after.startsWith(UNVERIFIED_EFFECT_NOTE + '\n')).toBe(true);
      expect(edit.after).toContain('/** @effects ["localstorage.write(*)"] */');
      expect(executableTokens({ source: edit.after, file: edit.file })).toBe(executableTokens({ source: edit.before, file: edit.file }));
      applyEffectFix({ root: fixture.root, plan });
      const repeat = fixture.check();
      expect(planUnresolvedEffectFix({ analysis: repeat, root: fixture.root, files: repeat.coverage.files, mode: 'fix' }).edits).toEqual([]);
      expect(() => planVerifiedEffectFix({ analysis: repeat, root: fixture.root })).toThrow('refused');
    } finally {
      fixture.dispose();
    }
  });

  it('marks files without any writable function owner', () => {
    const fixture = createFixture({ files: { 'main.ts': 'unmodeled();' }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits[0]?.after).toBe(UNVERIFIED_EFFECT_NOTE + '\nunmodeled();');
    } finally {
      fixture.dispose();
    }
  });

  it('retains declared bounds and unsafe reasons while draft tidy removes only existing trivial empty annotations', () => {
    const unsafe = '/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Reviewed write boundary."} */';
    const source = `\
/** @effects ["network.http(*)"] */ function future() {}
/** @effects [] */ const noop = () => {};
/** @effects [] */ function nontrivial() { return 1 + 1; }
/** @effects [] */
${unsafe}
function hidden() { localStorage.clear(); }
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'tidy' });
      const after = plan.edits[0]!.after;
      expect(after).toContain('/** @effects ["network.http(*)"] */ function future() {}');
      expect(after).not.toContain('/** @effects [] */ const noop');
      expect(after).toContain('/** @effects [] */ function nontrivial()');
      expect(after).toContain(unsafe);
      expect(after).toContain('/** @effects [] */\n' + unsafe);
      expect(executableTokens({ source: after, file: 'main.ts' })).toBe(executableTokens({ source, file: 'main.ts' }));
    } finally {
      fixture.dispose();
    }
  });

  it('clears the note only when a normal fix can verify every remaining diagnostic', () => {
    const fixture = createFixture({ files: { 'main.ts': UNVERIFIED_EFFECT_NOTE + '\nfunction run() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      const plan = planVerifiedEffectFix({ analysis, root: fixture.root });
      expect(plan.edits[0]?.after).not.toContain(UNVERIFIED_EFFECT_NOTE);
      expect(plan.edits[0]?.after).toContain('/** @effects ["localstorage.write(*)"] */');
      applyEffectFix({ root: fixture.root, plan });
      expect(fixture.check().diagnostics).toEqual([]);
      expect(planVerifiedEffectFix({ analysis: fixture.check(), root: fixture.root }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('recognizes only the exact header comment, preserving identical text in strings and other TODOs', () => {
    expect(unverifiedEffectNotes({ source: 'const text = ' + JSON.stringify(UNVERIFIED_EFFECT_NOTE) + ';' })).toEqual([]);
    expect(unverifiedEffectNotes({
      source: `\
// TODO(effects): Something else.
function run() {}`,
    })).toEqual([]);
    expect(unverifiedEffectNotes({ source: 'function run() {}\n' + UNVERIFIED_EFFECT_NOTE })).toEqual([]);
    expect(unverifiedEffectNotes({ source: '\uFEFF#!/usr/bin/env node\r\n' + UNVERIFIED_EFFECT_NOTE + '\r\n' })).toHaveLength(1);
    const source = '#!/usr/bin/env node\r\n' + UNVERIFIED_EFFECT_NOTE + '\r\n' + UNVERIFIED_EFFECT_NOTE + '\r\nfunction run() {}';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      const after = plan.edits[0]!.after;
      expect(after.startsWith('#!/usr/bin/env node\r\n' + UNVERIFIED_EFFECT_NOTE + '\r\n')).toBe(true);
      expect(unverifiedEffectNotes({ source: after })).toHaveLength(1);
      expect(executableTokens({ source: after, file: 'main.ts' })).toBe(executableTokens({ source, file: 'main.ts' }));
    } finally {
      fixture.dispose();
    }
  });

  it('edits only explicitly selected analyzed application sources', () => {
    const fixture = createFixture({ files: { 'main.ts': "import { save } from './dep'; function run() { save(); }", 'dep.ts': 'export function save() { localStorage.clear(); }', 'outside.ts': 'function other() {}', 'ambient.d.ts': 'declare function external(): void;' }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      const main = path.join(fixture.root, 'main.ts');
      const outside = path.join(fixture.root, 'outside.ts');
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: [main, outside, path.join(fixture.root, 'ambient.d.ts')], mode: 'fix' });
      expect(plan.edits.map(edit => edit.file)).toEqual([main]);
      expect(fs.readFileSync(outside, 'utf8')).toBe('function other() {}');
    } finally {
      fixture.dispose();
    }
  });

  it('keeps malformed annotations untouched and adds only one header note', () => {
    const source = '/** @effects [broken] */ function run() { localStorage.clear(); }';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.some(item => item.code === 'syntax')).toBe(true);
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits[0]?.after).toBe(UNVERIFIED_EFFECT_NOTE + '\n' + source);
      applyEffectFix({ root: fixture.root, plan });
      const repeat = fixture.check();
      expect(planUnresolvedEffectFix({ analysis: repeat, root: fixture.root, files: repeat.coverage.files, mode: 'fix' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });
});
