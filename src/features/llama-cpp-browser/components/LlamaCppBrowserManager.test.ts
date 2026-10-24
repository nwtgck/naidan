import { localModelDirectory } from './model-directory.test-support';
import { repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import { modelRemovalPlan } from './model-removal.test-support';
import type { ModelImportReceipt } from '@/features/llama-cpp-browser/model-files';
import type { ProfileCapabilities, ProfileState } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import LlamaCppBrowserManager from './LlamaCppBrowserManager.vue';
import { LlamaCppBrowserError, type EngineState, type LocalModel, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
import { modelSuggestions, preferredQuantizationHint } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { runtimeProfileControl } from './model-configuration.test-support';
import { searchModels } from '@/features/llama-cpp-browser/hugging-face/catalog';

vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), searchModels: vi.fn() }));

const notifications = vi.hoisted(() => ({
  capabilities: new Set<(event: { state: ProfileState }) => void>(),
  state: new Set<(event: { state: EngineState }) => void>(),
  models: new Set<() => void>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  profiles: [] as RuntimeOptions['profile'][],
}));
vi.mock('@/features/llama-cpp-browser/runtime/profile-policy', () => ({ selectableProfiles: notifications.profiles }));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    getProfileState: vi.fn<() => ProfileState>(() => ({ status: 'idle' })),
    probeProfiles: vi.fn(),
    subscribeProfiles: vi.fn(({ listener }: { listener: (event: { state: ProfileState }) => void }) => {
      notifications.capabilities.add(listener);
      return () => {
        notifications.capabilities.delete(listener);
      };
    }),
    getState: vi.fn<() => EngineState>(() => ({ status: 'idle' })),
    getOptions: vi.fn(() => ({ profile: 'auto' })),
    subscribe: vi.fn(({ listener }: { listener: (event: { state: EngineState }) => void }) => {
      notifications.state.add(listener);
      return () => {
        notifications.state.delete(listener);
      };
    }),
    subscribeModelList: vi.fn(({ listener }: { listener: () => void }) => {
      notifications.models.add(listener);
      return () => {
        notifications.models.delete(listener);
      };
    }),
    listModelEntries: vi.fn(async () => []),
    setOptions: vi.fn(),
    importModel: vi.fn(),
    importDirectory: vi.fn(),
    removeModel: vi.fn(),
    removeTemporaryModel: vi.fn(),
    release: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock('@/features/llama-cpp-browser/model-files', async () => {
  const { llamaCppBrowserService } = await import('@/features/llama-cpp-browser');
  return { llamaCppBrowserModelFiles: { ...llamaCppBrowserService, subscribeModelImports: () => () => {} } };
});
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ listPendingDownloads: vi.fn(async () => []), installedSelection: vi.fn(async () => undefined), repositoryDirectories: vi.fn(async () => []) }));
vi.mock('../runtime/model-store', () => ({ prepareModelRemoval: vi.fn(), prepareRepositoryRemoval: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: notifications.confirm }) }));
const storedModel: LocalModel = { modelId: 'user/local-GGUF', size: 16384, importedAt: 1 };
const storedReceipt: ModelImportReceipt = { storage: 'opfs', models: [storedModel], publication: { generation: 1, isCurrent: () => true } };
const wrappers: VueWrapper[] = [];

function render(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserManager);
  wrappers.push(wrapper);
  return wrapper;
}

// Entry callbacks are asynchronous even though drag data must be captured during
// dispatch. Plain files-only drop mocks miss both that gap and focus/list races.
function deferredFileDrop({ file }: { file: File }) {
  const read = Promise.withResolvers<File>();
  const entry = {
    isFile: true,
    isDirectory: false,
    name: file.name,
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
  return {
    transfer,
    read,
    protect: () => {
      readable = false;
    },
  };
}

function dispatchDrop({ wrapper, transfer }: { wrapper: VueWrapper, transfer: DataTransfer }): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').element.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  vi.clearAllMocks();
  notifications.capabilities.clear();
  notifications.state.clear();
  notifications.models.clear();
  vi.mocked(llamaCppBrowserService.getProfileState).mockReturnValue({ status: 'idle' });
  vi.mocked(llamaCppBrowserService.probeProfiles).mockImplementation(async () => {
    const capabilities: ProfileCapabilities = {
      recommended: 'webgpu-wasm64-jspi',
      profiles: [
        { profile: 'webgpu-wasm64-jspi', status: 'available' }, { profile: 'webgpu-wasm32-jspi', status: 'available' },
        { profile: 'webgpu-wasm32-asyncify', status: 'available' }, { profile: 'cpu-wasm32', status: 'available' },
      ],
    };
    for (const listener of notifications.capabilities) {
      listener({ state: { status: 'ready', capabilities } });
    }
    return capabilities;
  });
  notifications.confirm.mockResolvedValue(true);
  notifications.profiles.splice(0, notifications.profiles.length, 'auto', 'cpu-wasm32', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi');
  vi.mocked(llamaCppBrowserService.getOptions).mockReturnValue({ profile: 'auto' });
  vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'idle' });
  vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([]);
  vi.mocked(llamaCppBrowserService.importModel).mockResolvedValue(storedReceipt);
  vi.mocked(llamaCppBrowserService.removeModel).mockResolvedValue('deleted');
  vi.mocked(prepareModelRemoval).mockResolvedValue({ plan: modelRemovalPlan({ modelId: storedModel.modelId, files: [{ relativePath: 'local.gguf', size: 16384, lastModified: 1 }] }), sharedPlan: undefined, affectedVariants: 0 });
  await ensureAllStringsForTest({ locale: 'en' });
  vi.mocked(searchModels).mockReset().mockResolvedValue({ results: [], nextCursor: undefined });
});

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
  await flushPromises();
  vi.restoreAllMocks();
});

