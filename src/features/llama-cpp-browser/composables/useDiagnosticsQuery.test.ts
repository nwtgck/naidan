import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useDiagnosticsQuery } from './useDiagnosticsQuery';

async function setup({ query = '' }: { query?: string } = {}) {
  const path = '/llama-cpp-browser/diagnostics';
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path, component: { render: () => h('div') } },
      { path: '/', component: { render: () => h('div') } },
    ],
  });
  await router.push(path + query);
  const load = vi.fn<Parameters<typeof useDiagnosticsQuery>[0]['load']>();
  let sync: ReturnType<typeof useDiagnosticsQuery> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      sync = useDiagnosticsQuery({ load });
      return () => h('div');
    },
  }), { global: { plugins: [router] } });
  if (!sync) {
    throw new Error('Missing query controller');
  }
  return {
    router,
    sync,
    load,
    wrapper,
    path,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Diagnostics URL synchronization', () => {
  it('reads once without normalizing unknown or explicit default values on initialization', async () => {
    using test = await setup({ query: '?all-models&mode=both&placement=1&old=2&v=4' });
    const replace = vi.spyOn(test.router, 'replace');
    expect(test.load).toHaveBeenCalledExactlyOnceWith({ config: { allModels: true, mode: 'both', placement: true } });
    await flushPromises();
    expect(replace).not.toHaveBeenCalled();
    expect(test.router.currentRoute.value.query.old).toBe('2');
    expect(await test.sync.flush()).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it('merges successive edits, preserves all-models and does not reload its own replacements', async () => {
    using test = await setup({ query: '?all-models&mode=both&placement=1&obsolete=2' });
    const replace = vi.spyOn(test.router, 'replace');
    expect(test.sync.edit({ patch: { repeats: 3 } })).toBe(true);
    expect(test.sync.edit({ patch: { notes: '日本語 & # +' } })).toBe(true);
    expect(test.sync.syncing.value).toBe(true);
    expect(await test.sync.flush()).toBe(true);
    expect(replace).toHaveBeenCalledOnce();
    expect(test.router.currentRoute.value.query).toEqual({ 'all-models': null, mode: 'both', placement: '1', repeats: '3', notes: '日本語 & # +' });
    expect(test.load).toHaveBeenCalledTimes(1);
    expect(test.sync.syncing.value).toBe(false);
  });

  it('does not lose an edit that arrives while a previous replacement is pending', async () => {
    using test = await setup({ query: '?all-models' });
    let resume = () => {};
    const pending = new Promise<void>(resolve => {
      resume = resolve;
    });
    test.router.beforeResolve(to => to.query.repeats === '2' && to.query.notes === undefined ? pending : undefined);
    test.sync.edit({ patch: { repeats: 2 } });
    await flushPromises();
    test.sync.edit({ patch: { notes: 'second edit' } });
    resume();
    expect(await test.sync.flush()).toBe(true);
    expect(test.router.currentRoute.value.query).toEqual({ 'all-models': null, repeats: '2', notes: 'second edit' });
    expect(test.load).toHaveBeenCalledTimes(1);
  });

  it('converts only explicit model edits, including zero models, and never infers all-models', async () => {
    using test = await setup({ query: '?all-models&mode=both' });
    test.sync.edit({ patch: { allModels: undefined, modelIds: ['a', 'b'] } });
    await test.sync.flush();
    expect(test.router.currentRoute.value.query).toEqual({ model: ['a', 'b'], mode: 'both' });
    test.sync.edit({ patch: { modelIds: [] } });
    await test.sync.flush();
    expect(test.router.currentRoute.value.query).toEqual({ model: '', mode: 'both' });
  });

  it('reloads external queries, clearing omitted values without a feedback replace', async () => {
    using test = await setup({ query: '?all-models&repeats=3&notes=old' });
    const replace = vi.spyOn(test.router, 'replace');
    await test.router.push(test.path + '?model=&mode=standard&repeats=invalid');
    expect(test.sync.config.value).toEqual({ modelIds: [], mode: 'standard' });
    expect(test.load).toHaveBeenLastCalledWith({ config: { modelIds: [], mode: 'standard' } });
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps invalid form edits out of the URL and removes only the field reset to its default', async () => {
    using test = await setup({ query: '?all-models&repeats=3&maxTokens=64' });
    expect(test.sync.edit({ patch: { repeats: NaN } })).toBe(false);
    await test.sync.flush();
    expect(test.router.currentRoute.value.query.repeats).toBe('3');
    test.sync.edit({ patch: { repeats: undefined } });
    await test.sync.flush();
    expect(test.router.currentRoute.value.query).toEqual({ 'all-models': null, maxTokens: '64' });
  });

  it('surfaces navigation rejection, retains the requested configuration, and supports retry', async () => {
    using test = await setup();
    const remove = test.router.beforeResolve(() => false);
    test.sync.edit({ patch: { repeats: 2 } });
    expect(await test.sync.flush()).toBe(false);
    expect(test.sync.error.value).not.toBe('');
    expect(test.sync.config.value.repeats).toBe(2);
    expect(test.router.currentRoute.value.query).toEqual({});
    remove();
    test.sync.retry();
    expect(await test.sync.flush()).toBe(true);
    expect(test.sync.error.value).toBe('');
    expect(test.router.currentRoute.value.query.repeats).toBe('2');
  });

  it('never pulls an external navigation back to Diagnostics after a queued edit', async () => {
    using test = await setup({ query: '?all-models' });
    let resume = () => {};
    const pending = new Promise<void>(resolve => {
      resume = resolve;
    });
    test.router.beforeResolve(to => to.path === test.path ? pending : undefined);
    test.sync.edit({ patch: { repeats: 2 } });
    await flushPromises();
    const flushing = test.sync.flush();
    await test.router.push('/');
    resume();
    expect(await flushing).toBe(false);
    expect(test.router.currentRoute.value.path).toBe('/');
    expect(test.sync.edit({ patch: { repeats: 3 } })).toBe(false);
  });

  it('does not reapply settings when only unknown query keys change', async () => {
    using test = await setup({ query: '?all-models' });
    await test.router.push(test.path + '?all-models&removed=1&v=999');
    expect(test.load).toHaveBeenCalledTimes(1);
    expect(test.sync.config.value).toEqual({ allModels: true });
  });

  it('blocks stale configuration when an external navigation cancels an edit but is itself rejected', async () => {
    using test = await setup();
    const pending = Promise.withResolvers<void>();
    const remove = test.router.beforeResolve(to => to.path === test.path ? pending.promise : false);
    test.sync.edit({ patch: { repeats: 2 } });
    await flushPromises();
    const flushing = test.sync.flush();
    await test.router.push('/');
    pending.resolve();
    expect(await flushing).toBe(false);
    expect(test.router.currentRoute.value.path).toBe(test.path);
    expect(test.router.currentRoute.value.query.repeats).toBeUndefined();
    expect(test.sync.error.value).not.toBe('');
    remove();
    test.sync.retry();
    expect(await test.sync.flush()).toBe(true);
    expect(test.router.currentRoute.value.query.repeats).toBe('2');
  });

  it('cancels the local controller on disposal and resets explicitly without adding history', async () => {
    using test = await setup({ query: '?all-models&notes=x' });
    test.sync.reset();
    await test.sync.flush();
    expect(test.router.currentRoute.value.query).toEqual({});
    expect(test.load).toHaveBeenLastCalledWith({ config: {} });
    test.wrapper.unmount();
    expect(test.sync.edit({ patch: { repeats: 2 } })).toBe(false);
    expect(await test.sync.flush()).toBe(false);
  });
});
