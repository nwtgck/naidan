import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Component } from 'vue';

const mocks = vi.hoisted(() => ({ load: vi.fn<() => Promise<Component>>() }));
enableAutoUnmount(afterEach);

const fakeModal: Component = {
  props: ['isOpen', 'initialMode'],
  emits: ['close'],
  template: '<div data-testid="hosted-import-export" :data-open="isOpen" :data-mode="initialMode"><button @click="$emit(\'close\')">close</button></div>',
};

beforeEach(() => {
  vi.resetModules();
  mocks.load.mockReset().mockResolvedValue(fakeModal);
  // resetModules preserves manual mock results. Register a fresh factory so
  // each test exercises its own pending, rejected or broken component import.
  vi.doMock('@/features/import-export/components/ImportExportModal.vue', async () => ({ default: await mocks.load() }));
});

afterEach(() => {
  vi.doUnmock('@/features/import-export/components/ImportExportModal.vue');
});

async function renderHost() {
  const { useImportExportModal } = await import('@/features/import-export/composables/useImportExportModal');
  const { default: ImportExportModalHost } = await import('./ImportExportModalHost.vue');
  const appError = vi.fn();
  return { state: useImportExportModal(), wrapper: mount(ImportExportModalHost, { global: { config: { errorHandler: appError } } }), appError };
}

describe('an independently hosted import/export dialog', () => {
  it('loads the modal only after an explicit request and passes the requested starting screen', async () => {
    const { state, wrapper } = await renderHost();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="hosted-import-export"]').exists()).toBe(false);
    state.open({ initialMode: 'export' });
    await flushPromises();
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(state.request.value?.status).toBe('ready');
    expect(wrapper.get('[data-testid="hosted-import-export"]').attributes('data-mode')).toBe('export');
    await wrapper.get('button').trigger('click');
    expect(state.request.value).toBeUndefined();
    expect(wrapper.find('[data-testid="hosted-import-export"]').exists()).toBe(false);

    state.open({ initialMode: 'menu' });
    await flushPromises();
    expect(wrapper.get('[data-testid="hosted-import-export"]').attributes('data-mode')).toBe('menu');
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it('discards late loads and earlier close or failure events after a newer request', async () => {
    const pending = Promise.withResolvers<Component>();
    mocks.load.mockReturnValueOnce(pending.promise);
    const { state, wrapper } = await renderHost();
    const oldId = state.open({ initialMode: 'export' });
    await flushPromises();
    expect(mocks.load).toHaveBeenCalledOnce();
    state.close({ requestId: oldId });
    pending.resolve(fakeModal);
    await flushPromises();
    expect(state.request.value).toBeUndefined();
    expect(wrapper.find('[data-testid="hosted-import-export"]').exists()).toBe(false);

    const newId = state.open({ initialMode: 'menu' });
    state.completeLoad({ requestId: oldId, status: 'failed' });
    state.close({ requestId: oldId });
    await flushPromises();
    expect(state.request.value).toMatchObject({ id: newId, initialMode: 'menu', status: 'ready' });
    expect(wrapper.get('[data-testid="hosted-import-export"]').attributes('data-mode')).toBe('menu');
  });

  it('contains an asynchronous chunk failure without throwing or mounting an empty overlay', async () => {
    mocks.load.mockRejectedValueOnce(new Error('private chunk diagnostic'));
    const { state, wrapper } = await renderHost();
    state.open({ initialMode: 'export' });
    await flushPromises();
    expect(state.request.value).toMatchObject({ initialMode: 'export', status: 'failed' });
    expect(wrapper.find('[data-testid="hosted-import-export"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('private chunk diagnostic');
  });

  it('contains a child rendering failure after the module loads without forwarding it to the app', async () => {
    mocks.load.mockResolvedValueOnce({
      render() {
        throw new Error('private rendering diagnostic');
      },
    });
    const { state, wrapper, appError } = await renderHost();
    state.open({ initialMode: 'export' });
    await flushPromises();
    expect(state.request.value).toMatchObject({ initialMode: 'export', status: 'failed' });
    expect(appError).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="hosted-import-export"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('private rendering diagnostic');
  });
});