describe('local GGUF manager', () => {
  it('keeps search active without a busy feedback loop and aborts it when suspended', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockReturnValueOnce(pending.promise);
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    const signal = vi.mocked(searchModels).mock.calls[0]![0].signal;
    expect(signal.aborted).toBe(false);
    expect(wrapper.get('[data-testid="llama-hf-search"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-import-mode-host"]').element.matches(':disabled')).toBe(false);
    await wrapper.setProps({ suspended: true });
    expect(signal.aborted).toBe(true);
    expect(wrapper.get('[data-testid="llama-hf-search-query"]').attributes('disabled')).toBeDefined();
    pending.resolve({ results: [{ id: 'old/model' }], nextCursor: undefined });
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-search-result"]').exists()).toBe(false);
    await wrapper.setProps({ suspended: false });
    await flushPromises();
    expect(searchModels).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="llama-hf-search"]').attributes('aria-busy')).toBe('false');
  });

  it('loads models with suspension omitted and leaves normal model operations enabled', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
    expect(wrapper.get('[data-testid="llama-cpp-browser-refresh"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="llama-cpp-browser-import"] fieldset').attributes('disabled')).toBeUndefined();
  });

  it('skips refresh triggers while suspended and reads the latest models when resumed', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const wrapper = mount(LlamaCppBrowserManager, { props: { suspended: true } });
    wrappers.push(wrapper);
    await flushPromises();
    for (const listener of notifications.models) {
      listener();
    }
    window.dispatchEvent(new Event('focus'));
    await wrapper.get('[data-testid="llama-cpp-browser-refresh"]').trigger('click');
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).not.toHaveBeenCalled();

    await wrapper.setProps({ suspended: false });
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(wrapper.emitted('modelsChanged')).toEqual([[[storedModel]]]);

    await wrapper.setProps({ suspended: true });
    for (const listener of notifications.models) {
      listener();
    }
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);

    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([]);
    await wrapper.setProps({ suspended: false });
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('modelsChanged')?.at(-1)).toEqual([[]]);
  });

  it.each(['resolve', 'reject'] as const)('discards a suspended refresh that later %s without reporting a stale result or error', async settlement => {
    const read = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(read.promise).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    const signal = vi.mocked(llamaCppBrowserService.listModelEntries).mock.calls[0]?.[0].signal;
    for (const listener of notifications.models) {
      listener();
    }
    await wrapper.setProps({ suspended: true });
    expect(signal?.aborted).toBe(true);
    if (settlement === 'resolve') {
      read.resolve([]);
    } else {
      read.reject(new LlamaCppBrowserError({ code: 'storage-error' }));
    }
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(wrapper.emitted('modelsChanged')).toBeUndefined();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.setProps({ suspended: false });
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('modelsChanged')).toEqual([[[storedModel]]]);
  });

  it('retains a resume request until an aborted refresh settles without overlapping reads', async () => {
    const read = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(read.promise).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    const signal = vi.mocked(llamaCppBrowserService.listModelEntries).mock.calls[0]?.[0].signal;
    await wrapper.setProps({ suspended: true });
    expect(signal?.aborted).toBe(true);
    await wrapper.setProps({ suspended: false });
    for (const listener of notifications.models) {
      listener();
    }
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    read.resolve([]);
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('modelsChanged')).toEqual([[[storedModel]]]);
    expect(vi.mocked(llamaCppBrowserService.listModelEntries).mock.calls[1]?.[0].signal?.aborted).toBe(false);
  });

  it('does not restart an aborted refresh when unmounted before the pending resume', async () => {
    const read = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(read.promise);
    const wrapper = render();
    await flushPromises();
    await wrapper.setProps({ suspended: true });
    await wrapper.setProps({ suspended: false });
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    read.resolve([storedModel]);
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(wrapper.emitted('modelsChanged')).toBeUndefined();
  });

  it('does not select a model from an old preparation after suspension and resume', async () => {
    const wrapper = render();
    await flushPromises();
    const read = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(read.promise).mockResolvedValue([storedModel]);
    wrapper.findComponent({ name: 'LlamaCppBrowserHuggingFaceManager' }).vm.$emit('modelReady', storedModel);
    await flushPromises();
    await wrapper.setProps({ suspended: true });
    await wrapper.setProps({ suspended: false });
    read.resolve([storedModel]);
    await flushPromises();
    expect(wrapper.emitted('modelSelected')).toBeUndefined();
    expect(wrapper.emitted('modelsChanged')?.at(-1)).toEqual([[storedModel]]);
    wrapper.findComponent({ name: 'LlamaCppBrowserHuggingFaceManager' }).vm.$emit('modelReady', storedModel);
    await flushPromises();
    expect(wrapper.emitted('modelSelected')).toEqual([[storedModel.modelId]]);
  });

  it('lists browser storage and all linked roots together using public model IDs and no source selector', async () => {
    const first: LocalModel = {
      modelId: 'host/MyModels1/owner/repo:model',
      size: 128,
      importedAt: 1,
      source: { kind: 'host', directoryId: 'root-a', directoryName: 'MyModels1', repository: 'owner/repo', primaryRelativePath: 'model.gguf' },
    };
    const second: LocalModel = {
      ...first,
      modelId: 'host/MyModels2/owner/repo:model',
      source: { kind: 'host', directoryId: 'root-b', directoryName: 'MyModels2', repository: 'owner/repo', primaryRelativePath: 'model.gguf' },
    };
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel, first, second]);
    const wrapper = render();
    await flushPromises();
    const list = wrapper.get('[data-testid="llama-cpp-browser-model-list"]');
    expect(list.findAll('li')).toHaveLength(3);
    expect(list.findAll('[data-testid="llama-imported-model-name"]').map(name => name.text())).toEqual([storedModel.modelId, first.modelId, second.modelId]);
    expect(list.findAll('[data-testid="llama-imported-model-name"]').map(name => name.attributes('title'))).toEqual([undefined, 'model.gguf', 'model.gguf']);
    expect(list.find('[data-testid="llama-download-destination"]').exists()).toBe(false);
    const search = wrapper.get('[data-testid="llama-imported-model-search"]');
    expect(search.attributes('aria-label')).toBe('Search models');
    await search.setValue('MyModels2');
    expect(list.findAll('li')).toHaveLength(1);
    expect(wrapper.emitted('modelsChanged')?.[0]?.[0]).toEqual([storedModel, first, second]);
  });

  it('shows shared public IDs for split GGUFs and keeps physical paths in collapsed details and title tooltips', async () => {
    const variants = [
      { variant: 'Q4_K_M', path: 'Q4_K_M/Model-Q4_K_M-00001-of-00002.gguf' },
      { variant: 'Q5_K_M', path: 'Q5_K_M/Model-Q5_K_M-00001-of-00003.gguf' },
      { variant: 'Q8_0', path: 'Q8_0/Model-Q8_0-00001-of-00004.gguf' },
    ];
    const models: LocalModel[] = variants.map(({ variant, path }) => ({
      modelId: `host/MyModels1/alice/Model-GGUF:${variant}`,
      size: 128,
      importedAt: 1,
      source: {
        kind: 'host',
        directoryId: 'root-a',
        directoryName: 'MyModels1',
        repository: 'alice/Model-GGUF',
        primaryRelativePath: path,
      },
    }));
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue(models);
    const wrapper = render();
    await flushPromises();
    const list = wrapper.get('[data-testid="llama-cpp-browser-model-list"]');
    expect(list.findAll('[data-testid="llama-imported-model-name"]').map(name => name.text())).toEqual([
      'host/MyModels1/alice/Model-GGUF:Q4_K_M',
      'host/MyModels1/alice/Model-GGUF:Q5_K_M',
      'host/MyModels1/alice/Model-GGUF:Q8_0',
    ]);
    expect(list.findAll('[data-testid="llama-imported-model-name"]').map(name => name.attributes('title'))).toEqual(variants.map(({ path }) => path));
    for (const [index, { path }] of variants.entries()) {
      const details = wrapper.get(`[data-testid="llama-imported-model-details-${models[index]!.modelId}"]`);
      expect(details.attributes('aria-hidden')).toBe('true');
      expect(wrapper.get(`[data-testid="llama-imported-model-details-toggle-${models[index]!.modelId}"]`).text()).not.toContain(path);
      expect(details.get('[data-testid="llama-imported-model-detail-file"]').text()).toBe(path);
    }
    await wrapper.get('[data-testid="llama-imported-model-search"]').setValue('host/MyModels1/alice/Model-GGUF:Q8_0');
    expect(list.findAll('[data-testid="llama-imported-model-name"]').map(name => name.text())).toEqual([
      'host/MyModels1/alice/Model-GGUF:Q8_0',
    ]);
    expect(wrapper.emitted('modelsChanged')?.[0]?.[0]).toEqual(models);
  });

  it('filters imported names without changing the underlying list and shares default-model confirmation', async () => {
    const second = { ...storedModel, modelId: 'user/Qwen-Q8_0-GGUF' };
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel, second]);
    const applyDefaultModel = vi.fn(async () => 'applied' as const);
    const wrapper = mount(LlamaCppBrowserManager, { props: { defaultModel: { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'old' }, applyDefaultModel }, global: { stubs: { Teleport: true } } });
    wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="llama-imported-model-search"]').setValue('QWEN');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('user/Qwen-Q8_0-GGUF');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).not.toContain(storedModel.modelId);
    await wrapper.get('[data-testid="llama-cpp-browser-model-list"] [data-testid="llama-default-model-action"]').trigger('click');
    expect(applyDefaultModel).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-default-confirm"]').trigger('click');
    await flushPromises();
    expect(applyDefaultModel).toHaveBeenCalledWith(expect.objectContaining({ model: second }));
    await wrapper.get('[data-testid="llama-imported-model-search"]').setValue('no match');
    expect(wrapper.find('[data-testid="llama-imported-model-no-results"]').exists()).toBe(true);
    await wrapper.get('[data-testid="llama-imported-model-clear-search"]').trigger('click');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').findAll('li')).toHaveLength(2);
  });

  it('rejects a renamed model selection rather than following its previous identity', async () => {
    const selected = { ...storedModel, modelId: 'host/OldFolder/owner/repo:Q4' };
    const available = { ...selected, modelId: 'host/MyModels1/owner/repo:Q4' };
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([selected]);
    const applyDefaultModel = vi.fn(async () => 'applied' as const);
    const wrapper = mount(LlamaCppBrowserManager, { props: { defaultModel: { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'old' }, applyDefaultModel }, global: { stubs: { Teleport: true } } });
    wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-model-list"] [data-testid="llama-default-model-action"]').trigger('click');
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([available]);
    await wrapper.get('[data-testid="llama-default-confirm"]').trigger('click');
    await flushPromises();
    expect(applyDefaultModel).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="llama-default-model-dialog"] [role="alert"]').exists()).toBe(true);
  });

  it('shows the resolved automatic profile and disables unavailable choices without disabling model storage', async () => {
    vi.mocked(llamaCppBrowserService.probeProfiles).mockImplementation(async () => {
      const capabilities: ProfileCapabilities = {
        recommended: 'webgpu-wasm32-jspi',
        profiles: [
          { profile: 'webgpu-wasm32-jspi', status: 'available' },
          { profile: 'webgpu-wasm64-jspi', status: 'unavailable', reason: 'memory64' },
        ],
      };
      for (const listener of notifications.capabilities) {
        listener({ state: { status: 'ready', capabilities } });
      }
      return capabilities;
    });
    const wrapper = render();
    await flushPromises();
    const select = runtimeProfileControl({ view: wrapper });
    expect(select.props('options')).toContainEqual(expect.objectContaining({ value: 'auto', label: 'Automatic (WebGPU / wasm32 / JSPI)' }));
    expect(select.props('options')).toContainEqual(expect.objectContaining({ value: 'webgpu-wasm64-jspi', disabled: true }));
    expect(select.props('options')).toContainEqual(expect.objectContaining({ value: 'webgpu-wasm32-jspi', disabled: false }));
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('runtimeReady')?.at(-1)).toEqual([true]);
    for (const listener of notifications.capabilities) {
      listener({ state: { status: 'idle' } });
    }
    await flushPromises();
    expect(wrapper.emitted('runtimeReady')?.at(-1)).toEqual([false]);
    expect(wrapper.find('[data-testid="llama-cpp-browser-probe-profiles"]').exists()).toBe(true);
    expect(llamaCppBrowserService.probeProfiles).toHaveBeenCalledOnce();
  });

  it('shows pending detection and cancels only its observer when closed', async () => {
    vi.mocked(llamaCppBrowserService.getProfileState).mockReturnValue({ status: 'checking' });
    vi.mocked(llamaCppBrowserService.probeProfiles).mockReturnValue(new Promise(() => {}));
    const wrapper = render();
    await flushPromises();
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
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(llamaCppBrowserService.probeProfiles).toHaveBeenCalledOnce();
    await wrapper.get('[data-testid="llama-cpp-browser-probe-profiles"]').trigger('click');
    await flushPromises();
    expect(llamaCppBrowserService.probeProfiles).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('runtimeReady')?.at(-1)).toEqual([true]);
  });

  it('allows either standalone JSPI profile while model operations remain available', async () => {
    notifications.profiles.splice(0, notifications.profiles.length, 'auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi');
    vi.mocked(llamaCppBrowserService.getOptions).mockReturnValue({ profile: 'webgpu-wasm64-jspi' });
    const wrapper = render();
    await flushPromises();
    const select = runtimeProfileControl({ view: wrapper });
    expect(select.props('modelValue')).toBe('webgpu-wasm64-jspi');
    expect(select.get('button').element.matches(':disabled')).toBe(false);
    expect(select.props('options')).toEqual(['auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'].map(value => expect.objectContaining({ value })));
    await select.setValue('webgpu-wasm32-jspi');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'webgpu-wasm32-jspi' } });
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(llamaCppBrowserService.setOptions).toHaveBeenCalledOnce();
  });

  it('refreshes model choices and forwards the prepared model instead of choosing the first entry', async () => {
    const wrapper = render();
    await flushPromises();
    const target = { ...storedModel, modelId: 'hf.co/owner/repo:Q8_0' };
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel, target]);
    wrapper.findComponent({ name: 'LlamaCppBrowserHuggingFaceManager' }).vm.$emit('modelReady', target);
    await flushPromises();
    expect(wrapper.emitted('modelsChanged')?.at(-1)).toEqual([[storedModel, target]]);
    expect(wrapper.emitted('modelSelected')).toEqual([[target.modelId]]);
  });

  it('does not select an earlier prepared model after the HF selection changes during list refresh', async () => {
    const wrapper = render();
    await flushPromises();
    const refreshed = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValue(refreshed.promise);
    const child = wrapper.findComponent({ name: 'LlamaCppBrowserHuggingFaceManager' });
    child.vm.$emit('modelReady', storedModel);
    await flushPromises();
    child.vm.$emit('selectionChanged');
    refreshed.resolve([storedModel]);
    await flushPromises();
    expect(wrapper.emitted('modelsChanged')?.at(-1)).toEqual([[storedModel]]);
    expect(wrapper.emitted('modelSelected')).toBeUndefined();
  });

  it('imports a selected folder with its original root and relative paths', async () => {
    const wrapper = render();
    await flushPromises();
    const file = new File(['fixture'], 'weights.gguf');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'my-Qwen-VL-GGUF/nested/weights.gguf' });
    const input = wrapper.get('[data-testid="llama-cpp-browser-directory"]');
    expect(input.attributes('webkitdirectory')).toBeDefined();
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();
    expect(llamaCppBrowserService.importDirectory).toHaveBeenCalledWith({ directory: { rootName: 'my-Qwen-VL-GGUF', files: [{ relativePath: 'nested/weights.gguf', file }] }, signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
  });

  it('keeps controls visible but disables them when the service is unavailable', async () => {
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'unavailable' });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-unavailable"]').text()).toContain('failed');
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="llama-cpp-browser-profile"]').exists()).toBe(true);
    const file = new File(['fixture'], 'local.gguf');
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    expect(llamaCppBrowserService.listModelEntries).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
  });

  it('shows an explicit file picker, drop target and automatic profile without an idle status', async () => {
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-file"]').attributes('accept')).toBe('.gguf');
    expect(wrapper.get('[data-testid="llama-cpp-browser-file"]').attributes('multiple')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').text()).toContain('GGUF');
    expect(runtimeProfileControl({ view: wrapper }).props('modelValue')).toBe('auto');
    expect(wrapper.find('[data-testid="llama-cpp-browser-status"]').exists()).toBe(false);
    expect(wrapper.find('progress').exists()).toBe(false);
  });

  it('reads the persisted model list again on every mount', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const first = render();
    await flushPromises();
    expect(first.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
    first.unmount();
    wrappers.splice(wrappers.indexOf(first), 1);
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([{ ...storedModel, modelId: 'user/AfterReload-GGUF' }]);
    const second = render();
    await flushPromises();
    expect(second.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain('user/AfterReload-GGUF');
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
    expect(notifications.models.size).toBe(1);
  });

  it('imports file input selections and resets the native input', async () => {
    const wrapper = render();
    await flushPromises();
    const file = new File(['fixture'], 'input.GGUF');
    const input = wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    await input.trigger('change');
    await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls[0]?.[0].file).toBe(file);
    expect(input.element.value).toBe('');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
  });

  it('accepts a drop while returning window focus is still refreshing the model list', async () => {
    const wrapper = render();
    await flushPromises();
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-cpp-browser-list-loading"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(false);
    const transfer = { files: [new File(['fixture'], 'local.gguf')], types: ['Files'], dropEffect: 'none' };
    const zone = wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]');
    await zone.trigger('dragenter', { dataTransfer: transfer });
    await zone.trigger('dragover', { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe('copy');
    await zone.trigger('drop', { dataTransfer: transfer });
    await flushPromises();
    // Do not wait for listing before accepting or reading the user's drop.
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledOnce();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls[0]?.[0].file).toBe(transfer.files[0]);
    listing.resolve([]);
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('accepts a drop before the initial local listing has finished', async () => {
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [new File(['fixture'], 'local.gguf')], types: ['Files'] },
    });
    await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledOnce();
    listing.resolve([]);
    await flushPromises();
    expect(wrapper.emitted('modelsChanged')).toEqual([[ [storedModel] ]]);
  });

  it.each(['file', 'directory'] as const)('keeps a %s picker result when focus refresh overlaps change', async source => {
    const wrapper = render();
    await flushPromises();
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    const file = new File(['fixture'], 'weights.gguf');
    if (source === 'directory') {
      Object.defineProperty(file, 'webkitRelativePath', { value: 'original-GGUF/nested/weights.gguf' });
    }
    const input = wrapper.get<HTMLInputElement>(`[data-testid="llama-cpp-browser-${source}"]`);
    Object.defineProperty(input.element, 'files', { value: [file] });
    expect(input.element.matches(':disabled')).toBe(false);
    await input.trigger('change');
    await flushPromises();
    if (source === 'directory') {
      expect(llamaCppBrowserService.importDirectory).toHaveBeenCalledWith({ directory: { rootName: 'original-GGUF', files: [{ relativePath: 'nested/weights.gguf', file }] }, signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
      expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    } else {
      expect(llamaCppBrowserService.importModel).toHaveBeenCalledWith({ file, signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
      expect(llamaCppBrowserService.importDirectory).not.toHaveBeenCalled();
    }
    expect(input.element.value).toBe('');
    listing.resolve([]);
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('captures drag entries during dispatch and retains them across a later focus refresh', async () => {
    const wrapper = render();
    await flushPromises();
    const file = new File(['fixture'], 'local.gguf');
    const drop = deferredFileDrop({ file });
    const event = dispatchDrop({ wrapper, transfer: drop.transfer });
    // A real DataTransfer stops exposing entries/files when dispatch ends.
    drop.protect();
    expect(event.defaultPrevented).toBe(true);
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    drop.read.resolve(file);
    await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledWith({ file, signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
    listing.resolve([]);
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
  });

  it('retains a dropped directory and its relative paths across focus refresh during traversal', async () => {
    const wrapper = render();
    await flushPromises();
    const file = new File(['fixture'], 'weights.gguf');
    const read = Promise.withResolvers<File>();
    const child = {
      isFile: true,
      isDirectory: false,
      name: file.name,
      file: (resolve: FileCallback, reject: ErrorCallback) => {
        void read.promise.then(resolve, reject);
      },
    };
    function directoryEntry({ name, entries }: { name: string, entries: unknown[] }) {
      return {
        isDirectory: true,
        isFile: false,
        name,
        createReader: () => {
          let delivered = false;
          return {
            readEntries: (resolve: (entries: unknown[]) => void) => {
              const batch = delivered ? [] : entries;
              delivered = true;
              queueMicrotask(() => resolve(batch));
            },
          };
        },
      };
    }
    const folder = directoryEntry({ name: 'original-GGUF', entries: [directoryEntry({ name: 'nested', entries: [child] })] });
    const items = [{ kind: 'file', webkitGetAsEntry: () => folder }];
    dispatchDrop({ wrapper, transfer: { items, files: [], types: ['Files'] } as unknown as DataTransfer });
    items.splice(0);
    await flushPromises();
    const listing = Promise.withResolvers<LocalModel[]>();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockReturnValueOnce(listing.promise).mockResolvedValue([storedModel]);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    read.resolve(file);
    await flushPromises();
    expect(llamaCppBrowserService.importDirectory).toHaveBeenCalledWith({ directory: { rootName: 'original-GGUF', files: [{ relativePath: 'nested/weights.gguf', file }] }, signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    listing.resolve([]);
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('reserves the import before asynchronous drop enumeration and rejects a second drop', async () => {
    const wrapper = render();
    await flushPromises();
    const file = new File(['first'], 'first.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer });
    drop.protect();
    await flushPromises();
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
    drop.read.resolve(file);
    await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual([file]);
    // The lane is released once this import (and its list refresh) has completed.
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [second], types: ['Files'] },
    });
    await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual([file, second]);
  });

  it.each(['cancel', 'unmount'] as const)('does not import a late entry after %s during drop enumeration', async action => {
    const wrapper = render();
    await flushPromises();
    const file = new File(['fixture'], 'late.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer });
    drop.protect();
    await flushPromises();
    if (action === 'cancel') {
      await wrapper.get('[data-testid="llama-cpp-browser-cancel"]').trigger('click');
    } else {
      wrapper.unmount();
      wrappers.splice(wrappers.indexOf(wrapper), 1);
    }
    drop.read.resolve(file);
    await flushPromises();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importDirectory).not.toHaveBeenCalled();
    if (action === 'cancel') {
      expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(false);
    } else {
      expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    }
  });

  it('reports entry read failures without raw paths and releases the import controls for retry', async () => {
    const wrapper = render();
    await flushPromises();
    const file = new File(['fixture'], 'local.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer });
    drop.protect();
    await flushPromises();
    drop.read.reject(new DOMException('/private/path/local.gguf', 'NotReadableError'));
    await flushPromises();
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
    const wrapper = render();
    await flushPromises();
    const file = new File(['fixture'], 'local.gguf');
    const drop = deferredFileDrop({ file });
    dispatchDrop({ wrapper, transfer: drop.transfer });
    drop.protect();
    drop.read.resolve(file);
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importDirectory).not.toHaveBeenCalled();
  });

  it('imports dropped files sequentially and refreshes the list', async () => {
    const wrapper = render();
    await flushPromises();
    const files = [new File(['a'], 'first.gguf'), new File(['b'], 'second.gguf')];
    let finishFirst: (() => void) | undefined;
    vi.mocked(llamaCppBrowserService.importModel).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finishFirst = resolve;
      });
      return storedReceipt;
    });
    const zone = wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]');
    await zone.trigger('drop', { dataTransfer: { files, types: ['Files'] } });
    await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    await zone.trigger('drop', { dataTransfer: { files, types: ['Files'] } });
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    finishFirst?.();
    await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual(files);
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
  });

  it('stops a multi-file import after cancellation without starting the next file', async () => {
    const wrapper = render();
    await flushPromises();
    let importSignal: AbortSignal | undefined;
    vi.mocked(llamaCppBrowserService.importModel).mockImplementationOnce(({ signal }) => new Promise<ModelImportReceipt>((_resolve, reject) => {
      importSignal = signal;
      signal?.addEventListener('abort', () => reject(new LlamaCppBrowserError({ code: 'aborted' })), { once: true });
    }));
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [new File(['a'], 'first.gguf'), new File(['b'], 'second.gguf')], types: ['Files'] },
    });
    await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-cancel"]').trigger('click');
    await flushPromises();
    expect(importSignal?.aborted).toBe(true);
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-cpp-browser-cancel"]').exists()).toBe(false);
  });

  it('rejects a mixed non-GGUF drop without importing or logging file contents', async () => {
    const wrapper = render();
    await flushPromises();
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
    const wrapper = render();
    await flushPromises();
    vi.mocked(llamaCppBrowserService.importModel).mockResolvedValueOnce(storedReceipt).mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'storage-error' }));
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', {
      dataTransfer: { files: [new File(['a'], 'first.gguf'), new File(['b'], 'second.gguf')], types: ['Files'] },
    });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).not.toBe('');
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
  });

  it('refreshes OPFS listing when the model service reports a change', async () => {
    const wrapper = render();
    await flushPromises();
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    for (const listener of notifications.models) {
      listener();
    }
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(notifications.models.size).toBe(0);
  });

  it('aborts its in-flight refresh when the manager is unmounted', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockImplementation(async ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const wrapper = render();
    await flushPromises();
    const signal = vi.mocked(llamaCppBrowserService.listModelEntries).mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(signal?.aborted).toBe(true);
  });

  it('repeats an in-flight OPFS refresh when the model list changes before it completes', async () => {
    let finishRead: ((models: LocalModel[]) => void) | undefined;
    vi.mocked(llamaCppBrowserService.listModelEntries).mockImplementationOnce(() => new Promise(resolve => {
      finishRead = resolve;
    })).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-cpp-browser-list-loading"]').exists()).toBe(true);
    for (const listener of notifications.models) {
      listener();
    }
    finishRead?.([]);
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
  });

  it('does not lose a list change queued as the previous refresh settles', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockImplementationOnce(() => Promise.resolve([]).then(found => {
      queueMicrotask(() => queueMicrotask(() => {
        for (const listener of notifications.models) {
          listener();
        }
      }));
      return found;
    })).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
  });

  it('clears an old listing error after a successful manual refresh', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'storage-error' })).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('storage-error');
    await wrapper.get('[data-testid="llama-cpp-browser-refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-cpp-browser-model-list"]').text()).toContain(storedModel.modelId);
  });

  it('allows deletion while inference is active and previews the confirmed files and explains stale plans without raw errors', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    vi.mocked(llamaCppBrowserService.removeModel).mockResolvedValueOnce('changed');
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'working', progress: { phase: 'generating', completed: 1, total: 0 } });
    const wrapper = render();
    await flushPromises();
    await wrapper.get(`[data-testid="llama-imported-model-details-toggle-${storedModel.modelId}"]`).trigger('click');
    await wrapper.get(`[data-testid="llama-cpp-browser-delete-${storedModel.modelId}"]`).trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-delete-details"]').text()).toContain('local.gguf');
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click');
    await flushPromises();
    expect(llamaCppBrowserService.removeModel).toHaveBeenCalledWith({ plan: modelRemovalPlan({ modelId: storedModel.modelId, files: [{ relativePath: 'local.gguf', size: 16384, lastModified: 1 }] }), signal: expect.any(AbortSignal) });
    expect(wrapper.get('[data-testid="llama-removal-changed"]').text()).toContain('Deletion stopped because the files changed');
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledTimes(2);
  });

  it('does not delete after confirmation if the manager has been unmounted', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    await wrapper.get(`[data-testid="llama-imported-model-details-toggle-${storedModel.modelId}"]`).trigger('click');
    await wrapper.get(`[data-testid="llama-cpp-browser-delete-${storedModel.modelId}"]`).trigger('click');
    await flushPromises();
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    await flushPromises();
    expect(llamaCppBrowserService.removeModel).not.toHaveBeenCalled();
  });

  it('allows an explicit profile override without changing the default on its own', async () => {
    const wrapper = render();
    await flushPromises();
    await runtimeProfileControl({ view: wrapper }).setValue('cpu-wasm32');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'cpu-wasm32' } });
    await runtimeProfileControl({ view: wrapper }).setValue('webgpu-wasm32-jspi');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'webgpu-wasm32-jspi' } });
    await runtimeProfileControl({ view: wrapper }).setValue('webgpu-wasm32-asyncify');
    expect(llamaCppBrowserService.setOptions).toHaveBeenLastCalledWith({ options: { profile: 'webgpu-wasm32-asyncify' } });
    expect(wrapper.find('[data-testid="llama-cpp-browser-context"]').exists()).toBe(false);
  });
});

