import { downloadDestinationControl, modelConfigurationControl } from './model-configuration.test-support';
import { beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { computed, ref, shallowRef, type Ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import type { useSettings } from '@/composables/useSettings';
import type { HostModelDirectoryChoice } from '@/composables/useHostModelDirectories';
import { audioModelCatalog } from '@/features/audio-generation/model-catalog';
import ModelSelectorVariantDownload from '@/components/ModelSelectorVariantDownload.vue';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { TEST_ONLY as destinationTest } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { type DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { confirmModelLaunchConfiguration } from '@/features/llama-cpp-browser/model-launch/target';
import { bundledRepositoryDownloadKey } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import { repositoryDefaultDownloadKey } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { searchGgufModels, searchModels, type RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import LlamaCppBrowserRepositoryPicker from './LlamaCppBrowserRepositoryPicker.vue';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), installed: vi.fn(), inventory: vi.fn(), modelEntry: vi.fn(), modelFiles: vi.fn(), permission: vi.fn(), add: vi.fn(), reconnect: vi.fn(), enqueue: vi.fn(), stopDownload: vi.fn() }));
let settings: Ref<Settings>;
let entries: Ref<HostModelDirectoryChoice[]>;
let supported: Ref<boolean>;
let folderBusy: Ref<boolean>;
const downloadJobs = shallowRef<DownloadJob[]>([]);
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings,
    captureExperimentalStorage: () => () => true,
    updateExperimentalForStorage: async ({ isCurrent, updater }: Parameters<ReturnType<typeof useSettings>['updateExperimentalForStorage']>[0]) => {
      if (!isCurrent()) {
        return 'changed';
      }
      settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
      return 'saved';
    },
  }),
}));
vi.mock('@/composables/useHostModelDirectories', () => ({
  useHostModelDirectories: () => ({
    registrations: () => entries.value,
    refresh: async () => {},
    currentHandle: () => ({ name: 'Models' }),
    hostDownloadDestination: mocks.permission,
    view: {
      supported: computed(() => supported.value),
      entries: computed(() => entries.value),
      busy: folderBusy,
      destination: ref('opfs'),
      add: mocks.add,
      reconnect: mocks.reconnect,
      remove: vi.fn(),
      selectDestination: vi.fn(),
    },
  }),
}));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: mocks.inventory }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { getModelEntry: mocks.modelEntry, inspectModelFiles: mocks.modelFiles } }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: mocks.inspect }) }));
vi.mock('../hugging-face/storage', () => ({ installedSelection: mocks.installed }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', async original => ({
  ...await original<typeof import('@/features/llama-cpp-browser/hugging-face/download-queue')>(),
  getDownloadQueue: () => ({ jobs: downloadJobs, changed: computed(() => downloadJobs.value.filter(job => job.status === 'complete').length), enqueue: mocks.enqueue, cancel: mocks.stopDownload }),
}));
vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async original => ({ ...await original<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), searchModels: vi.fn(), searchGgufModels: vi.fn() }));
vi.mock('@/components/csp/CspMessageHint.vue', () => ({ default: { props: ['target', 'presentation'], template: '<aside data-testid="repository-csp-message" :data-presentation="presentation" />' } }));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: ['Q4_K_M', 'Q8_0'].map(label => ({ label, files: [{ path: `Model-${label}.gguf`, size: 256 }], size: 256 })) };

beforeEach(async () => {
  vi.resetAllMocks();
  destinationTest.reset();
  downloadJobs.value = [];
  settings = ref({ ...structuredClone(DEFAULT_SETTINGS), storageType: 'memory', endpoint: { type: 'openai', url: '' } });
  entries = ref([{ id: 'root-a', name: 'Models A', access: 'readwrite', error: undefined }, { id: 'root-b', name: 'Models B', access: 'readwrite', error: undefined }]);
  supported = ref(true);
  folderBusy = ref(false);
  mocks.permission.mockImplementation(async ({ id }: { id: string }) => ({ kind: 'host', directoryId: id }));
  vi.mocked(searchModels).mockResolvedValue({ results: [], nextCursor: undefined });
  vi.mocked(searchGgufModels).mockResolvedValue({ results: [], nextCursor: undefined });
  mocks.inspect.mockResolvedValue(catalog);
  mocks.installed.mockResolvedValue(undefined);
  mocks.inventory.mockResolvedValue([]);
  await ensureAllStringsForTest({ locale: 'en' });
});

it('does not contact HF while mounted or typing, then exposes actual quantizations after explicit confirmation', async () => {
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(mocks.inspect).toHaveBeenCalledOnce();
  const quantization = modelConfigurationControl({ view: wrapper, field: 'quantization' });
  expect(quantization.props('modelValue')).toBe('Model-Q4_K_M.gguf');
  expect(quantization.props('options')).toHaveLength(2);
  await quantization.setValue('Model-Q8_0.gguf');
  await flushPromises();
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ target: { mainFilePath: 'Model-Q8_0.gguf', selection: { repository: catalog.repository, revision: catalog.revision } }, destination: { kind: 'opfs' }, authorizeDestination: expect.any(Function) });
});

