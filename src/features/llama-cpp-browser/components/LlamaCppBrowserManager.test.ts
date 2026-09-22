import type { ProfileCapabilities, ProfileState } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import LlamaCppBrowserManager from './LlamaCppBrowserManager.vue';
import { LlamaCppBrowserError, type EngineState, type LocalModel, type RuntimeOptions } from '@/features/llama-cpp-browser/types';

const notifications = vi.hoisted(() => ({
  capabilities: new Set<(event: { state: ProfileState }) => void>(),
  state: new Set<(event: { state: EngineState }) => void>(),
  models: new Set<() => void>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  profiles: [] as RuntimeOptions['profile'][],
}));
vi.mock('@/features/llama-cpp-browser/runtime/profile-policy', () => ({ selectableProfiles: notifications.profiles }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: {
  getProfileState: vi.fn<() => ProfileState>(() => ({ status: 'idle' })),
  probeProfiles: vi.fn(),
  subscribeProfiles: vi.fn(({ listener }: { listener: (event: { state: ProfileState }) => void }) => {
    notifications.capabilities.add(listener); return () => {
      notifications.capabilities.delete(listener);
    };
  }),
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
// Entry callbacks are asynchronous even though drag data must be captured during
// dispatch. Plain files-only drop mocks miss both that gap and focus/list races.
function deferredFileDrop({ file }: { file: File }) {
  const read = Promise.withResolvers<File>();
  const entry = {
    isFile: true, isDirectory: false, name: file.name,
    file: (resolve: FileCallback, reject: ErrorCallback) => {
      void read.promise.then(resolve, reject);
    },
  };
  let readable = true;
  const transfer = {
    types: ['Files'],
    get items() {
      return readable ? [{ kind: 'file', webkitGetAsEntry: () => entry }] : [];
    },
    get files() {
      return readable ? [file] : [];
    },
  } as unknown as DataTransfer;
  return { transfer, read, protect: () => {
    readable = false;
  } };
}
function dispatchDrop({ wrapper, transfer }: { wrapper: VueWrapper, transfer: DataTransfer }): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').element.dispatchEvent(event);
  return event;
}
beforeEach(async () => {
  vi.clearAllMocks(); notifications.capabilities.clear(); notifications.state.clear(); notifications.models.clear();
  vi.mocked(llamaCppBrowserService.getProfileState).mockReturnValue({ status: 'idle' });
  vi.mocked(llamaCppBrowserService.probeProfiles).mockImplementation(async () => {
    const capabilities: ProfileCapabilities = { recommended: 'webgpu-wasm64-jspi', profiles: [
      { profile: 'webgpu-wasm64-jspi', status: 'available' }, { profile: 'webgpu-wasm32-jspi', status: 'available' },
      { profile: 'webgpu-wasm32-asyncify', status: 'available' }, { profile: 'cpu-wasm64', status: 'available' }, { profile: 'cpu-wasm32', status: 'available' },
    ] };
    for (const listener of notifications.capabilities) listener({ state: { status: 'ready', capabilities } });
    return capabilities;
  });
  notifications.confirm.mockResolvedValue(true);
  notifications.profiles.splice(0, notifications.profiles.length, 'auto', 'cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi');
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
  it('filters imported names without changing the underlying list and shares default-model confirmation', async () => {
    const second = { ...storedModel, id: 'user/second', name: 'Qwen-Q8_0.gguf' };
    vi.mocked(llamaCppBrowserService.listModels).mockResolvedValue([storedModel, second]);
    const applyDefaultModel = vi.fn(async () => 'applied' as const);
    const wrapper = mount(LlamaCppBrowserManager, { props: { defaultModel: { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'old' }, applyDefaultModel }, global: { stubs: { Teleport: true } } }); wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="llama-imported-model-search"]').setValue('QWEN');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('Qwen-Q8_0.gguf');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).not.toContain('local.gguf');
    await wrapper.get('[data-testid="llama-cpp-browser-model-list"] [data-testid="llama-default-model-action"]').trigger('click');
    expect(applyDefaultModel).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-default-confirm"]').trigger('click'); await flushPromises();
    expect(applyDefaultModel).toHaveBeenCalledWith(expect.objectContaining({ model: second }));
    await wrapper.get('[data-testid="llama-imported-model-search"]').setValue('no match');
    expect(wrapper.find('[data-testid="llama-imported-model-no-results"]').exists()).toBe(true);
    await wrapper.get('[data-testid="llama-imported-model-clear-search"]').trigger('click');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').findAll('li')).toHaveLength(2);
  });
  it('shows the resolved automatic profile and disables unavailable choices without disabling model storage', async () => {
    vi.mocked(llamaCppBrowserService.probeProfiles).mockImplementation(async () => {
      const capabilities: ProfileCapabilities = { recommended: 'webgpu-wasm32-jspi', profiles: [
        { profile: 'webgpu-wasm32-jspi', status: 'available' },
        { profile: 'webgpu-wasm64-jspi', status: 'unavailable', reason: 'memory64' },
      ] };
      for (const listener of notifications.capabilities) listener({ state: { status: 'ready', capabilities } });
      return capabilities;
    });
    const wrapper = render(); await flushPromises();
    const select = wrapper.get<HTMLSelectElement>('[data-testid="llama-cpp-browser-profile"]');
    expect(select.get('option[value="auto"]').text()).toBe('Automatic (WebGPU / wasm32 / JSPI)');
    expect(select.get('option[value="webgpu-wasm64-jspi"]').attributes('disabled')).toBeDefined();
    expect(select.get('option[value="webgpu-wasm32-jspi"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('runtimeReady')?.at(-1)).toEqual([true]);
    for (const listener of notifications.capabilities) listener({ state: { status: 'idle' } });
    await flushPromises();
    expect(wrapper.emitted('runtimeReady')?.at(-1)).toEqual([false]);
    expect(wrapper.find('[data-testid="llama-cpp-browser-probe-profiles"]').exists()).toBe(true);
    expect(llamaCppBrowserService.probeProfiles).toHaveBeenCalledOnce();
  });
  it('shows pending detection and cancels only its observer when closed', async () => {
    vi.mocked(llamaCppBrowserService.getProfileState).mockReturnValue({ status: 'checking' });
    vi.mocked(llamaCppBrowserService.probeProfiles).mockReturnValue(new Promise(() => {}));
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-profile-checking"]').text()).toBe('Checking browser support…');
    expect(wrapper.emitted('runtimeReady')?.at(-1)).toEqual([false]);
    const signal = vi.mocked(llamaCppBrowserService.probeProfiles).mock.calls[0]?.[0].signal;
    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
    expect(llamaCppBrowserService.release).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.cancel).not.toHaveBeenCalled();
  });
  it('shows terminal errors without automatically retrying and allows manual retry', async () => {
    vi.mocked(llamaCppBrowserService.probeProfiles).mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'worker-failed' }));
    const wrapper = render(); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(llamaCppBrowserService.probeProfiles).toHaveBeenCalledOnce();
    await wrapper.get('[data-testid="llama-cpp-browser-probe-profiles"]').trigger('click'); await flushPromises();
    expect(llamaCppBrowserService.probeProfiles).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('runtimeReady')?.at(-1)).toEqual([true]);
  });
  it('allows either standalone JSPI profile while model operations remain available', async () => {
    notifications.profiles.splice(0, notifications.profiles.length, 'auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi');
    vi.mocked(llamaCppBrowserService.getOptions).mockReturnValue({ profile: 'webgpu-wasm64-jspi' });
    const wrapper = render(); await flushPromises();
    const select = wrapper.get<HTMLSelectElement>('[data-testid="llama-cpp-browser-profile"]');
    expect(select.element.value).toBe('webgpu-wasm64-jspi');
    expect(select.element.disabled).toBe(false);
    expect(select.findAll('option').map(option => option.element.value)).toEqual(['auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi']);
    await select.setValue('webgpu-wasm32-jspi');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'webgpu-wasm32-jspi' } });
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined();
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledOnce();
    expect(llamaCppBrowserService.setOptions).toHaveBeenCalledOnce();
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
  it('accepts a drop while returning window focus is still refreshing the model list', async () => {
    const wrapper = render(); await flushPromises();
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModels).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus')); await flushPromises();
    expect(wrapper.find('[data-testid="llama-cpp-browser-list-loading"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(false);
    const transfer = { files: [new File(['fixture'], 'local.gguf')], types: ['Files'], dropEffect: 'none' };
    const zone = wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]');
    await zone.trigger('dragenter', { dataTransfer: transfer });
    await zone.trigger('dragover', { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe('copy');
    await zone.trigger('drop', { dataTransfer: transfer }); await flushPromises();
    // Do not wait for listing before accepting or reading the user's drop.
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledOnce();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls[0]?.[0].file).toBe(transfer.files[0]);
    listing.resolve([]); await flushPromises();
    expect(llamaCppBrowserService.listModels).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
  it('accepts a drop before the initial local listing has finished', async () => {
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModels).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [new File(['fixture'], 'local.gguf')], types: ['Files'] },
    });
    await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledOnce();
    listing.resolve([]); await flushPromises();
    expect(wrapper.emitted('modelsChanged')).toEqual([[ [storedModel] ]]);
  });
  it.each(['file', 'directory'] as const)('keeps a %s picker result when focus refresh overlaps change', async source => {
    const wrapper = render(); await flushPromises();
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModels).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus')); await flushPromises();
    const file = new File(['fixture'], 'weights.gguf');
    if (source === 'directory') Object.defineProperty(file, 'webkitRelativePath', { value: 'original-GGUF/nested/weights.gguf' });
    const input = wrapper.get<HTMLInputElement>(`[data-testid="llama-cpp-browser-${source}"]`);
    Object.defineProperty(input.element, 'files', { value: [file] });
    expect(input.element.matches(':disabled')).toBe(false);
    await input.trigger('change'); await flushPromises();
    if (source === 'directory') {
      expect(llamaCppBrowserService.importDirectory).toHaveBeenCalledWith({ directory: { name: 'original-GGUF', files: [{ path: 'nested/weights.gguf', file }] }, signal: expect.any(AbortSignal) });
      expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    } else {
      expect(llamaCppBrowserService.importModel).toHaveBeenCalledWith({ file, signal: expect.any(AbortSignal) });
      expect(llamaCppBrowserService.importDirectory).not.toHaveBeenCalled();
    }
    expect(input.element.value).toBe('');
    listing.resolve([]); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
  it('captures drag entries during dispatch and retains them across a later focus refresh', async () => {
    const wrapper = render(); await flushPromises();
    const file = new File(['fixture'], 'local.gguf');
    const drop = deferredFileDrop({ file });
    const event = dispatchDrop({ wrapper, transfer: drop.transfer });
    // A real DataTransfer stops exposing entries/files when dispatch ends.
    drop.protect();
    expect(event.defaultPrevented).toBe(true);
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModels).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus')); await flushPromises();
    drop.read.resolve(file); await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledWith({ file, signal: expect.any(AbortSignal) });
    listing.resolve([]); await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('local.gguf');
  });
  it('retains a dropped directory and its relative paths across focus refresh during traversal', async () => {
    const wrapper = render(); await flushPromises();
    const file = new File(['fixture'], 'weights.gguf');
    const read = Promise.withResolvers<File>();
    const child = {
      isFile: true, isDirectory: false, name: file.name,
      file: (resolve: FileCallback, reject: ErrorCallback) => {
        void read.promise.then(resolve, reject);
      },
    };
    function directoryEntry({ name, entries }: { name: string, entries: unknown[] }) {
      return { isDirectory: true, isFile: false, name, createReader: () => {
        let delivered = false;
        return { readEntries: (resolve: (entries: unknown[]) => void) => {
          const batch = delivered ? [] : entries; delivered = true;
          queueMicrotask(() => resolve(batch));
        } };
      } };
    }
    const folder = directoryEntry({ name: 'original-GGUF', entries: [directoryEntry({ name: 'nested', entries: [child] })] });
    const items = [{ kind: 'file', webkitGetAsEntry: () => folder }];
    dispatchDrop({ wrapper, transfer: { items, files: [], types: ['Files'] } as unknown as DataTransfer });
    items.splice(0); await flushPromises();
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModels).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus')); await flushPromises();
    read.resolve(file); await flushPromises();
    expect(llamaCppBrowserService.importDirectory).toHaveBeenCalledWith({ directory: { name: 'original-GGUF', files: [{ path: 'nested/weights.gguf', file }] }, signal: expect.any(AbortSignal) });
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    listing.resolve([]); await flushPromises();
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
  it('reserves the import before asynchronous drop enumeration and rejects a second drop', async () => {
    const wrapper = render(); await flushPromises();
    const file = new File(['first'], 'first.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer }); drop.protect(); await flushPromises();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.findComponent({ name: 'LlamaCppBrowserHuggingFaceManager' }).props('disabled')).toBe(true);
    const second = new File(['second'], 'second.gguf');
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [second], types: ['Files'] },
    });
    await flushPromises();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    drop.read.resolve(file); await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual([file]);
    // The lane is released once this import (and its list refresh) has completed.
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [second], types: ['Files'] },
    });
    await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual([file, second]);
  });
  it.each(['cancel', 'unmount'] as const)('does not import a late entry after %s during drop enumeration', async action => {
    const wrapper = render(); await flushPromises();
    const file = new File(['fixture'], 'late.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer }); drop.protect(); await flushPromises();
    if (action === 'cancel') await wrapper.get('[data-testid="llama-cpp-browser-cancel"]').trigger('click');
    else {
      wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    }
    drop.read.resolve(file); await flushPromises();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importDirectory).not.toHaveBeenCalled();
    if (action === 'cancel') {
      expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(false);
    } else expect(llamaCppBrowserService.listModels).toHaveBeenCalledOnce();
  });
  it('reports entry read failures without raw paths and releases the import controls for retry', async () => {
    const wrapper = render(); await flushPromises();
    const file = new File(['fixture'], 'local.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer }); drop.protect(); await flushPromises();
    drop.read.reject(new DOMException('/private/path/local.gguf', 'NotReadableError')); await flushPromises();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).not.toContain('/private/path');
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(false);
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledOnce();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
  it('still refuses a local drop while the runtime is working', async () => {
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'working', progress: { phase: 'generating', completed: 1, total: 0 } });
    const wrapper = render(); await flushPromises();
    const file = new File(['fixture'], 'local.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer }); drop.protect();
    drop.read.resolve(file); await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importDirectory).not.toHaveBeenCalled();
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
    await wrapper.get('[data-testid="llama-cpp-browser-profile"]').setValue('webgpu-wasm32-jspi');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'webgpu-wasm32-jspi' } });
    await wrapper.get('[data-testid="llama-cpp-browser-profile"]').setValue('webgpu-wasm32-asyncify');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'webgpu-wasm32-asyncify' } });
    expect(wrapper.find('[data-testid="llama-cpp-browser-context"]').exists()).toBe(false);
  });
});


describe('cancelled dropped-file retry', () => {
  it('keeps input disabled through rollback and accepts the same drop after cancellation settles', async () => {
    const wrapper = render(); await flushPromises();
    const rollback = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    vi.mocked(llamaCppBrowserService.importModel).mockImplementationOnce(async input => {
      signal = input.signal; await rollback.promise;
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    const file = new File(['fixture'], 'same.gguf');
    const transfer = { files: [file], types: ['Files'] } as unknown as DataTransfer;
    dispatchDrop({ wrapper, transfer }); await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-cancel"]').trigger('click');
    expect(signal?.aborted).toBe(true);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    dispatchDrop({ wrapper, transfer }); await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledOnce();
    rollback.resolve(); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(false);
    dispatchDrop({ wrapper, transfer }); await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual([file, file]);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
