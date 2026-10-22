import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ModelImportReceipt } from '@/features/llama-cpp-browser/model-files';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { TEST_ONLY as recentTests } from '@/features/llama-cpp-browser/composables/useRecentModelImports';
import LlamaCppBrowserModelLibrary from './LlamaCppBrowserModelLibrary.vue';
import LlamaCppBrowserDefaultModelDialog from './LlamaCppBrowserDefaultModelDialog.vue';

const service = vi.hoisted(() => ({ imports: new Set<({ receipt }: { receipt: ModelImportReceipt }) => void>(), models: new Set<() => void>() }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({
  llamaCppBrowserModelFiles: {
    listModelEntries: vi.fn(async () => []),
    importModel: vi.fn(),
    importDirectory: vi.fn(),
    removeTemporaryModel: vi.fn(),
    removeModel: vi.fn(),
    subscribeModelImports: ({ listener }: { listener: ({ receipt }: { receipt: ModelImportReceipt }) => void }) => {
      service.imports.add(listener);
      return () => service.imports.delete(listener);
    },
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      service.models.add(listener);
      return () => service.models.delete(listener);
    },
  },
}));

const model: LocalModel = { modelId: 'temp/model-GGUF', size: 16, importedAt: 1 };
const wrappers: VueWrapper[] = [];

function render({ createChatGroup }: { createChatGroup: (({ model, signal }: { model: LocalModel, signal: AbortSignal }) => Promise<void>) | undefined }): VueWrapper {
  const wrapper = mount(LlamaCppBrowserModelLibrary, {
    props: { createChatGroup, defaultModel: { endpoint: { type: 'llama_cpp_browser' }, modelId: undefined }, applyDefaultModel: vi.fn().mockResolvedValue('applied') },
  });
  wrappers.push(wrapper);
  return wrapper;
}

function publish({ generation, current }: { generation: number, current: () => boolean }): void {
  const receipt: ModelImportReceipt = { storage: 'temp', models: [model], publication: { generation, isCurrent: current } };
  service.imports.forEach(listener => listener({ receipt }));
  service.models.forEach(listener => listener());
}

beforeEach(async () => {
  vi.clearAllMocks();
  recentTests.reset();
  vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mockResolvedValue([model]);
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
  await flushPromises();
});