it('shows saved state for the exact local selection without enqueueing a download', async () => {
  mocks.installed.mockResolvedValue({ modelId: 'hf.co/owner/Model-GGUF:Q4_K_M', size: 256, importedAt: 1 });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Saved');
  expect(wrapper.emitted('select')).toBeUndefined();
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select-model')?.[0]?.[0]).toMatchObject({ modelId: 'hf.co/owner/Model-GGUF:Q4_K_M' });
  expect(mocks.permission).not.toHaveBeenCalled();
});

it('supplements a metadata failure without treating invalid input as a connection failure', async () => {
  mocks.inspect.mockRejectedValue(new Error('Network unavailable'));
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="repository-csp-message"][data-presentation="error"]').attributes('data-presentation')).toBe('error');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-hf-search-submit"]').element.disabled).toBe(false);
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('https://huggingface.co/not-a-repository');
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(mocks.inspect).toHaveBeenCalledOnce();
  expect(wrapper.find('[data-testid="repository-csp-message"][data-presentation="error"]').exists()).toBe(false);
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
});

it('abandons late metadata when the source tab is left', async () => {
  const pending = Promise.withResolvers<RepositoryCatalog>();
  mocks.inspect.mockReturnValue(pending.promise);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  const signal: AbortSignal = mocks.inspect.mock.calls[0]![0].signal;
  await wrapper.setProps({ disabled: true });
  expect(signal.aborted).toBe(true);
  pending.resolve(catalog);
  await flushPromises();
  expect(wrapper.find('[data-testid="llama-model-quantization"]').exists()).toBe(false);
  expect(wrapper.emitted('select')).toBeUndefined();
});

it('returns to the mounted search and repository input without another metadata request', async () => {
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const search = wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).element;
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="llama-hf-search-query"]').isVisible()).toBe(false);
  expect(wrapper.get('[data-testid="chat-model-repository-name"]').text()).toBe(catalog.repository);
  expect(wrapper.get('[data-testid="chat-model-back-to-search"]').find('svg').exists()).toBe(true);
  await wrapper.get('[data-testid="chat-model-back-to-search"]').trigger('click');
  expect(wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).element).toBe(search);
  expect(wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-query"]').element.value).toBe(`https://huggingface.co/${catalog.repository}`);
  expect(wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).props('disabled')).toBe(false);
  expect(mocks.inspect).toHaveBeenCalledOnce();
});

it('uses the shared multimodal choices and applies only the selected files', async () => {
  mocks.inspect.mockResolvedValue({ ...catalog, projectors: [{ path: 'mmproj-Q8_0.gguf', size: 128 }, { path: 'mmproj-F16.gguf', size: 512 }] });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="llama-model-multimodal"]').attributes('aria-checked')).toBe('true');
  expect(modelConfigurationControl({ view: wrapper, field: 'companion' }).props('modelValue')).toBe('mmproj-Q8_0.gguf');
  await modelConfigurationControl({ view: wrapper, field: 'companion' }).setValue('mmproj-F16.gguf');
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-model-download-size"]').text()).toContain('768');
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ target: { selection: { files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }, { path: 'mmproj-F16.gguf', size: 512 }] } } });
  await wrapper.get('[data-testid="llama-model-multimodal"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="llama-model-companion"]').exists()).toBe(false);
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select')?.[1]?.[0]).toMatchObject({ target: { selection: { files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] } } });
  expect(mocks.inspect).toHaveBeenCalledOnce();
});

it('requires a companion choice for different families unless multimodal support is turned off', async () => {
  mocks.inspect.mockResolvedValue({ ...catalog, projectors: [{ path: 'mmproj-vision-F16.gguf', size: 128 }, { path: 'mmproj-audio-F16.gguf', size: 512 }] });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(modelConfigurationControl({ view: wrapper, field: 'companion' }).props('modelValue')).toBe('');
  expect(wrapper.get('[data-testid="chat-use-repository-model"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="llama-model-multimodal"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-use-repository-model"]').attributes('disabled')).toBeUndefined();
});

async function inspectRepository({ wrapper }: { wrapper: VueWrapper }): Promise<void> {
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
}

it('uses the persisted destination and offers the shared full-width controls without resetting model choices', async () => {
  settings.value.experimental = { llamaCppBrowser: { modelDownloadDestination: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'root-a' }) } } };
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  expect(mocks.installed).not.toHaveBeenCalled();
  expect(wrapper.findComponent(LlamaCppBrowserDownloadDestination).exists()).toBe(false);
  await inspectRepository({ wrapper });
  const controls = wrapper.getComponent(LlamaCppBrowserDownloadDestination);
  expect(controls.props('layout')).toBe('field');
  expect(mocks.installed).toHaveBeenLastCalledWith(expect.objectContaining({ destination: { kind: 'host', directoryId: 'root-a' } }));
  await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('Model-Q8_0.gguf');
  await downloadDestinationControl({ view: wrapper }).setValue('host:root-b');
  await flushPromises();
  expect(settings.value.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'root-b' });
  expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('Model-Q8_0.gguf');
  expect(controls.props('layoutFile')).toEqual({ repository: catalog.repository, path: 'Model-Q8_0.gguf' });
  await wrapper.get('[data-testid="llama-manage-model-directories"]').trigger('click');
  const management = wrapper.get('[data-testid="llama-model-directory-registrations"]');
  expect(management.attributes('aria-hidden')).toBe('false');
  expect(management.classes()).toContain('col-span-full');
  expect(management.element.closest('[data-testid="chat-model-destination-row"]')).not.toBeNull();
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.permission).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ target: { mainFilePath: 'Model-Q8_0.gguf' }, destination: { kind: 'host', directoryId: 'root-b' }, authorizeDestination: expect.any(Function) });
  expect(mocks.inspect).toHaveBeenCalledOnce();
});

