import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { vueFixture as fixtureFor, checkVueSource as check } from '../../test-support/vue-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';
import type { EffectsAnalysis } from '../../analysis/analyze.ts';

function row({ analysis, label }: { analysis: EffectsAnalysis, label: string }): readonly string[] {
  const owner = analysis.owners.find(item => item.label === label && item.role !== 'module');
  expect(owner, label).toBeDefined();
  return (analysis.solution.rows.get(owner!.id) ?? []).map(effect => printEffect({ effect }));
}

function supported({ analysis }: { analysis: EffectsAnalysis }): void {
  expect(analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
}

describe('reviewed Vue boundaries', () => {
  it.each(['ref', 'shallowRef'])('checks %s scalar updates without inventing storage effects', ref => {
    const analysis = check({
      source: `\
const name = ${ref}('');
function setName({ value }: { value: string }) { name.value = value; }
function getName() { return name.value; }
watch(name, value => { localStorage.setItem('name', value); });
`,
    });
    supported({ analysis });
    expect(row({ analysis, label: 'setName' })).toEqual([]);
    expect(row({ analysis, label: 'getName' })).toEqual([]);
    expect(analysis.owners.filter(owner => owner.label === '<anonymous>').some(owner => analysis.solution.rows.get(owner.id)?.some(effect => printEffect({ effect }) === 'localstorage.write(*)'))).toBe(true);
  });

  it.each(['pre', 'post', 'sync'])('does not back-propagate a %s watcher through state writes', flush => {
    const analysis = check({
      source: `\
const count = ref(0);
function setCount() { count.value = 1; }
function entry() { setCount(); }
watch(count, value => { localStorage.setItem('n', String(value)); }, { flush: '${flush}', immediate: true });
`,
    });
    supported({ analysis }); expect(row({ analysis, label: 'entry' })).toEqual([]);
  });

  it('retains a contract when the callback is called explicitly as well', () => {
    const analysis = check({
      source: `\
const name = ref('');
function save(value: string) { localStorage.setItem('name', value); }
function install() { watch(name, save); }
function setName() { name.value = 'x'; }
function direct() { save('x'); }
`,
    });
    supported({ analysis });
    expect(row({ analysis, label: 'install' })).toEqual(['localstorage.write(*)']);
    expect(row({ analysis, label: 'direct' })).toEqual(['localstorage.write(*)']);
    expect(row({ analysis, label: 'setName' })).toEqual([]);
  });

  it('includes getter source calls without scanning all reactive subscribers', () => {
    const analysis = check({
      source: `\
function source() { return localStorage.getItem('x') ?? ''; }
function install() { watch(source, value => { sessionStorage.setItem('x', value); }); }
`,
    });
    supported({ analysis });
    expect(row({ analysis, label: 'install' })).toEqual(['localstorage.read(*)', 'sessionstorage.write(*)']);
  });

  it.each(['watchEffect', 'watchSyncEffect', 'watchPostEffect'])('keeps %s callback effects', name => {
    const analysis = check({ source: `function register() { ${name}(() => { localStorage.clear(); }); }` });
    supported({ analysis }); expect(row({ analysis, label: 'register' })).toEqual(['localstorage.write(*)']);
  });

  it.each(['onMounted', 'onUnmounted', 'onScopeDispose'])('keeps %s lifecycle callback effects', name => {
    const analysis = check({ source: `function register() { ${name}(() => { localStorage.clear(); }); }` });
    supported({ analysis }); expect(row({ analysis, label: 'register' })).toEqual(['localstorage.write(*)']);
  });

  it.each(['stop', 'resume'])('retains cleanup upper bounds through handle.%s', member => {
    const analysis = check({
      source: `\
const name = ref('');
const handle = watch(name, value => { onWatcherCleanup(() => { localStorage.setItem('x', value); }); });
function control() { handle.${member}(); }
`,
    });
    supported({ analysis }); expect(row({ analysis, label: 'control' })).toEqual(['localstorage.write(*)']);
  });

  it('handles direct stop and pause without dropping or inventing callback contracts', () => {
    const analysis = check({
      source: `\
const stop = watchEffect(() => { localStorage.clear(); });
function control() { stop(); }
function pause() { stop.pause(); }
`,
    });
    supported({ analysis });
    expect(row({ analysis, label: 'control' })).toEqual([]);
    expect(row({ analysis, label: 'pause' })).toEqual([]);
  });

  it('checks unused callbacks and fixes once without changing the state setter', () => {
    const fixture = fixtureFor({
      source: `\
const name = ref('');
function setName({ value }: { value: string }) { name.value = value; }
watch(name, value => { localStorage.setItem('name', value); });
`,
      extra: {},
    });
    try {
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      expect(result.changedFiles).toEqual([path.join(fixture.root, 'main.ts')]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain(`\
/** @effects [] */
function setName`);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('retains scalar ref provenance through a typed const alias', () => {
    const analysis = check({ source: `const original = ref(''); const alias: Ref<string> = original; function set() { alias.value = 'x'; }` });
    supported({ analysis }); expect(row({ analysis, label: 'set' })).toEqual([]);
  });

  it('resolves renamed exports and a namespace through declaration identity', () => {
    const fixture = fixtureFor({
      source: `\
import { ref as makeState } from './barrel';
import * as framework from './framework';
const state = makeState(0);
function set() { state.value = 3; }
framework.watch(state, () => { localStorage.clear(); });
`,
      extra: { 'barrel.ts': "export { ref } from './framework';" },
    });
    try {
      const analysis = fixture.check();
      const unknown = analysis.diagnostics.filter(item => item.message.startsWith('Runtime import initialization'));
      expect(unknown).toHaveLength(2); // namespace import and barrel reexport
      expect(unknown.every(item => item.code === 'unsupported')).toBe(true);
      supported({ analysis: { ...analysis, diagnostics: analysis.diagnostics.filter(item => !unknown.includes(item)) } });
      expect(row({ analysis, label: 'set' })).toEqual([]);
      expect(() => fixture.fix()).toThrow('Effect fix refused');
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'const state = ref({ count: 0 });',
    'const state = shallowRef(() => { localStorage.clear(); });',
    "function read({ state }: { state: Ref<string> }) { return state.value; }",
    "const state = customRef(() => ({ get: () => '', set: () => { localStorage.clear(); } }));",
    "const state = ref(''); watch(state, () => {}, { onTrigger: () => { localStorage.clear(); } });",
    "const state = ref(''); watch(state, (value, old, onCleanup) => { onCleanup(() => { localStorage.clear(); }); });",
    "const state = ref(''); watchEffect(onCleanup => { onCleanup(() => { localStorage.clear(); }); });",
    "const state = ref(''); const handle = watch(state, () => {}); const alias: () => void = handle;",
    "const state = ref(''); function replace({ custom }: { custom: Ref<string> }) { state = custom; }",
    "function install({ callback }: { callback: () => void }) { onMounted(callback); }",
  ])('rejects an unsupported boundary instead of assuming purity: %s', source => {
    const result = check({ source });
    expect(result.diagnostics.some(item => item.code === 'unsupported' || item.code === 'boundary')).toBe(true);
  });

  it('does not accept a different module merely named ref', () => {
    const fixture = fixtureFor({
      source: `\
import { ref as fake } from './unmodeled';
const state = fake(0);
`,
      extra: { 'unmodeled.d.ts': 'export declare function ref(value: number): number;' },
    });
    try {
      expect(fixture.check().diagnostics.some(item => item.code === 'boundary')).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('invalidates a changed reviewed declaration before fixing', () => {
    const fixture = fixtureFor({ source: 'const state = ref(0);', extra: {} });
    try {
      fs.appendFileSync(path.join(fixture.root, 'framework.d.ts'), '\n// changed');
      expect(() => fixture.fix()).toThrow('Reviewed effect model changed');
    } finally {
      fixture.dispose();
    }
  });

  it('keeps ordinary test callbacks outside effect annotation and fix scope', () => {
    const fixture = fixtureFor({ source: 'const state = ref(0);', extra: { 'case.test.ts': 'const callback = () => localStorage.clear();' } });
    fixture.config.files = ['main.ts', 'case.test.ts'];
    try {
      expect(fixture.fix().changedFiles.some(file => file.endsWith('.test.ts'))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });
});
