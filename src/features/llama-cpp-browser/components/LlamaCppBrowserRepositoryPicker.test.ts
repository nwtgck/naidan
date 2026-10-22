import { modelConfigurationControl } from './model-configuration.test-support';
import { beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import LlamaCppBrowserRepositoryPicker from './LlamaCppBrowserRepositoryPicker.vue';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), installed: vi.fn() }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: mocks.inspect }) }));
vi.mock('../hugging-face/storage', () => ({ installedSelection: mocks.installed }));
vi.mock('./LlamaCppBrowserHuggingFaceSearch.vue', () => ({ default: { template: '<div />', props: ['disabled', 'repositoryInput'] } }));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: ['Q4_K_M', 'Q8_0'].map(label => ({ label, files: [{ path: `Model-${label}.gguf`, size: 256 }], size: 256 })) };

beforeEach(async () => {
  vi.resetAllMocks();
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
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ mainFilePath: 'Model-Q8_0.gguf', selection: { repository: catalog.repository, revision: catalog.revision } });
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
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ selection: { files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }, { path: 'mmproj-F16.gguf', size: 512 }] } });
  await wrapper.get('[data-testid="llama-model-multimodal"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="llama-model-companion"]').exists()).toBe(false);
  await wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(wrapper.emitted('select')?.[1]?.[0]).toMatchObject({ selection: { files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] } });
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