it('uses an installed read-only host model directly without asking for write access or using its OPFS copy', async () => {
  entries.value[0]!.access = 'read';
  const hostModel: LocalModel = { modelId: 'host/Models A/owner/Model-GGUF:Q4_K_M', size: 256, importedAt: 1 };
  mocks.installed.mockImplementation(async ({ destination }: { destination: { kind: string } }) => destination.kind === 'host' ? hostModel : { ...hostModel, modelId: 'hf.co/owner/Model-GGUF:Q4_K_M' });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await inspectRepository({ wrapper });
  await downloadDestinationControl({ view: wrapper }).setValue('host:root-a');
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-model-saved"]').text()).toBe('Saved');
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select-model')?.[0]?.[0]).toEqual(hostModel);
  expect(wrapper.emitted('select')).toBeUndefined();
  expect(mocks.permission).not.toHaveBeenCalled();
});

it('discards late checks from another destination and retains the form while checking the new one', async () => {
  const first = Promise.withResolvers<LocalModel | undefined>();
  const second = Promise.withResolvers<LocalModel | undefined>();
  mocks.installed.mockImplementation(({ destination }: { destination: { kind: string, directoryId?: string } }) => destination.kind === 'opfs' ? Promise.resolve(undefined) : destination.directoryId === 'root-a' ? first.promise : second.promise);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await inspectRepository({ wrapper });
  const configuration = wrapper.get('[data-testid="chat-model-configuration"]').element;
  const selector = downloadDestinationControl({ view: wrapper }).get('button').element;
  await downloadDestinationControl({ view: wrapper }).setValue('host:root-a');
  await flushPromises();
  await downloadDestinationControl({ view: wrapper }).setValue('host:root-b');
  await flushPromises();
  const use = wrapper.get<HTMLButtonElement>('[data-testid="chat-use-repository-model"]');
  expect(use.element.disabled).toBe(true);
  expect(use.attributes('aria-busy')).toBe('true');
  expect(use.classes()).toContain('disabled:aria-busy:opacity-100');
  expect(wrapper.find('[data-testid="chat-model-destination-unavailable"]').exists()).toBe(false);
  first.resolve({ modelId: 'host/Models A/owner/Model-GGUF:Q4_K_M', size: 256, importedAt: 1 });
  await flushPromises();
  expect(wrapper.find('[data-testid="chat-model-saved"]').exists()).toBe(false);
  expect(use.element.disabled).toBe(true);
  second.resolve(undefined);
  await flushPromises();
  expect(use.element.disabled).toBe(false);
  expect(use.attributes('aria-busy')).toBeUndefined();
  expect(wrapper.get('[data-testid="chat-model-configuration"]').element).toBe(configuration);
  expect(downloadDestinationControl({ view: wrapper }).get('button').element).toBe(selector);
  await use.trigger('click');
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ destination: { kind: 'host', directoryId: 'root-b' } });
});

it('stops file checks while hidden and refreshes only the selected destination on return', async () => {
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await inspectRepository({ wrapper });
  await wrapper.setProps({ disabled: true });
  mocks.installed.mockClear();
  settings.value.experimental = { llamaCppBrowser: { modelDownloadDestination: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'root-b' }) } } };
  await flushPromises();
  expect(mocks.installed).not.toHaveBeenCalled();
  await wrapper.setProps({ disabled: false });
  await flushPromises();
  expect(mocks.installed).toHaveBeenLastCalledWith(expect.objectContaining({ destination: { kind: 'host', directoryId: 'root-b' } }));
  expect(mocks.inspect).toHaveBeenCalledOnce();
  expect(mocks.permission).not.toHaveBeenCalled();
});

it('keeps inaccessible host storage explicit and lets the user switch to browser storage', async () => {
  settings.value.experimental = { llamaCppBrowser: { modelDownloadDestination: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'root-a' }) } } };
  supported.value = false;
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await inspectRepository({ wrapper });
  expect(downloadDestinationControl({ view: wrapper }).props('modelValue')).toBe('host:root-a');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="chat-use-repository-model"]').element.disabled).toBe(true);
  expect(wrapper.get('[data-testid="chat-model-destination-unavailable"]').text()).toContain('reconnect');
  expect(mocks.installed).not.toHaveBeenCalled();
  await downloadDestinationControl({ view: wrapper }).setValue('opfs');
  await flushPromises();
  expect(mocks.installed).toHaveBeenLastCalledWith(expect.objectContaining({ destination: { kind: 'opfs' } }));
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ destination: { kind: 'opfs' } });
});

