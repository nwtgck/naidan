import { previewTest, resetRepositoryPreviewTest } from '@/features/llama-cpp-browser/components/repository-preview.test-support';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { searchModels } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { TEST_ONLY as launchTest } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ModelDiscoveryPanel from './ModelDiscoveryPanel.vue';

vi.mock('@/composables/useModelDiscoveryTab', async () => {
  const { ref } = await import('vue');
  return { useModelDiscoveryTab: () => ({ remembered: ref('hugging-face'), remember: vi.fn(async () => {}) }) };
});
vi.mock('@/utils/idle-task', () => ({ scheduleIdleTask: () => ({ cancel: vi.fn() }) }));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: async () => [] }));
vi.mock('@/features/llama-cpp-browser/runtime/host-model-store', () => ({ getHostModelInventoryIssues: () => [] }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ captureModelFileStorage: () => () => true, llamaCppBrowserModelFiles: { subscribeModelList: () => () => {} } }));
vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async original => ({ ...await original<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), searchModels: vi.fn() }));
vi.mock('@/components/csp/CspMessageHint.vue', () => ({ default: { render: () => undefined } }));

beforeEach(async () => {
  launchTest.reset();
  resetRepositoryPreviewTest();
  vi.mocked(searchModels).mockReset().mockResolvedValue({ results: [{ id: 'owner/Model-GGUF' }], nextCursor: undefined });
  await ensureAllStringsForTest({ locale: 'en' });
});

function render() {
  const wrapper = mount(ModelDiscoveryPanel, { props: { visibility: 'open', tab: 'hugging-face' }, global: { stubs: { Teleport: true } } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

it('searches repository-like text in the real discovery input and retains the query and list after preview', async () => {
  using view = render();
  await vi.dynamicImportSettled();
  await flushPromises();
  const query = view.wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-query"]');
  expect(view.wrapper.find('[data-testid="hugging-face-repository"]').exists()).toBe(false);
  expect(view.wrapper.get('[data-testid="llama-hf-search"]').findAll('input')).toHaveLength(1);
  expect(searchModels).not.toHaveBeenCalled();
  await query.setValue('owner/Model');
  expect(previewTest.inspect).not.toHaveBeenCalled();
  expect(searchModels).not.toHaveBeenCalled();
  await query.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(searchModels).toHaveBeenCalledExactlyOnceWith({ query: 'owner/Model', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });
  expect(previewTest.inspect).not.toHaveBeenCalled();
  const result = view.wrapper.get('[data-testid="llama-hf-search-result"]');
  await result.trigger('click');
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(previewTest.inspect).toHaveBeenCalledOnce();
  expect(previewTest.inspect.mock.calls[0]?.[0].input).toBe('owner/Model-GGUF');
  expect(view.wrapper.find('[data-testid="discovery-detail"]').exists()).toBe(true);
  await view.wrapper.get('[data-testid="discovery-back"]').trigger('click');
  expect(view.wrapper.get('[data-testid="llama-hf-search-query"]').element).toBe(query.element);
  expect(query.element.value).toBe('owner/Model');
  expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').element).toBe(result.element);
  expect(searchModels).toHaveBeenCalledOnce();
  expect(previewTest.inspect).toHaveBeenCalledOnce();
});

it('chooses an explicit URL without searching and preserves its requested variant in the preview', async () => {
  using view = render();
  await vi.dynamicImportSettled();
  await flushPromises();
  const query = view.wrapper.get('[data-testid="llama-hf-search-query"]');
  await query.setValue('https://hf.co/owner/Model-GGUF:Q8_0');
  expect(view.wrapper.get('[data-testid="llama-hf-search-submit"]').text()).toBe('Choose');
  expect(previewTest.inspect).not.toHaveBeenCalled();
  await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(searchModels).not.toHaveBeenCalled();
  expect(previewTest.inspect).toHaveBeenCalledOnce();
  expect(previewTest.inspect.mock.calls[0]?.[0].input).toBe('https://hf.co/owner/Model-GGUF:Q8_0');
  expect(view.wrapper.get('[data-testid="discovery-detail"]').text()).toContain('Q8_0');
});

it('reports an invalid model URL without falling back to search and clears that error on editing', async () => {
  using view = render();
  await vi.dynamicImportSettled();
  await flushPromises();
  const query = view.wrapper.get('[data-testid="llama-hf-search-query"]');
  await query.setValue('https://huggingface.co/');
  await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  expect(view.wrapper.get('[role="alert"]').text()).toBe('Enter a Hugging Face model page URL.');
  expect(searchModels).not.toHaveBeenCalled();
  expect(previewTest.inspect).not.toHaveBeenCalled();
  await query.setValue('owner/Model');
  expect(view.wrapper.find('[role="alert"]').exists()).toBe(false);
  await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
  expect(searchModels).toHaveBeenCalledOnce();
  expect(previewTest.inspect).not.toHaveBeenCalled();
});

it('cancels the real search on close and ignores its late result instead of opening a preview', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
  vi.mocked(searchModels).mockReturnValue(pending.promise);
  using view = render();
  await vi.dynamicImportSettled();
  await flushPromises();
  await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('owner/Model');
  await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  const signal = vi.mocked(searchModels).mock.calls[0]![0].signal;
  await view.wrapper.setProps({ visibility: 'closed' });
  expect(signal.aborted).toBe(true);
  pending.resolve({ results: [{ id: 'owner/Model-GGUF' }], nextCursor: undefined });
  await flushPromises();
  expect(previewTest.inspect).not.toHaveBeenCalled();
  await view.wrapper.setProps({ visibility: 'open' });
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(view.wrapper.find('[data-testid="llama-hf-search-result"]').exists()).toBe(false);
  expect(searchModels).toHaveBeenCalledOnce();
});