describe('cancelled dropped-file retry', () => {
  it('keeps input disabled through rollback and accepts the same drop after cancellation settles', async () => {
    const wrapper = render();
    await flushPromises();
    const rollback = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    vi.mocked(llamaCppBrowserService.importModel).mockImplementationOnce(async input => {
      signal = input.signal;
      await rollback.promise;
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    const file = new File(['fixture'], 'same.gguf');
    const transfer = { files: [file], types: ['Files'] } as unknown as DataTransfer;
    dispatchDrop({ wrapper, transfer });
    await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-cancel"]').trigger('click');
    expect(signal?.aborted).toBe(true);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    dispatchDrop({ wrapper, transfer });
    await flushPromises();
    expect(llamaCppBrowserService.importModel).toHaveBeenCalledOnce();
    rollback.resolve();
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(false);
    dispatchDrop({ wrapper, transfer });
    await flushPromises();
    expect(vi.mocked(llamaCppBrowserService.importModel).mock.calls.map(([input]) => input.file)).toEqual([file, file]);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});

it('lets the independent audio workspace suppress chat suggestions without changing the default elsewhere', async () => {
  const audio = mount(LlamaCppBrowserManager, { props: { suggestions: 'none' } });
  wrappers.push(audio);
  const chat = render();
  await flushPromises();
  expect(audio.find('[data-testid="llama-model-suggestions"]').exists()).toBe(false);
  expect(chat.find('[data-testid="llama-model-suggestions"]').exists()).toBe(true);
  expect(llamaCppBrowserService.setOptions).not.toHaveBeenCalled();
});

describe('local-model chat group action', () => {
  const catalogRepository = preferredQuantizationHint({ suggestion: modelSuggestions.find(suggestion => suggestion.id === 'smollm2-135m')! }).hfRepository;
  const catalogModel: LocalModel = { modelId: `hf.co/${catalogRepository}:Q4_K_M`, size: 128, importedAt: 1 };

  beforeEach(() => {
    vi.mocked(repositoryDirectories).mockResolvedValue([localModelDirectory({ primaryRelativePath: 'SmolLM2-135M-Instruct-Q4_K_M.gguf', projectorRelativePath: undefined })]);
  });

  function renderWithAction({ createChatGroup }: { createChatGroup: ({ model, signal }: { model: LocalModel, signal: AbortSignal }) => Promise<void> }): VueWrapper {
    const wrapper = mount(LlamaCppBrowserManager, {
      props: {
        createChatGroup,
        defaultModel: { endpoint: { type: 'openai', url: 'http://localhost:1234/v1' }, modelId: 'global-model' },
        applyDefaultModel: vi.fn().mockResolvedValue('applied'),
      },
    });
    wrappers.push(wrapper);
    return wrapper;
  }

  it('keeps the original default-only controls for callers without the Settings action', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-model-split-action"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-cpp-browser-model-list"] [data-testid="llama-default-model-action"]').exists()).toBe(true);
  });

  it('routes catalog and imported actions through the same guarded creation request', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([catalogModel, storedModel]);
    const request = Promise.withResolvers<void>();
    const createChatGroup = vi.fn().mockReturnValue(request.promise);
    const wrapper = renderWithAction({ createChatGroup });
    await flushPromises();
    const row = wrapper.get('[data-testid="llama-suggestion-smollm2-135m"]');
    const main = row.get('[data-testid="llama-model-action-main"]');
    main.element.dispatchEvent(new MouseEvent('click'));
    main.element.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    expect(createChatGroup).toHaveBeenCalledExactlyOnceWith({ model: catalogModel, signal: expect.any(AbortSignal) });
    expect(main.attributes('aria-busy')).toBe('true');
    expect(row.get('[data-testid="llama-suggestion-quantization"]').element.matches(':disabled')).toBe(true);
    const imported = wrapper.get('[data-testid="llama-cpp-browser-model-list"]');
    const importedActions = imported.findAll('[data-testid="llama-model-action-main"]');
    expect(importedActions.map(action => action.attributes('aria-busy'))).toEqual(['true', 'false']);
    expect(importedActions.every(action => action.element.matches(':disabled'))).toBe(true);
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    request.reject(new Error('creation failed'));
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-create-chat-group-error"]').text()).toContain('Could not create or open the chat group');
    expect(main.element.matches(':disabled')).toBe(false);
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.setOptions).not.toHaveBeenCalled();
  });

  it('retains the existing confirmation dialog when the catalog split action is set to default', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([catalogModel]);
    const createChatGroup = vi.fn().mockResolvedValue(undefined);
    const applyDefaultModel = vi.fn().mockResolvedValue('applied');
    const wrapper = renderWithAction({ createChatGroup });
    await wrapper.setProps({ applyDefaultModel });
    await flushPromises();
    const row = wrapper.get('[data-testid="llama-suggestion-smollm2-135m"]');
    await row.get('[data-testid="llama-model-action-options"]').trigger('click');
    const option = document.querySelector<HTMLButtonElement>('[data-testid="llama-model-action-set-default"]');
    if (!option) {
      throw new Error('Default-model option was not shown');
    }
    await new DOMWrapper(option).trigger('click');
    expect(document.querySelector('[data-testid="llama-default-model-dialog"]')).toBeNull();
    expect(applyDefaultModel).not.toHaveBeenCalled();
    await row.get('[data-testid="llama-model-action-main"]').trigger('click');
    await flushPromises();
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="llama-default-confirm"]');
    if (!confirm) {
      throw new Error('Default-model confirmation was not shown');
    }
    expect(applyDefaultModel).not.toHaveBeenCalled();
    await new DOMWrapper(confirm).trigger('click');
    await flushPromises();
    expect(applyDefaultModel).toHaveBeenCalledExactlyOnceWith({ model: catalogModel, previous: { endpoint: { type: 'openai', url: 'http://localhost:1234/v1' }, modelId: 'global-model' } });
    expect(createChatGroup).not.toHaveBeenCalled();
  });

  it('keeps deletion in collapsible details and opens them without extra fetching or selecting a model', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const wrapper = render();
    await flushPromises();
    const details = wrapper.get(`[data-testid="llama-imported-model-details-${storedModel.modelId}"]`);
    const summary = wrapper.get(`[data-testid="llama-imported-model-details-toggle-${storedModel.modelId}"]`);
    expect(details.attributes('aria-hidden')).toBe('true');
    expect(details.attributes('inert')).toBeDefined();
    expect(summary.attributes('aria-expanded')).toBe('false');
    expect(summary.attributes('aria-controls')).toBe(details.attributes('id'));
    expect(summary.text()).toContain('GGUF');
    expect(summary.text()).toContain('Details');
    expect(details.get('[data-testid="llama-imported-model-detail-name"]').text()).toBe(storedModel.modelId);
    expect(details.find('[data-testid="llama-imported-model-detail-folder"]').exists()).toBe(false);
    expect(details.find(`[data-testid="llama-cpp-browser-delete-${storedModel.modelId}"]`).exists()).toBe(true);
    await summary.trigger('click');
    expect(details.attributes('aria-hidden')).toBe('false');
    expect(details.attributes('inert')).toBeUndefined();
    expect(summary.attributes('aria-expanded')).toBe('true');
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(prepareModelRemoval).not.toHaveBeenCalled();
    expect(wrapper.emitted('modelSelected')).toBeUndefined();
    await summary.trigger('click');
    expect(details.attributes('aria-hidden')).toBe('true');
    expect(details.attributes('inert')).toBeDefined();
    expect(summary.attributes('aria-expanded')).toBe('false');
  });

  it('shows linked model information from the existing inventory when details are expanded', async () => {
    const linked: LocalModel = {
      modelId: 'host/MyModels1/alice/Model-GGUF:Q4_K_M',
      size: 128,
      importedAt: 1,
      source: { kind: 'host', directoryId: 'root-a', directoryName: 'MyModels1', repository: 'alice/Model-GGUF', primaryRelativePath: 'Q4_K_M/model.gguf' },
    };
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([linked]);
    const wrapper = render();
    await flushPromises();
    await wrapper.get(`[data-testid="llama-imported-model-details-toggle-${linked.modelId}"]`).trigger('click');
    const details = wrapper.get(`[data-testid="llama-imported-model-details-${linked.modelId}"]`);
    expect(details.attributes('aria-hidden')).toBe('false');
    expect(details.get('[data-testid="llama-imported-model-detail-name"]').text()).toBe(linked.modelId);
    expect(details.text()).toContain('Model ID');
    expect(details.text()).not.toContain('Model name');
    expect(details.get('[data-testid="llama-imported-model-detail-folder"]').text()).toBe('MyModels1');
    expect(details.get('[data-testid="llama-imported-model-detail-repository"]').text()).toBe('alice/Model-GGUF');
    expect(details.get('[data-testid="llama-imported-model-detail-file"]').text()).toBe('Q4_K_M/model.gguf');
    expect(details.text()).not.toContain('root-a');
    expect(llamaCppBrowserService.listModelEntries).toHaveBeenCalledOnce();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
  });

  it('passes the row model and cancellation signal, blocks repeated clicks and disables mutations while creating', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel, { ...storedModel, modelId: 'user/OtherModel' }]);
    const request = Promise.withResolvers<void>();
    const createChatGroup = vi.fn().mockReturnValue(request.promise);
    const wrapper = renderWithAction({ createChatGroup });
    await flushPromises();
    const buttons = wrapper.findAll('[data-testid="llama-model-action-main"]');
    buttons[0]!.element.dispatchEvent(new MouseEvent('click'));
    buttons[0]!.element.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    expect(createChatGroup).toHaveBeenCalledOnce();
    expect(createChatGroup).toHaveBeenCalledWith({ model: storedModel, signal: expect.any(AbortSignal) });
    expect(buttons.every(button => button.element.matches(':disabled'))).toBe(true);
    expect(buttons[0]!.attributes('aria-busy')).toBe('true');
    expect(wrapper.findAll('[data-testid="llama-model-action-options"]').every(button => button.element.matches(':disabled'))).toBe(true);
    expect(wrapper.get(`[data-testid="llama-cpp-browser-delete-${storedModel.modelId}"]`).element.matches(':disabled')).toBe(true);
    expect(wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    request.resolve();
    await flushPromises();
    expect(buttons.every(button => !button.element.matches(':disabled'))).toBe(true);
    expect(wrapper.find('[data-testid="llama-cpp-browser-create-chat-group-error"]').exists()).toBe(false);
    expect(llamaCppBrowserService.setOptions).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
  });

  it('shows a localized failure and allows another attempt without exposing raw errors', async () => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const createChatGroup = vi.fn().mockRejectedValueOnce(new Error('private-path')).mockResolvedValue(undefined);
    const wrapper = renderWithAction({ createChatGroup });
    await flushPromises();
    await wrapper.get('[data-testid="llama-model-action-main"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-create-chat-group-error"]').text()).toContain('Could not create or open the chat group');
    expect(wrapper.text()).not.toContain('private-path');
    await wrapper.get('[data-testid="llama-model-action-main"]').trigger('click');
    await flushPromises();
    expect(createChatGroup).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="llama-cpp-browser-create-chat-group-error"]').exists()).toBe(false);
  });

  it.each(['suspend', 'unmount'])('aborts the request and suppresses its late failure when invalidated (%s)', async reason => {
    vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([storedModel]);
    const request = Promise.withResolvers<void>();
    const createChatGroup = vi.fn().mockReturnValue(request.promise);
    const wrapper = renderWithAction({ createChatGroup });
    await flushPromises();
    await wrapper.get('[data-testid="llama-model-action-main"]').trigger('click');
    const signal = createChatGroup.mock.calls[0]![0].signal as AbortSignal;
    if (reason === 'suspend') {
      await wrapper.setProps({ suspended: true });
    } else {
      wrapper.unmount();
      wrappers.splice(wrappers.indexOf(wrapper), 1);
    }
    expect(signal.aborted).toBe(true);
    request.reject(new Error('late failure'));
    await flushPromises();
    if (reason === 'suspend') {
      expect(wrapper.find('[data-testid="llama-cpp-browser-create-chat-group-error"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="llama-model-action-main"]').element.matches(':disabled')).toBe(true);
    }
  });
});

it('removes temporary model entries without a file deletion plan or confirmation', async () => {
  const model = { modelId: 'temp/local-GGUF', size: 32, importedAt: 123 };
  vi.mocked(llamaCppBrowserService.listModelEntries).mockResolvedValue([model]);
  const wrapper = render();
  await flushPromises();
  expect(wrapper.get('[data-testid="llama-temporary-model-badge"]').text()).toBe('Temporary');
  await wrapper.get('[data-testid="llama-cpp-browser-delete-temp/local-GGUF"]').trigger('click');
  await flushPromises();
  expect(llamaCppBrowserService.removeTemporaryModel).toHaveBeenCalledWith({ modelId: model.modelId, signal: expect.any(AbortSignal) });
  expect(prepareModelRemoval).not.toHaveBeenCalled();
  expect(llamaCppBrowserService.removeModel).not.toHaveBeenCalled();
});