it('offers reconnection instead of a download when a folder cannot be read', async () => {
  mocks.installed.mockRejectedValue(new Error('Read permission required'));
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await inspectRepository({ wrapper });
  await downloadDestinationControl({ view: wrapper }).setValue('host:root-a');
  await flushPromises();
  expect(wrapper.get<HTMLButtonElement>('[data-testid="chat-use-repository-model"]').element.disabled).toBe(true);
  await wrapper.get('[data-testid="llama-manage-model-directories"]').trigger('click');
  await wrapper.get('[data-testid="linked-reconnect-model-directory-root-a"]').trigger('click');
  expect(mocks.reconnect).toHaveBeenCalledWith({ id: 'root-a' });
  expect(wrapper.emitted('select')).toBeUndefined();
});

it('searches a partial repository name rather than inspecting it and keeps the same query on return', async () => {
  vi.mocked(searchModels).mockResolvedValue({ results: [{ id: catalog.repository }], nextCursor: undefined });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  expect(wrapper.findAll('input')).toHaveLength(1);
  const query = wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-query"]');
  await query.setValue('owner/Model');
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(searchModels).toHaveBeenCalledExactlyOnceWith({ query: 'owner/Model', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="llama-hf-search-result"]').trigger('click');
  await flushPromises();
  expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith({ input: catalog.repository, signal: expect.any(AbortSignal), freshness: 'reuse' });
  await wrapper.get('[data-testid="chat-model-back-to-search"]').trigger('click');
  expect(query.element.value).toBe('owner/Model');
  expect(wrapper.find('[data-testid="llama-hf-search-result"]').exists()).toBe(true);
  expect(searchModels).toHaveBeenCalledOnce();
});

it('blocks duplicate URL confirmations and ignores late metadata after unmounting', async () => {
  const pending = Promise.withResolvers<RepositoryCatalog>();
  mocks.inspect.mockReturnValue(pending.promise);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('https://hf.co/owner/Model-GGUF');
  await wrapper.get('[data-testid="llama-hf-search-query"]').trigger('keydown', { key: 'Enter' });
  await wrapper.get('[data-testid="llama-hf-search-query"]').trigger('keydown', { key: 'Enter' });
  expect(mocks.inspect).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-testid="llama-hf-search"]').attributes('aria-busy')).toBe('true');
  const signal: AbortSignal = mocks.inspect.mock.calls[0]![0].signal;
  wrapper.unmount();
  expect(signal.aborted).toBe(true);
  pending.resolve(catalog);
  await flushPromises();
  expect(wrapper.emitted('select')).toBeUndefined();
  expect(searchModels).not.toHaveBeenCalled();
});

it('shows bundled companion files for the selected source and explicitly refreshes to current files', async () => {
  const repository = 'google/gemma-4-E2B-it-qat-q4_0-gguf';
  mocks.inspect.mockResolvedValue({ ...catalog, repository, projectors: [{ path: 'another-mmproj-F16.gguf', size: 128 }] });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'candidate-results' } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const gemma = wrapper.get('[data-testid="chat-model-suggestion"][data-repository="gemma-4-e2b"]');
  await gemma.trigger('click');
  expect(gemma.attributes('aria-expanded')).toBe('true');
  expect(wrapper.text()).toContain('Default configuration');
  expect(wrapper.text()).toContain('Q4_0 (QAT)');
  expect(wrapper.text()).toContain('Multimodal included');
  expect(wrapper.find('[data-testid="chat-repository-multimodal"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="model-selector-repository-source"]').exists()).toBe(false);
  const destination = downloadDestinationControl({ view: wrapper });
  expect(destination.props('modelValue')).toBe('opfs');
  await destination.setValue('host:root-b');
  expect(destination.props('modelValue')).toBe('host:root-b');
  expect(mocks.permission).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="model-selector-edit-configuration"]').trigger('click');
  expect(wrapper.get('[data-testid="model-selector-repository-source"]').attributes('open')).toBeUndefined();
  expect(wrapper.get('[data-testid="chat-repository-companion-file"]').text()).toContain('gemma-4-E2B-it-mmproj.gguf');
  expect(downloadDestinationControl({ view: wrapper }).element).toBe(destination.element);
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="chat-inspect-suggested-configuration"]').trigger('click');
  await flushPromises();
  expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith({ input: repository, signal: expect.any(AbortSignal), freshness: 'refresh' });
  expect(wrapper.get('[data-testid="chat-repository-companion-file"]').text()).toContain('another-mmproj-F16.gguf');
  expect(wrapper.get('[data-testid="chat-repository-companion-file"]').attributes('aria-pressed')).toBe('false');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="model-selector-choose-configuration"]').element.disabled).toBe(true);
  await wrapper.get('[data-testid="chat-inspect-suggested-configuration"]').trigger('click');
  expect(mocks.inspect).toHaveBeenCalledTimes(2);
});

