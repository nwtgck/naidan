import { downloadDestinationControl, modelConfigurationControl } from './model-configuration.test-support';
import { beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { computed, ref, type Ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import type { useSettings } from '@/composables/useSettings';
import type { HostModelDirectoryChoice } from '@/composables/useHostModelDirectories';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { TEST_ONLY as destinationTest } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import LlamaCppBrowserRepositoryPicker from './LlamaCppBrowserRepositoryPicker.vue';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), installed: vi.fn(), permission: vi.fn(), add: vi.fn(), reconnect: vi.fn() }));
let settings: Ref<Settings>;
let entries: Ref<HostModelDirectoryChoice[]>;
let supported: Ref<boolean>;
let folderBusy: Ref<boolean>;
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
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: mocks.inspect }) }));
vi.mock('../hugging-face/storage', () => ({ installedSelection: mocks.installed }));
vi.mock('./LlamaCppBrowserHuggingFaceSearch.vue', () => ({ default: { template: '<div />', props: ['disabled', 'repositoryInput'] } }));
vi.mock('@/components/csp/CspMessageHint.vue', () => ({ default: { props: ['target', 'presentation'], template: '<aside data-testid="repository-csp-message" :data-presentation="presentation" />' } }));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: ['Q4_K_M', 'Q8_0'].map(label => ({ label, files: [{ path: `Model-${label}.gguf`, size: 256 }], size: 256 })) };

beforeEach(async () => {
  vi.resetAllMocks();
  destinationTest.reset();
  settings = ref({ ...structuredClone(DEFAULT_SETTINGS), storageType: 'memory', endpoint: { type: 'openai', url: '' } });
  entries = ref([{ id: 'root-a', name: 'Models A', access: 'readwrite', error: undefined }, { id: 'root-b', name: 'Models B', access: 'readwrite', error: undefined }]);
  supported = ref(true);
  folderBusy = ref(false);
  mocks.permission.mockImplementation(async ({ id }: { id: string }) => ({ kind: 'host', directoryId: id }));
  mocks.inspect.mockResolvedValue(catalog);
  mocks.installed.mockResolvedValue(undefined);
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
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  expect(mocks.inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
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
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
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
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="repository-csp-message"]').attributes('data-presentation')).toBe('error');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="chat-model-repository-check"]').element.disabled).toBe(false);
  await wrapper.get('[data-testid="chat-model-repository"]').setValue('not a repository');
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
  await flushPromises();
  expect(mocks.inspect).toHaveBeenCalledOnce();
  expect(wrapper.find('[data-testid="repository-csp-message"]').exists()).toBe(false);
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
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
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
  const search = wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).vm;
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="chat-model-repository"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="chat-model-repository-name"]').text()).toBe(catalog.repository);
  expect(wrapper.get('[data-testid="chat-model-back-to-search"]').find('svg').exists()).toBe(true);
  await wrapper.get('[data-testid="chat-model-back-to-search"]').trigger('click');
  expect(wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).vm).toBe(search);
  expect(wrapper.get<HTMLInputElement>('[data-testid="chat-model-repository"]').element.value).toBe(catalog.repository);
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
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
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
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
  await flushPromises();
  expect(modelConfigurationControl({ view: wrapper, field: 'companion' }).props('modelValue')).toBe('');
  expect(wrapper.get('[data-testid="chat-use-repository-model"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="llama-model-multimodal"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-use-repository-model"]').attributes('disabled')).toBeUndefined();
});

async function inspectRepository({ wrapper }: { wrapper: VueWrapper }): Promise<void> {
  await wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
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
