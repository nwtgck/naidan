import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import LlamaCppBrowserManager from './LlamaCppBrowserManager.vue';
import { LlamaCppBrowserError, type EngineState, type LocalModel, type RuntimeOptions } from '@/features/llama-cpp-browser/types';

const notifications = vi.hoisted(() => ({
  state: new Set<(event: { state: EngineState }) => void>(),
  models: new Set<() => void>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  profiles: [] as RuntimeOptions['profile'][],
}));
vi.mock('@/features/llama-cpp-browser/runtime/profile-policy', () => ({ selectableProfiles: notifications.profiles }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: {
  getState: vi.fn<() => EngineState>(() => ({ status: 'idle' })),
  getOptions: vi.fn(() => ({ profile: 'auto' })),
  subscribe: vi.fn(({ listener }: { listener: (event: { state: EngineState }) => void }) => {
    notifications.state.add(listener); return () => {
      notifications.state.delete(listener);
    };
  }),
  subscribeModelList: vi.fn(({ listener }: { listener: () => void }) => {
    notifications.models.add(listener); return () => {
      notifications.models.delete(listener);
    };
  }),
  listModels: vi.fn(async () => []), setOptions: vi.fn(), importModel: vi.fn(), importDirectory: vi.fn(), removeModel: vi.fn(),
  release: vi.fn(), cancel: vi.fn(),
} }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ listPendingDownloads: vi.fn(async () => []), installedSelection: vi.fn(async () => undefined) }));
vi.mock('../runtime/model-store', () => ({ prepareModelRemoval: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: notifications.confirm }) }));
const storedModel: LocalModel = { id: 'user/local-GGUF', name: 'local.gguf', size: 16384, importedAt: 1 };
const wrappers: VueWrapper[] = [];
function render(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserManager); wrappers.push(wrapper); return wrapper;
}
beforeEach(async () => {
  vi.clearAllMocks(); notifications.state.clear(); notifications.models.clear();
  notifications.confirm.mockResolvedValue(true);
  notifications.profiles.splice(0, notifications.profiles.length, 'auto', 'cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi');
  vi.mocked(llamaCppBrowserService.getOptions).mockReturnValue({ profile: 'auto' });
  vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'idle' });
  vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([]);
  vi.mocked(llamaCppBrowserService.importModel).mockResolvedValue(undefined);
  vi.mocked(llamaCppBrowserService.removeModel).mockResolvedValue('deleted');
  vi.mocked(prepareModelRemoval).mockResolvedValue({ plan: { id: storedModel.id, files: [{ path: 'local.gguf', size: 16384, lastModified: 1 }] }, sharedPlan: undefined, affectedVariants: 0 });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.restoreAllMocks();
});