it('selects the bundled configuration for first use without accessing the repository', async () => {
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'candidate-results', selectionPolicy: 'first-use-download' } });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  void cleanup;
  const repository = 'google/gemma-4-E2B-it-qat-q4_0-gguf';
  const row = wrapper.get('[data-testid="chat-model-suggestion"][data-repository="gemma-4-e2b"]');
  const name = row.element.parentElement?.querySelector<HTMLButtonElement>('[data-testid="chat-model-suggestion-choose"]');
  expect(name).toBeDefined();
  expect(name?.textContent).toContain('Q4_0 (QAT)');
  const download = row.element.parentElement?.querySelector<HTMLButtonElement>('[data-testid="model-selector-variant-download"]');
  expect(download).toBeDefined();
  download?.click();
  expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    repository,
    destination: { kind: 'opfs' },
    key: bundledRepositoryDownloadKey({ repository, variant: 'Q4_0', companionPath: 'gemma-4-E2B-it-mmproj.gguf' }),
  }));
  expect(wrapper.emitted('select-for-first-use')).toBeUndefined();
  name?.click();
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(row.attributes('aria-expanded')).toBe('false');
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.permission).not.toHaveBeenCalled();
  expect(wrapper.emitted('select')).toBeUndefined();
  expect(wrapper.emitted('select-for-first-use')?.[0]?.[0]).toMatchObject({
    modelId: `hf.co/${repository}:Q4_0`,
    source: { kind: 'bundled', repository, variant: 'Q4_0', companionPath: 'gemma-4-E2B-it-mmproj.gguf' },
    destination: { kind: 'opfs' },
  });
  expect(wrapper.emitted('select-for-first-use')?.[0]).toHaveLength(1);
  const selected = wrapper.emitted('select-for-first-use')?.[0]?.[0] as NonNullable<InstanceType<typeof LlamaCppBrowserRepositoryPicker>['$props']['selectedForFirstUse']>;
  await wrapper.setProps({ selectedForFirstUse: selected });
  expect(name?.getAttribute('aria-pressed')).toBe('true');
  expect(name?.textContent).toContain('Downloads automatically');
  downloadJobs.value = [{
    id: 6,
    key: bundledRepositoryDownloadKey({ repository, variant: 'Q4_0', companionPath: 'gemma-4-E2B-it-mmproj.gguf' }),
    repository,
    source: 'suggestion',
    destination: { kind: 'opfs' },
    status: 'downloading',
    selection: undefined,
    error: undefined,
    progress: { phase: 'transferring', completed: 128, processed: 128, total: 256 },
  }];
  await flushPromises();
  expect(row.element.parentElement?.textContent).toContain('Downloading');
  expect(row.element.parentElement?.textContent).toContain('50%');
  expect(name?.textContent).not.toContain('Downloads automatically');
});

it.each([
  { id: 'gemma-4-e2b', repository: 'google/gemma-4-E2B-it-qat-q4_0-gguf', variant: 'Q4_0' },
  { id: 'smollm2-135m', repository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', variant: 'Q4_K_M' },
])('opens the base ID for a saved $id suggestion without metadata or a download', async ({ id, repository, variant }) => {
  const modelId = `hf.co/${repository}:${variant}`;
  const stored = { modelId, size: 123, importedAt: 1 };
  mocks.inventory.mockResolvedValue([stored]);
  mocks.modelEntry.mockResolvedValue(stored);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'candidate-results', selectionPolicy: 'first-use-download' } });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  void cleanup;
  const row = wrapper.get(`[data-testid="chat-model-suggestion"][data-repository="${id}"]`);
  row.element.parentElement?.querySelector<HTMLButtonElement>('[aria-pressed]')?.click();
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(mocks.modelEntry).toHaveBeenCalledWith({ modelId, signal: expect.any(AbortSignal) });
  expect(wrapper.emitted('select-model')?.[0]).toEqual([stored]);
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it.each(['first-use-download', 'installed-only'] as const)('uses a completed bundled download without another repository lookup with %s selection', async selectionPolicy => {
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'candidate-results', selectionPolicy } });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  void cleanup;
  const repository = 'google/gemma-4-E2B-it-qat-q4_0-gguf';
  const companionPath = 'gemma-4-E2B-it-mmproj.gguf';
  await wrapper.get('[data-testid="chat-model-suggestion"][data-repository="gemma-4-e2b"]').trigger('click');
  await flushPromises();
  const choose = wrapper.get<HTMLButtonElement>('[data-testid="model-selector-choose-configuration"]');
  expect(choose.element.disabled).toBe(selectionPolicy === 'installed-only');
  expect(wrapper.emitted('select-model')).toBeUndefined();
  expect(wrapper.emitted('select-for-first-use')).toBeUndefined();
  const selection = { repository, revision: 'a'.repeat(40), files: [{ path: 'gemma-4-E2B_q4_0-it.gguf', size: 256 }, { path: companionPath, size: 128 }] };
  const model = { modelId: `hf.co/${repository}:Q4_0`, size: 384, importedAt: 1 };
  mocks.installed.mockResolvedValue(model);
  downloadJobs.value = [{
    id: 5,
    key: bundledRepositoryDownloadKey({ repository, variant: 'Q4_0', companionPath }),
    repository,
    source: 'suggestion',
    destination: { kind: 'opfs' },
    status: 'complete',
    selection,
    progress: undefined,
    error: undefined,
  }];
  await flushPromises();
  expect(wrapper.text()).not.toContain('Downloads automatically');
  expect(choose.element.disabled).toBe(false);
  await choose.trigger('click');
  expect(wrapper.emitted('select-model')).toEqual([[model]]);
  expect(mocks.inspect).not.toHaveBeenCalled();
});

