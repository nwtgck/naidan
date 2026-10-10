import vm from 'node:vm';
import ts from 'typescript';
import * as Vue from 'vue';
import { describe, expect, it } from 'vitest';
import { checkVueSource } from '../../test-support/vue-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';

function execute({ source }: { source: string }) {
  let writes = 0;
  const exports: Record<string, unknown> = {};
  const context = vm.createContext({
    exports,
    require(name: string) {
      if (name !== './framework') throw new Error(`Unexpected runtime dependency: ${name}`);
      return Vue;
    },
    sessionStorage: {
      clear() {
        writes++;
      },
      setItem() {
        writes++;
      },
    },
    localStorage: {
      getItem() {
        return '';
      },
      clear() {
        writes++;
      },
      setItem() {
        writes++;
      },
    },
  });
  const javascript = ts.transpileModule(`import { ref, shallowRef, watch, watchEffect, watchSyncEffect, watchPostEffect, onWatcherCleanup, onScopeDispose } from './framework';\n${source}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const scope = Vue.effectScope();
  scope.run(() => new vm.Script(javascript).runInContext(context, { timeout: 1000 }));
  return {
    writes: () => writes,
    call({ name }: { name: string }) {
      const fn = exports[name];
      if (typeof fn !== 'function') throw new Error(`Expected exported function: ${name}`);
      fn();
    },
    dispose() {
      scope.stop();
    },
  };
}

function checked({ source }: { source: string }) {
  const result = checkVueSource({ source });
  expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
  return result;
}

describe('Vue model assumptions against real Vue (not a browser renderer)', () => {
  it.each(['pre', 'post', 'sync'])('keeps the explicit reactive boundary despite runtime %s writes', async flush => {
    const source = `\
const name = ref('');
watch(name, value => { localStorage.setItem('name', value); }, { flush: '${flush}' });
export function setName() { name.value = 'updated'; }
`;
    const result = checked({ source });
    const owner = result.owners.find(owner => owner.label === 'setName')!;
    expect(result.solution.rows.get(owner.id)).toEqual([]);
    const runtime = execute({ source });
    try {
      expect(runtime.writes()).toBe(0);
      runtime.call({ name: 'setName' });
      expect(runtime.writes()).toBe(flush === 'sync' ? 1 : 0);
      await Vue.nextTick();
      expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('observes watchEffect execution without charging scalar ref creation', () => {
    const source = `\
const name = ref('');
watchEffect(() => { localStorage.setItem('name', name.value); });
`;
    checked({ source });
    const runtime = execute({ source });
    try {
      expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('observes cleanup on explicit stop, with the cleanup upper bound retained', () => {
    const source = `\
const name = ref('');
const handle = watch(name, () => { onWatcherCleanup(() => { localStorage.clear(); }); }, { immediate: true });
export function stop() { handle.stop(); }
`;
    const result = checked({ source });
    const owner = result.owners.find(owner => owner.label === 'stop')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    const runtime = execute({ source });
    try {
      expect(runtime.writes()).toBe(0);
      runtime.call({ name: 'stop' });
      expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('observes pause and resume without assuming resume is pure', async () => {
    const source = `\
const name = ref('');
const handle = watch(name, () => { localStorage.clear(); });
export function pause() { handle.pause(); }
export function set() { name.value = 'updated'; }
export function resume() { handle.resume(); }
`;
    const result = checked({ source });
    const owner = result.owners.find(owner => owner.label === 'resume')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    const runtime = execute({ source });
    try {
      runtime.call({ name: 'pause' }); runtime.call({ name: 'set' });
      await Vue.nextTick(); expect(runtime.writes()).toBe(0);
      runtime.call({ name: 'resume' });
      await Vue.nextTick(); expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('observes onScopeDispose without treating registration as immediate execution', () => {
    const source = `onScopeDispose(() => { localStorage.clear(); });`;
    checked({ source });
    const runtime = execute({ source });
    expect(runtime.writes()).toBe(0);
    runtime.dispose();
    expect(runtime.writes()).toBe(1);
  });

  it('exercises the replaced-handle counterexample rather than only matching a diagnostic', () => {
    const source = `\
const name = ref('');
let handle = watch(name, () => {});
export function replace() { handle = watch(name, () => { onWatcherCleanup(() => { localStorage.clear(); }); }, { immediate: true }); }
export function stop() { handle(); }
`;
    const result = checkVueSource({ source });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.message.includes('Replacing a Vue watch handle'))).toBe(true);
    const runtime = execute({ source });
    try {
      runtime.call({ name: 'replace' });
      expect(runtime.writes()).toBe(0);
      runtime.call({ name: 'stop' });
      expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it.each(['watchEffect', 'watchSyncEffect', 'watchPostEffect'])('does not re-execute an ordinary %s body on stop', async operation => {
    const source = `\
const handle = ${operation}(() => { localStorage.clear(); });
export function stop() { handle(); }
`;
    const result = checked({ source });
    const owner = result.owners.find(item => item.label === 'stop')!;
    expect(result.solution.rows.get(owner.id)).toEqual([]);
    const runtime = execute({ source });
    try {
      await Vue.nextTick();
      expect(runtime.writes()).toBe(1);
      runtime.call({ name: 'stop' });
      expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('runs only cleanup, not both the ordinary body and cleanup, on explicit stop', () => {
    const source = `\
const handle = watchEffect(() => { localStorage.clear(); onWatcherCleanup(() => { sessionStorage.clear(); }); });
export function stop() { handle(); }
`;
    const result = checked({ source });
    const owner = result.owners.find(item => item.label === 'stop')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['sessionstorage.write(*)']);
    const runtime = execute({ source });
    try {
      expect(runtime.writes()).toBe(1);
      runtime.call({ name: 'stop' });
      expect(runtime.writes()).toBe(2);
      runtime.call({ name: 'stop' });
      expect(runtime.writes()).toBe(2);
    } finally {
      runtime.dispose();
    }
  });

  it('does not run an inner watcher cleanup when stopping only the outer watcher', () => {
    const source = `\
const outer = watchEffect(() => {
  onWatcherCleanup(() => { localStorage.clear(); });
  watchEffect(() => { onWatcherCleanup(() => { sessionStorage.clear(); }); });
});
export function stop() { outer.stop(); }
`;
    const result = checked({ source });
    const owner = result.owners.find(item => item.label === 'stop')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    const runtime = execute({ source });
    try {
      expect(runtime.writes()).toBe(0);
      runtime.call({ name: 'stop' });
      expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
    expect(runtime.writes()).toBe(2);
  });

  it('observes the inherited active watcher during an inner source getter', () => {
    const source = `\
const outer = watchEffect(() => {
  watch(() => { onWatcherCleanup(() => { localStorage.clear(); }); return ''; }, () => {});
});
export function stop() { outer(); }
`;
    const result = checked({ source });
    const owner = result.owners.find(item => item.label === 'stop')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    const runtime = execute({ source });
    try {
      expect(runtime.writes()).toBe(0); runtime.call({ name: 'stop' }); expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('demonstrates why reentrant cleanup registration cannot be declared empty', () => {
    const source = `\
const inner = watchEffect(() => { onWatcherCleanup(() => { onWatcherCleanup(() => { localStorage.clear(); }); }); });
const outer = watchEffect(() => { inner.stop(); });
export function stop() { outer(); }
`;
    const result = checkVueSource({ source });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.message.includes('Reentrant'))).toBe(true);
    const runtime = execute({ source });
    try {
      expect(runtime.writes()).toBe(0); runtime.call({ name: 'stop' }); expect(runtime.writes()).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('keeps a potential cleanup upper bound without reconstructing whether a watcher ever ran', () => {
    const source = `\
const state = ref('');
const handle = watch(state, () => { onWatcherCleanup(() => { localStorage.clear(); }); });
export function stop() { handle(); }
`;
    const result = checked({ source });
    const owner = result.owners.find(item => item.label === 'stop')!;
    expect(result.solution.rows.get(owner.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    const runtime = execute({ source });
    try {
      runtime.call({ name: 'stop' }); expect(runtime.writes()).toBe(0);
    } finally {
      runtime.dispose();
    }
  });
});
