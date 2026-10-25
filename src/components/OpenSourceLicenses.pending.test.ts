import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { NaidanLicenseCatalog } from '@/01-models/naidan-license';
import OpenSourceLicenses from './OpenSourceLicenses.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function createPendingModule() {
  const readLicenseText = vi.fn(() => 'Deferred body');
  const createCatalog = vi.fn((): NaidanLicenseCatalog => ({
    entries: [{ name: 'deferred', version: '1', license: 'MIT' }],
    readLicenseText,
  }));
  const deferred = Promise.withResolvers<{ default: () => NaidanLicenseCatalog }>();
  vi.resetModules();
  const loadModule = vi.fn(() => deferred.promise);
  vi.doMock('virtual:naidan-licenses', loadModule);
  return {
    createCatalog,
    readLicenseText,
    async started() {
      await vi.waitFor(() => expect(loadModule).toHaveBeenCalled());
    },
    resolve() {
      deferred.resolve({ default: createCatalog });
    },
    reject() {
      deferred.reject(new Error('Deferred import failed'));
    },
    async [Symbol.asyncDispose]() {
      deferred.resolve({ default: createCatalog });
      await vi.dynamicImportSettled();
      vi.doUnmock('virtual:naidan-licenses');
    },
  };
}

function createPendingView({ component }: { component: typeof OpenSourceLicenses }) {
  const wrapper = mount(component);
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('OpenSourceLicenses pending imports', () => {
  it('does not invoke the factory when the import finishes after unmount', async () => {
    await using pending = createPendingModule();
    using view = createPendingView({ component: OpenSourceLicenses });
    const state = view.wrapper.vm.TEST_ONLY;
    await pending.started();
    expect(view.wrapper.find('[data-testid="oss-license-loading"]').exists()).toBe(true);
    view.wrapper.unmount();
    pending.resolve();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(pending.createCatalog).not.toHaveBeenCalled();
    expect(pending.readLicenseText).not.toHaveBeenCalled();
    expect(state.catalog.value).toBeUndefined();
    expect(state.openIndexes.value.size).toBe(0);
  });

  it('lets only the new instance create a catalog when reopened before the shared import resolves', async () => {
    await using pending = createPendingModule();
    using oldView = createPendingView({ component: OpenSourceLicenses });
    await pending.started();
    const oldState = oldView.wrapper.vm.TEST_ONLY;
    oldView.wrapper.unmount();
    // A second module evaluation avoids Vitest treating concurrent imports from
    // one captured mock call stack as recursive imports of the real module.
    vi.resetModules();
    const { default: ReopenedLicenses } = await import('./OpenSourceLicenses.vue');
    using currentView = createPendingView({ component: ReopenedLicenses });
    await flushPromises();
    pending.resolve();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(pending.createCatalog).toHaveBeenCalledTimes(1);
    expect(oldState.catalog.value).toBeUndefined();
    expect(currentView.wrapper.get('[data-testid="oss-license-list"]').text()).toContain('deferred');
    expect(pending.readLicenseText).not.toHaveBeenCalled();
  });

  it('handles a late import rejection without reviving state or reporting an abandoned load', async () => {
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await using pending = createPendingModule();
    using view = createPendingView({ component: OpenSourceLicenses });
    await pending.started();
    view.wrapper.unmount();
    pending.reject();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(error).not.toHaveBeenCalled();
    expect(pending.createCatalog).not.toHaveBeenCalled();
  });

  it('ends loading on an active import rejection without retaining an error or a catalog', async () => {
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await using pending = createPendingModule();
    using view = createPendingView({ component: OpenSourceLicenses });
    await pending.started();
    pending.reject();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(error).toHaveBeenCalledTimes(1);
    expect(view.wrapper.find('[data-testid="oss-license-loading"]').exists()).toBe(false);
    expect(view.wrapper.vm.TEST_ONLY.catalog.value).toBeUndefined();
    expect(pending.createCatalog).not.toHaveBeenCalled();
  });
});