it('uses the bundled audio files offline and resolves both files when download is requested', async () => {
  const suggestion = audioModelCatalog[0]!;
  const hint = suggestion.quantizationHints[0];
  const companion = hint.companionFiles?.[0];
  const live = { ...catalog, repository: hint.hfRepository, projectors: companion ? [companion] : [] };
  mocks.inspect.mockResolvedValue(live);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'candidate-results', selectionPolicy: 'installed-only', suggestions: audioModelCatalog, repositoryUsage: 'audio-generation' } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  const audioRow = wrapper.get(`[data-testid="chat-model-suggestion"][data-repository="${suggestion.id}"]`);
  await audioRow.trigger('click');
  expect(wrapper.text()).toContain('Required companion');
  await wrapper.get('[data-testid="model-selector-edit-configuration"]').trigger('click');
  expect(wrapper.find('[role="switch"]').exists()).toBe(false);
  expect(mocks.inspect).not.toHaveBeenCalled();

  const request = wrapper.getComponent(ModelSelectorVariantDownload).props('request');
  const signal = new AbortController().signal;
  expect(await request?.prepare({ signal })).toEqual({ repository: hint.hfRepository, revision: live.revision, files: [live.models[0]!.files[0], companion] });
  expect(mocks.inspect).toHaveBeenCalledOnce();
  mocks.inspect.mockResolvedValue({ ...live, projectors: [] });
  await expect(request?.prepare({ signal })).rejects.toThrow();
});

it('checks for the required companion before selecting a bundled audio model already on the device', async () => {
  const suggestion = audioModelCatalog[0]!;
  const hint = suggestion.quantizationHints[0];
  const model = { modelId: `hf.co/${hint.hfRepository}:${hint.preferredQuantization}`, size: 256, importedAt: 1 };
  mocks.inventory.mockResolvedValue([model]);
  mocks.modelFiles.mockResolvedValue({ directory: { projectorFile: undefined } });
  mocks.modelEntry.mockResolvedValue(model);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'candidate-results', selectionPolicy: 'installed-only', suggestions: audioModelCatalog, repositoryUsage: 'audio-generation' } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.get(`[data-testid="chat-model-suggestion-choose"][aria-label="${suggestion.name}"]`).trigger('click');
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(mocks.modelFiles).toHaveBeenCalled();
  expect(mocks.modelEntry).not.toHaveBeenCalled();
  expect(wrapper.emitted('select-model')).toBeUndefined();
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="model-selector-choose-configuration"]').attributes('disabled')).toBeDefined();
});

it('includes the mandatory audio companion when downloading from a Hugging Face search result', async () => {
  const repository = audioModelCatalog[0]!.quantizationHints[0].hfRepository;
  const projector = { path: 'current-mmproj-Q8_0.gguf', size: 128 };
  const live = { ...catalog, repository, projectors: [projector] };
  vi.mocked(searchGgufModels).mockResolvedValueOnce({ results: [{ id: repository }], nextCursor: undefined });
  mocks.inspect.mockResolvedValue(live);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'inline-results', selectionPolicy: 'installed-only', suggestions: audioModelCatalog, repositoryUsage: 'audio-generation' } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue('audio');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(mocks.inspect).not.toHaveBeenCalled();
  const request = wrapper.getComponent(ModelSelectorVariantDownload).props('request');
  const signal = new AbortController().signal;
  expect(request?.key).toBe(repositoryDefaultDownloadKey({ repository, usage: 'audio-generation' }));
  expect(await request?.prepare({ signal })).toEqual({ repository, revision: live.revision, files: [live.models[0]!.files[0], projector] });
  mocks.inspect.mockResolvedValue({ ...live, projectors: [] });
  await expect(request?.prepare({ signal })).rejects.toThrow();

  await wrapper.get('[data-testid="model-selector-hf-result"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="model-selector-choose-configuration"]').attributes('disabled')).toBeDefined();
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  expect(mocks.installed).not.toHaveBeenCalled();
});