describe('local GGUF manager', () => {
  it('keeps the standalone profile visible and fixed while model operations remain available', async () => {
    notifications.profiles.splice(0, notifications.profiles.length, 'webgpu-wasm64-jspi');
    vi.mocked(llamaCppBrowserService.getOptions).mockReturnValue({ profile: 'webgpu-wasm64-jspi' });
    const wrapper = render(); await flushPromises();
    const select = wrapper.get<HTMLSelectElement>('[data-testid="llama-cpp-browser-profile"]');
    expect(select.element.value).toBe('webgpu-wasm64-jspi');
    expect(select.element.disabled).toBe(true);
    expect(select.findAll('option').map(option => option.element.value)).toEqual(['webgpu-wasm64-jspi']);
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined();
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledOnce();
    expect(llamaCppBrowserService.setOptions).not.toHaveBeenCalled();
  });
  it('refreshes model choices and forwards the prepared model instead of choosing the first entry', async () => {
    const wrapper = render(); await flushPromises();
    const target = { ...storedModel, id: 'hf-target', name: 'hf.co/owner/repo:Q8_0' };
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel, target]);
    wrapper.findComponent({ name: 'LlamaCppBrowserHuggingFaceManager' }).vm.$emit('modelReady', target);
    await flushPromises();
    expect(wrapper.emitted('modelsChanged')?.at(-1)).toEqual([[storedModel, target]]);
    expect(wrapper.emitted('modelSelected')).toEqual([[target.name]]);
  });
  it('does not select an earlier prepared model after the HF selection changes during list refresh', async () => {
    const wrapper = render(); await flushPromises();
    const refreshed = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModels).mockReturnValue(refreshed.promise);
    const child = wrapper.findComponent({ name: 'LlamaCppBrowserHuggingFaceManager' });
    child.vm.$emit('modelReady', storedModel); await flushPromises();
    child.vm.$emit('selectionChanged');
    refreshed.resolve([storedModel]); await flushPromises();
    expect(wrapper.emitted('modelsChanged')?.at(-1)).toEqual([[storedModel]]);
    expect(wrapper.emitted('modelSelected')).toBeUndefined();
  });
  it('imports a selected folder with its original root and relative paths', async () => {
    const wrapper = render(); await flushPromises();
    const file = new File(['fixture'], 'weights.gguf'); Object.defineProperty(file, 'webkitRelativePath', { value: 'my-Qwen-VL-GGUF/nested/weights.gguf' });
    const input = wrapper.get('[data-testid="llama-cpp-browser-directory"]');
    expect(input.attributes('webkitdirectory')).toBeDefined(); Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change'); await flushPromises();
    expect(llamaCppBrowserService.importDirectory).toHaveBeenCalledWith({ directory: { name: 'my-Qwen-VL-GGUF', files: [{ path: 'nested/weights.gguf', file }] }, signal: expect.any(AbortSignal) });
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
  });
  it('keeps controls visible but disables them when the service is unavailable', async () => {
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'unavailable' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-unavailable"]').text()).toContain('failed');
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="llama-cpp-browser-profile"]').exists()).toBe(true);
    const file = new File(['fixture'], 'local.gguf');
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    expect(llamaCppBrowserService.listModels).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
  });
  it('shows an explicit file picker, drop target and automatic profile without an idle status', async () => {
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-file"]').attributes('accept')).toBe('.gguf');
    expect(wrapper.get('[data-testid="llama-cpp-browser-file"]').attributes('multiple')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').text()).toContain('GGUF');
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-cpp-browser-profile"]').element.value).toBe('auto');
    expect(wrapper.find('[data-testid="llama-cpp-browser-status"]').exists()).toBe(false);
    expect(wrapper.find('progress').exists()).toBe(false);
  });
  it('reads the persisted model list again on every mount', async () => {
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel]);
    const first = render(); await flushPromises();
    expect(first.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
    first.unmount(); wrappers.splice(wrappers.indexOf(first), 1);
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([{ ...storedModel, name: 'after-reload.gguf' }]);
    const second = render(); await flushPromises();
    expect(second.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('after-reload.gguf');
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledTimes(2);
    expect(notifications.models.size).toBe(1);
  });
  it('imports file input selections and resets the native input', async () => {
    const wrapper = render(); await flushPromises();
    const file = new File(['fixture'], 'input.GGUF');
    const input = wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel]);
    await input.trigger('change'); await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls[0]?.[0].file).toBe(file);
    expect(input.element.value).toBe('');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
  });
  it('imports dropped files sequentially and refreshes the list', async () => {
    const wrapper = render(); await flushPromises();
    const files = [new File(['a'], 'first.gguf'), new File(['b'], 'second.gguf')];
    let finishFirst: (() => void) | undefined;
    vi.mocked(llamaCppBrowserService.importModel).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finishFirst = resolve;
      });
    });
    const zone = wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]');
    await zone.trigger('drop', { dataTransfer: { files, types: ['Files'] } }); await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    await zone.trigger('drop', { dataTransfer: { files, types: ['Files'] } });
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    finishFirst?.(); await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual(files);
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledTimes(2);
  });
  it('stops a multi-file import after cancellation without starting the next file', async () => {
    const wrapper = render(); await flushPromises();
    let importSignal: AbortSignal | undefined;
    vi.mocked(llamaCppBrowserService.importModel).mockImplementationOnce(({ signal }) => new Promise<void>((_resolve, reject) => {
      importSignal = signal;
      signal?.addEventListener('abort', () => reject(new LlamaCppBrowserError({ code: 'aborted' })), { once: true });
    }));
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [new File(['a'], 'first.gguf'), new File(['b'], 'second.gguf')], types: ['Files'] },
    });
    await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-cancel"]').trigger('click'); await flushPromises();
    expect(importSignal?.aborted).toBe(true);
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
  });
  it('rejects a mixed non-GGUF drop without importing or logging file contents', async () => {
    const wrapper = render(); await flushPromises();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [new File(['a'], 'first.gguf'), new File(['private'], 'secret.txt')], types: ['Files'] },
    });
    await flushPromises();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('GGUF');
    expect(wrapper.get('[role="alert"]').text()).not.toContain('secret');
    expect(log).not.toHaveBeenCalled();
  });
  it('keeps earlier completed imports visible when a later file fails', async () => {
    const wrapper = render(); await flushPromises();
    vi.mocked(llamaCppBrowserService.importModel).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'storage-error' }));
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel]);
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [new File(['a'], 'first.gguf'), new File(['b'], 'second.gguf')], types: ['Files'] },
    });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).not.toBe('');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
  });
  it('refreshes OPFS listing when the model service reports a change', async () => {
    const wrapper = render(); await flushPromises();
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel]);
    for (const listener of notifications.models) listener();
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(notifications.models.size).toBe(0);
  });
  it('aborts its in-flight refresh when the manager is unmounted', async () => {
    vi.mocked(llamaCppBrowserService.listModels).mockImplementation(async () => new Promise(() => {}));
    const wrapper = render(); await flushPromises();
    const signal = vi.mocked(llamaCppBrowserService.listModels).mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(signal?.aborted).toBe(true);
  });
  it('repeats an in-flight OPFS refresh when the model list changes before it completes', async () => {
    let finishRead: ((models: LocalModel[]) => void) | undefined;
    vi.mocked(llamaCppBrowserService.listModels).mockImplementationOnce(() => new Promise(resolve => {
      finishRead = resolve;
    })).mockResolvedValue([storedModel]);
    const wrapper = render(); await flushPromises();
    expect(wrapper.find('[data-testid="llama-cpp-browser-list-loading"]').exists()).toBe(true);
    for (const listener of notifications.models) listener();
    finishRead?.([]); await flushPromises();
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
  });
  it('does not lose a list change queued as the previous refresh settles', async () => {
    vi.mocked(llamaCppBrowserService.listModels).mockImplementationOnce(() => Promise.resolve([]).then(found => {
      queueMicrotask(() => queueMicrotask(() => {
        for (const listener of notifications.models) listener();
      }));
      return found;
    })).mockResolvedValue([storedModel]);
    const wrapper = render(); await flushPromises();
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
  });
  it('clears an old listing error after a successful manual refresh', async () => {
    vi.mocked(llamaCppBrowserService.listModels).mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'storage-error' })).mockResolvedValue([storedModel]);
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('storage-error');
    await wrapper.get('[data-testid="llama-cpp-browser-refresh"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
  });
  it('allows deletion while inference is active and previews the confirmed files and explains stale plans without raw errors', async () => {
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel]);
    vi.mocked(llamaCppBrowserService.removeModel).mockResolvedValueOnce('changed');
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'working', progress: { phase: 'generating', completed: 1, total: 0 } });
    const wrapper = render(); await flushPromises();
    await wrapper.get(`[data-testid="llama-cpp-browser-delete-${storedModel.id}"]`).trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-delete-details"]').text()).toContain('local.gguf');
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click'); await flushPromises();
    expect(llamaCppBrowserService.removeModel).toHaveBeenCalledWith({ plan: { id: storedModel.id, files: [{ path: 'local.gguf', size: 16384, lastModified: 1 }] }, signal: expect.any(AbortSignal) });
    expect(wrapper.get('[data-testid="llama-removal-changed"]').text()).toContain('Deletion stopped because the files changed');
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledTimes(2);
  });
  it('does not delete after confirmation if the manager has been unmounted', async () => {
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel]);
    const wrapper = render(); await flushPromises();
    await wrapper.get(`[data-testid="llama-cpp-browser-delete-${storedModel.id}"]`).trigger('click'); await flushPromises();
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    await flushPromises();
    expect(llamaCppBrowserService.removeModel).not.toHaveBeenCalled();
  });
  it('allows an explicit profile override without changing the default on its own', async () => {
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-profile"]').setValue('cpu-wasm32');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'cpu-wasm32' } });
    await wrapper.get('[data-testid="llama-cpp-browser-profile"]').setValue('webgpu-wasm32-asyncify');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'webgpu-wasm32-asyncify' } });
    expect(wrapper.find('[data-testid="llama-cpp-browser-context"]').exists()).toBe(false);
  });
});