describe('shared file model library', () => {
  it('does not apply a default after its revalidation crosses a hide and reveal cycle', async () => {
    const pending = Promise.withResolvers<void>();
    const refresh = vi.fn(() => pending.promise);
    const applyDefaultModel = vi.fn().mockResolvedValue('applied');
    const previous = { endpoint: { type: 'llama_cpp_browser' as const }, modelId: undefined };
    const wrapper = mount(LlamaCppBrowserModelLibrary, {
      props: { suspended: false, inventory: { models: [model], hostIssues: [], error: undefined, refreshing: false, refresh }, defaultModel: previous, applyDefaultModel },
    });
    wrappers.push(wrapper);
    const apply = wrapper.getComponent(LlamaCppBrowserDefaultModelDialog).props('apply');
    expect(apply).toBeDefined();
    const result = apply!({ model, previous });
    const rejected = expect(result).rejects.toThrow('Local model unavailable');
    await wrapper.setProps({ suspended: true });
    await wrapper.setProps({ suspended: false });
    pending.resolve();
    await rejected;
    expect(applyDefaultModel).not.toHaveBeenCalled();
  });

  it('renders a prepared inventory while suspended without another scan or file operation', async () => {
    const refresh = vi.fn(async () => {});
    const fetch = vi.spyOn(globalThis, 'fetch');
    using _fetchCleanup = {
      [Symbol.dispose]() {
        fetch.mockRestore();
      },
    };
    const wrapper = mount(LlamaCppBrowserModelLibrary, {
      props: { suspended: true, inventory: { models: [model], hostIssues: [], error: undefined, refreshing: false, refresh } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(model.modelId);
    expect(llamaCppBrowserModelFiles.listModelEntries).not.toHaveBeenCalled();
    expect(llamaCppBrowserModelFiles.importModel).not.toHaveBeenCalled();
    expect(llamaCppBrowserModelFiles.importDirectory).not.toHaveBeenCalled();
    expect(llamaCppBrowserModelFiles.removeTemporaryModel).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    await wrapper.setProps({ suspended: false });
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(refresh).not.toHaveBeenCalled();
    expect(llamaCppBrowserModelFiles.listModelEntries).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-cpp-browser-refresh"]').trigger('click');
    expect(refresh).toHaveBeenCalledOnce();
    await wrapper.setProps({ inventory: { models: [], hostIssues: [], error: undefined, refreshing: false, refresh } });
    expect(wrapper.find('[data-testid="llama-cpp-browser-model-list"]').exists()).toBe(false);
  });

  it('shares its scan and recent rows across surfaces and dismisses them together', async () => {
    const settings = render({ createChatGroup: vi.fn().mockResolvedValue(undefined) });
    const drawer = render({ createChatGroup: vi.fn().mockResolvedValue(undefined) });
    await flushPromises();
    expect(llamaCppBrowserModelFiles.listModelEntries).toHaveBeenCalledOnce();
    publish({ generation: 1, current: () => true });
    await flushPromises();
    for (const wrapper of [settings, drawer]) {
      const recent = wrapper.get('[data-testid="llama-recent-imports"]');
      expect(recent.get('[data-testid="llama-model-action-main"]').text()).toContain('Create chat group');
      expect(recent.find(`[data-testid="llama-imported-model-details-${model.modelId}"]`).exists()).toBe(true);
      expect(recent.find(`[data-testid="llama-cpp-browser-delete-${model.modelId}"]`).exists()).toBe(true);
      expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(model.modelId);
    }
    await settings.get('[data-testid="llama-dismiss-recent-imports"]').trigger('click');
    expect(drawer.find('[data-testid="llama-recent-imports"]').exists()).toBe(false);
    expect(settings.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(model.modelId);
  });

  it('uses the same chat group command from a recent row and removes it when its registration is deleted', async () => {
    const createChatGroup = vi.fn().mockResolvedValue(undefined);
    const wrapper = render({ createChatGroup });
    await flushPromises();
    let current = true;
    publish({ generation: 1, current: () => current });
    await flushPromises();
    await wrapper.get('[data-testid="llama-recent-imports"] [data-testid="llama-model-action-main"]').trigger('click');
    expect(createChatGroup).toHaveBeenCalledExactlyOnceWith({ model, signal: expect.any(AbortSignal) });
    await flushPromises();
    vi.mocked(llamaCppBrowserModelFiles.removeTemporaryModel).mockImplementationOnce(async () => {
      current = false;
      vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mockResolvedValue([]);
      service.models.forEach(listener => listener());
    });
    await wrapper.get(`[data-testid="llama-recent-imports"] [data-testid="llama-cpp-browser-delete-${model.modelId}"]`).trigger('click');
    await flushPromises();
    expect(llamaCppBrowserModelFiles.removeTemporaryModel).toHaveBeenCalledExactlyOnceWith({ modelId: model.modelId, signal: expect.any(AbortSignal) });
    expect(wrapper.find('[data-testid="llama-recent-imports"]').exists()).toBe(false);
    publish({ generation: 1, current: () => current });
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-recent-imports"]').exists()).toBe(false);
  });

  it('shows a confirmed first import before a later file settles and keeps it after that file fails', async () => {
    vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mockResolvedValue([]);
    const wrapper = render({ createChatGroup: undefined });
    await flushPromises();
    const second = Promise.withResolvers<ModelImportReceipt>();
    vi.mocked(llamaCppBrowserModelFiles.importModel).mockImplementationOnce(async () => {
      vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mockResolvedValue([model]);
      publish({ generation: 1, current: () => true });
      return { storage: 'temp', models: [model], publication: { generation: 1, isCurrent: () => true } };
    }).mockImplementationOnce(({ onProgress }) => {
      onProgress?.({ progress: { phase: 'importing', completed: 1, total: 4 } });
      return second.promise;
    });
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { types: ['Files'], items: [], files: [new File(['one'], 'one.gguf'), new File(['two'], 'two.gguf')] },
    });
    await flushPromises();
    expect(llamaCppBrowserModelFiles.importModel).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="llama-recent-imports"]').text()).toContain(model.modelId);
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="llama-cpp-browser-import-status"]').text()).toContain('Importing');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25');
    second.reject(new Error('later import failed'));
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="llama-recent-imports"]').text()).toContain(model.modelId);
  });
});