it.each(['hf.co/', ''] as const)('keeps a pasted %s repository variant and offers its audio download', async prefix => {
  const repository = audioModelCatalog[0]!.quantizationHints[0].hfRepository;
  const projector = { path: 'current-mmproj-Q8_0.gguf', size: 128 };
  const live = { ...catalog, repository, projectors: [projector] };
  mocks.inspect.mockResolvedValue(live);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'inline-results', selectionPolicy: 'installed-only', suggestions: audioModelCatalog, repositoryUsage: 'audio-generation' } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue(prefix + repository + ':Q8_0');
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(searchGgufModels).not.toHaveBeenCalled();
  const request = wrapper.getComponent(ModelSelectorVariantDownload).props('request');
  expect(request?.prepared).toEqual({ repository, revision: live.revision, files: [live.models[1]!.files[0], projector] });
  expect(wrapper.find('[data-testid="chat-repository-multimodal"]').exists()).toBe(false);
});

it('uses the pasted variant ahead of a first-use selection for the same repository', async () => {
  const target = confirmModelLaunchConfiguration({ catalog, mainFilePath: 'Model-Q4_K_M.gguf', companionFilePath: undefined, multimodal: 'off' });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, {
    props: {
      disabled: false,
      layout: 'inline-results',
      selectionPolicy: 'first-use-download',
      selectedForFirstUse: { modelId: target.modelId, source: { kind: 'resolved', target }, destination: { kind: 'opfs' }, authorizeDestination: async ({ destination }) => ({ destination, expectedRoot: undefined }) },
    },
  });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue(catalog.repository + ':Q8_0');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  await wrapper.get('[data-testid="model-selector-choose-configuration"]').trigger('click');
  expect(wrapper.emitted('select-for-first-use')?.[0]?.[0]).toMatchObject({ source: { target: { mainFilePath: 'Model-Q8_0.gguf' } } });
});

it('offers a background download and independently selects the standard construction from an HF result name', async () => {
  vi.mocked(searchGgufModels).mockResolvedValueOnce({ results: [{ id: catalog.repository }], nextCursor: undefined });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'inline-results', selectionPolicy: 'first-use-download' } });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue('example');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="model-selector-variant-download"]').trigger('click');
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  expect(wrapper.emitted('select-for-first-use')).toBeUndefined();

  await wrapper.get('[data-testid="model-selector-hf-result-choose"]').trigger('click');
  await flushPromises();
  expect(wrapper.emitted('select-for-first-use')).toHaveLength(1);
  const expected = { repository: catalog.repository, revision: catalog.revision, files: [catalog.models[0]!.files[0]!] };
  expect(wrapper.emitted('select-for-first-use')?.[0]?.[0]).toMatchObject({ source: { kind: 'resolved', target: { selection: expected } } });
  expect(await mocks.enqueue.mock.calls[0]![0].prepare({ signal: new AbortController().signal })).toEqual(expected);
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  void cleanup;
});

it('waits for the local check and selects an installed HF result without a first-use download', async () => {
  vi.mocked(searchGgufModels).mockResolvedValueOnce({ results: [{ id: catalog.repository }], nextCursor: undefined });
  const lookup = Promise.withResolvers<LocalModel | undefined>();
  mocks.installed.mockReturnValueOnce(lookup.promise);
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'inline-results', selectionPolicy: 'first-use-download' } });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue('example');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  await wrapper.get('[data-testid="model-selector-hf-result-choose"]').trigger('click');
  await flushPromises();
  expect(mocks.installed).toHaveBeenCalledOnce();
  expect(wrapper.emitted('select-for-first-use')).toBeUndefined();
  expect(wrapper.emitted('select-model')).toBeUndefined();

  const local: LocalModel = { modelId: 'hf.co/owner/Model-GGUF:Q4_K_M', importedAt: 1, size: 256 };
  lookup.resolve(local);
  await flushPromises();
  expect(wrapper.emitted('select-model')).toEqual([[local]]);
  expect(wrapper.emitted('select-for-first-use')).toBeUndefined();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  void cleanup;
});

it('keeps the queued default result attached when inspecting a different configuration', async () => {
  vi.mocked(searchGgufModels).mockResolvedValueOnce({ results: [{ id: catalog.repository }], nextCursor: undefined });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'inline-results', selectionPolicy: 'first-use-download' } });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  void cleanup;
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue('example');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  const download = wrapper.get('[data-testid="model-selector-variant-download"]');
  const destination = wrapper.get('[data-testid="model-selector-download-destination"]');
  expect(destination.text()).toContain('OPFS');
  expect(download.attributes('aria-describedby')).toBe(destination.attributes('id'));
  await download.trigger('click');
  downloadJobs.value = [{
    id: 16,
    key: repositoryDefaultDownloadKey({ repository: catalog.repository, usage: 'chat' }),
    repository: catalog.repository,
    source: 'repository',
    destination: { kind: 'opfs' },
    status: 'queued',
    selection: undefined,
    error: undefined,
    progress: undefined,
  }];
  await wrapper.get('[data-testid="model-selector-hf-result"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="model-selector-variant-stop"]').trigger('click');
  expect(mocks.stopDownload).toHaveBeenCalledExactlyOnceWith({ id: 16 });
  expect(mocks.enqueue).toHaveBeenCalledOnce();
});

it('restores a selected nondefault variant with multimodal off when the HF row is reopened', async () => {
  const companion = { path: 'mmproj-F16.gguf', size: 128 };
  mocks.inspect.mockResolvedValue({ ...catalog, projectors: [companion] });
  vi.mocked(searchGgufModels).mockResolvedValueOnce({ results: [{ id: catalog.repository }], nextCursor: undefined });
  const main = catalog.models[1]!.files[0]!;
  const modelId = 'hf.co/' + catalog.repository + ':Q8_0';
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, {
    props: {
      disabled: false,
      layout: 'inline-results',
      selectionPolicy: 'first-use-download',
      selectedForFirstUse: {
        modelId,
        source: { kind: 'resolved', target: { modelId, mainFilePath: main.path, selection: { repository: catalog.repository, revision: catalog.revision, files: [main] } } },
        destination: { kind: 'opfs' },
        authorizeDestination: undefined,
      },
    },
  });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  void cleanup;
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue('example');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  await wrapper.get('[data-testid="model-selector-hf-result"]').trigger('click');
  await flushPromises();
  const summary = wrapper.get('[data-testid="model-selector-choose-configuration"]');
  expect(summary.text()).toContain('Selected configuration');
  expect(summary.text()).toContain('Q8_0');
  expect(summary.text()).toContain('Without multimodal');
  expect(summary.attributes('aria-pressed')).toBe('true');
});

it('downloads the clicked quantization independently of the checked model', async () => {
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'inline-results', selectionPolicy: 'first-use-download' } });
  using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  void cleanup;
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  await wrapper.get('[data-testid="model-selector-edit-configuration"]').trigger('click');
  const [q4, q8] = wrapper.findAll('[data-testid="model-selector-variant-download"]');
  expect(q4?.attributes('aria-label')).toContain('Q4_K_M');
  await q8!.trigger('click');
  const selection = { repository: catalog.repository, revision: catalog.revision, files: [catalog.models[1]!.files[0]!] };
  expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repository: catalog.repository, destination: { kind: 'opfs' } }));
  expect(await mocks.enqueue.mock.calls[0]![0].prepare()).toEqual(selection);
  expect(wrapper.emitted('select-for-first-use')).toBeUndefined();
  expect(wrapper.findAll('[data-testid="chat-repository-main-file"]')[0]?.attributes('aria-pressed')).toBe('true');
  downloadJobs.value = [{
    id: 7,
    key: selectionKey({ selection }),
    repository: catalog.repository,
    source: 'repository',
    destination: { kind: 'opfs' },
    status: 'downloading',
    selection,
    progress: { phase: 'transferring', completed: 128, processed: 128, total: 256 },
    error: undefined,
  }];
  await flushPromises();
  expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
  await wrapper.get('[data-testid="model-selector-variant-stop"]').trigger('click');
  expect(mocks.stopDownload).toHaveBeenCalledExactlyOnceWith({ id: 7 });
  await wrapper.findAll('[data-testid="chat-repository-main-file"]')[1]!.trigger('click');
  await flushPromises();
  const selected = wrapper.emitted('select-for-first-use')?.[0]?.[0];
  expect(selected).toMatchObject({ source: { kind: 'resolved', target: { mainFilePath: 'Model-Q8_0.gguf' } } });
  expect(wrapper.emitted('select-for-first-use')?.[0]?.[1]).toBe('keep-open');
  await wrapper.setProps({ selectedForFirstUse: selected as NonNullable<InstanceType<typeof LlamaCppBrowserRepositoryPicker>['$props']['selectedForFirstUse']> });
  expect(wrapper.get('[data-testid="model-selector-choose-configuration"]').attributes('aria-pressed')).toBe('true');
});

it.each([false, true])('passes the selected files to chat with multimodal set to %s', async multimodal => {
  const projector = { path: 'mmproj-Model-F16.gguf', size: 128 };
  mocks.inspect.mockResolvedValue({ ...catalog, projectors: [projector] });
  const wrapper = mount(LlamaCppBrowserRepositoryPicker, { props: { disabled: false, layout: 'inline-results' } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="model-selector-hf-query"]').setValue(`https://huggingface.co/${catalog.repository}`);
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(wrapper.text()).toContain('Default configuration');
  expect(wrapper.find('[data-testid="chat-repository-main-file"]').exists()).toBe(false);
  await wrapper.get('[data-testid="model-selector-edit-configuration"]').trigger('click');
  const control = wrapper.get('[data-testid="chat-repository-multimodal"]');
  expect(control.attributes('aria-checked')).toBe('true');
  if (!multimodal) {
    await control.trigger('click');
  }
  const [first, second] = wrapper.findAll('[data-testid="chat-repository-main-file"]');
  expect(first?.text()).toContain('Q4_K_M');
  await second!.trigger('click');
  await flushPromises();
  expect(wrapper.emitted('select')).toBeUndefined();
  await wrapper.get('[data-testid="model-selector-choose-configuration"]').trigger('click');
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({
    target: { selection: { files: [{ path: 'Model-Q8_0.gguf', size: 256 }, ...(multimodal ? [projector] : [])] } },
    destination: { kind: 'opfs' },
  });
});
