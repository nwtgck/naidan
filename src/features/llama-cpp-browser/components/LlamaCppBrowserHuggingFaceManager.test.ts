import { modelConfigurationControl } from './model-configuration.test-support';
import { modelRemovalPlan } from './model-removal.test-support';
import { getDownloadQueue, TEST_ONLY as queueTest } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { TEST_ONLY as metadataTest } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import type { ModelPreset } from '@/features/llama-cpp-browser/model-preset';
import { MODEL_LAUNCH_QUERY } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { resolveModelLaunchTarget } from '@/features/llama-cpp-browser/model-launch/target';
import { prepareRepositoryRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { DownloadConflictError } from '@/features/llama-cpp-browser/hugging-face/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { discoverRepository, groupModelFiles, searchModels } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { downloadRepository, cancelDownload } from '@/features/llama-cpp-browser/hugging-face/download';
import { defineComponent, ref } from 'vue';
import { provideHuggingFaceSession } from '@/features/llama-cpp-browser/hugging-face/session';
import { installedSelection, listPendingDownloads } from '@/features/llama-cpp-browser/hugging-face/storage';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';
vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), discoverRepository: vi.fn(), searchModels: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download', () => ({ downloadRepository: vi.fn(), cancelDownload: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ listPendingDownloads: vi.fn(), installedSelection: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: confirm }) }));
vi.mock('../runtime/model-store', () => ({ prepareModelRemoval: vi.fn(), prepareRepositoryRemoval: vi.fn() }));
const plan = {
  ...modelRemovalPlan({ modelId: 'hf.co/owner/repo:Q4_K_M', files: [{ relativePath: 'model-Q4_K_M.gguf', size: 48, lastModified: 1 }] }),
  target: { kind: 'repository' as const, location: { kind: 'hugging-face' as const, repository: 'owner/repo' }, journal: undefined },
};
const selection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'model-Q4_K_M.gguf', size: 128 }] };
const wrappers: VueWrapper[] = [];

function render(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false } });
  wrappers.push(wrapper);
  expect(wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).props('scrollOwner')).toBe('results');
  return wrapper;
}

beforeEach(async () => {
  queueTest.reset();
  metadataTest.reset();
  vi.resetAllMocks();
  vi.mocked(installedSelection).mockResolvedValue(undefined);
  confirm.mockResolvedValue(true);
  vi.mocked(prepareRepositoryRemoval).mockResolvedValue({ plan, sharedPlan: undefined, affectedVariants: 0 });
  vi.mocked(cancelDownload).mockResolvedValue('deleted');
  vi.mocked(listPendingDownloads).mockResolvedValue([]);
  vi.mocked(searchModels).mockResolvedValue({ results: [], nextCursor: undefined });
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
  for (const job of getDownloadQueue().jobs.value) {
    getDownloadQueue().cancel({ id: job.id });
  }
  await flushPromises();
  vi.useRealTimers();
});

describe('model launch sharing in download details', () => {
  const copy = vi.fn();
  let clipboardDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    copy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  async function inspectModels({ paths }: { paths: string[] }): Promise<VueWrapper> {
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/Model-GGUF', revision: selection.revision, ...groupModelFiles({ files: paths.map(path => ({ path, size: 128 })) }) });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-model-launch-url"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/Model-GGUF');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('shows and copies the complete URL for the selected split UD model without any extra operations', async () => {
    const paths = ['UD-IQ4_NL/Model-UD-IQ4_NL-00001-of-00002.gguf', 'UD-IQ4_NL/Model-UD-IQ4_NL-00002-of-00002.gguf'];
    const wrapper = await inspectModels({ paths });
    const localChecks = vi.mocked(installedSelection).mock.calls.length;
    const pendingChecks = vi.mocked(listPendingDownloads).mock.calls.length;
    const location = window.location.href;
    const details = wrapper.get<HTMLDetailsElement>('[data-testid="llama-hf-details"]');
    details.element.open = true;
    await details.trigger('toggle');
    const link = wrapper.get('[data-testid="llama-hf-model-launch-url"]');
    expect(link.text()).toBe(link.attributes('href'));
    const input = new URLSearchParams(new URL(link.text()).hash.slice('#/?'.length)).get(MODEL_LAUNCH_QUERY)!;
    expect(input).toBe('hf.co/owner/Model-GGUF:UD-IQ4_NL');
    const { target } = resolveModelLaunchTarget({ input, catalog: { repository: 'owner/Model-GGUF', revision: selection.revision, ...groupModelFiles({ files: paths.map(path => ({ path, size: 128 })) }) } });
    expect(target.selection.files.map(file => file.path)).toEqual(paths);
    const copyButton = wrapper.get('[data-testid="llama-hf-model-launch-copy"]');
    expect(copyButton.attributes('aria-label')).toBe('Copy URL');
    await copyButton.trigger('click');
    await flushPromises();
    expect(copy).toHaveBeenCalledExactlyOnceWith(link.attributes('href'));
    expect(wrapper.get('[data-testid="llama-hf-model-launch-copy-status"]').attributes('role')).toBe('status');
    expect(wrapper.get('[data-testid="llama-hf-model-launch-copy-status"]').text()).toBe('URL copied.');
    expect(discoverRepository).toHaveBeenCalledOnce();
    expect(searchModels).not.toHaveBeenCalled();
    expect(downloadRepository).not.toHaveBeenCalled();
    expect(getDownloadQueue().jobs.value).toEqual([]);
    expect(installedSelection).toHaveBeenCalledTimes(localChecks);
    expect(listPendingDownloads).toHaveBeenCalledTimes(pendingChecks);
    expect(window.location.href).toBe(location);
    expect(wrapper.emitted('modelReady')).toBeUndefined();
  });

  it('resets copy feedback on selection changes and hides stale repository links', async () => {
    const wrapper = await inspectModels({ paths: ['Model-Q4_K_M.gguf', 'Model-UD-IQ4_NL.gguf'] });
    const firstUrl = wrapper.get('[data-testid="llama-hf-model-launch-url"]').text();
    await wrapper.get('[data-testid="llama-hf-model-launch-copy"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-model-launch-copy-status"]').exists()).toBe(true);
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('Model-UD-IQ4_NL.gguf');
    expect(wrapper.get('[data-testid="llama-hf-model-launch-url"]').text()).not.toBe(firstUrl);
    expect(wrapper.find('[data-testid="llama-hf-model-launch-copy-status"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/other');
    expect(wrapper.find('[data-testid="llama-hf-model-launch-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-hf-model-launch-copy"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/Model-GGUF');
    expect(wrapper.get('[data-testid="llama-hf-model-launch-url"]').text()).toContain('UD-IQ4_NL');
    expect(discoverRepository).toHaveBeenCalledOnce();
    expect(downloadRepository).not.toHaveBeenCalled();
  });

  it('reports clipboard failure, keeps the full URL available, and allows retrying', async () => {
    copy.mockRejectedValueOnce(new Error('permission denied'));
    const wrapper = await inspectModels({ paths: ['Model-Q4_K_M.gguf'] });
    const url = wrapper.get('[data-testid="llama-hf-model-launch-url"]').text();
    await wrapper.get('[data-testid="llama-hf-model-launch-copy"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-model-launch-copy-status"]').text()).toBe('Could not copy. Select the URL to copy it manually.');
    expect(wrapper.get('[data-testid="llama-hf-model-launch-url"]').text()).toBe(url);
    await wrapper.get('[data-testid="llama-hf-model-launch-copy"]').trigger('click');
    await flushPromises();
    expect(copy).toHaveBeenNthCalledWith(2, url);
    expect(wrapper.get('[data-testid="llama-hf-model-launch-copy-status"]').text()).toBe('URL copied.');
  });

  it.each(['resolve', 'reject'] as const)('ignores a late clipboard %s after switching away and back to the same model', async outcome => {
    const pending = Promise.withResolvers<void>();
    copy.mockReturnValueOnce(pending.promise);
    const wrapper = await inspectModels({ paths: ['Model-Q4_K_M.gguf', 'Model-Q8_0.gguf'] });
    await wrapper.get('[data-testid="llama-hf-model-launch-copy"]').trigger('click');
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('Model-Q8_0.gguf');
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('Model-Q4_K_M.gguf');
    if (outcome === 'resolve') {
      pending.resolve();
    } else {
      pending.reject(new Error('permission denied'));
    }
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-model-launch-copy-status"]').exists()).toBe(false);
  });

  it('does not publish clipboard feedback after unmounting', async () => {
    const pending = Promise.withResolvers<void>();
    copy.mockReturnValueOnce(pending.promise);
    const wrapper = await inspectModels({ paths: ['Model-Q4_K_M.gguf'] });
    await wrapper.get('[data-testid="llama-hf-model-launch-copy"]').trigger('click');
    wrapper.unmount();
    pending.reject(new Error('permission denied'));
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-model-launch-copy-status"]').exists()).toBe(false);
  });

  it.each([
    ['Model-Q4_K_M.gguf', 'Model_Q4_K_M.gguf'],
    ['Model-Q4_K_M.gguf', 'first/mmproj-F16.gguf', 'other/mmproj-F16.gguf'],
    ['mtp/Model-Q4_K_M.gguf'],
  ])('does not expose a link that cannot reopen the selected main model: %j', async (...paths) => {
    const wrapper = await inspectModels({ paths });
    expect(wrapper.find('[data-testid="llama-hf-model-launch-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-hf-model-launch-copy"]').exists()).toBe(false);
  });
});

describe('Hugging Face download controls', () => {
  it('shows the known model size until a companion is selected and then shows the complete total', async () => {
    const modelFile = { path: 'model-Q4_K_M.gguf', size: 1024 ** 3 };
    const companion = { path: 'vision-a/mmproj-F16.gguf', size: 256 * 1024 ** 2 };
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/repo', revision: selection.revision, models: [{ label: modelFile.path, files: [modelFile], size: modelFile.size }], projectors: [companion, { path: 'vision-b/mmproj-F16.gguf', size: 512 * 1024 ** 2 }] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-model-multimodal"]').attributes('aria-checked')).toBe('true');
    expect(modelConfigurationControl({ view: wrapper, field: 'companion' }).props('modelValue')).toBe('');
    expect(wrapper.get('[data-testid="llama-hf-total"]').text()).toContain('Model 1.00 GiB');
    expect(wrapper.get('[data-testid="llama-hf-total"]').attributes('title')).toContain('choose an additional file');
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click');
    expect(downloadRepository).not.toHaveBeenCalled();
    await modelConfigurationControl({ view: wrapper, field: 'companion' }).setValue(companion.path);
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-total"]').text()).toContain('1.25 GiB');
    expect(wrapper.get('[data-testid="llama-hf-total"]').text()).not.toContain('Model 1.00 GiB');
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="llama-model-multimodal"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-total"]').text()).toContain('1.00 GiB');
    expect(wrapper.get('[data-testid="llama-hf-total"]').attributes('title')).not.toContain('choose an additional file');
  });

  it('keeps search results while inspecting one repository and allows choosing another afterward', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof discoverRepository>>>();
    vi.mocked(searchModels).mockResolvedValue({ results: [{ id: 'owner/first' }, { id: 'owner/second' }], nextCursor: undefined });
    vi.mocked(discoverRepository).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ repository: 'owner/second', revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    await wrapper.findAll('[data-testid="llama-hf-search-result"]')[0]!.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="llama-hf-search-result"]').attributes('disabled')).toBeDefined();
    pending.resolve({ repository: 'owner/first', revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [] });
    await flushPromises();
    await wrapper.findAll('[data-testid="llama-hf-search-result"]')[1]!.trigger('click');
    await flushPromises();
    expect(vi.mocked(discoverRepository).mock.calls.map(call => call[0].input)).toEqual(['owner/first', 'owner/second']);
    expect(wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(2);
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-hf-repository"]').element.value).toBe('owner/second');
    expect(searchModels).toHaveBeenCalledOnce();
    expect(downloadRepository).not.toHaveBeenCalled();
  });

  it('does not search or inspect when the manager is displayed, focused, or edited', async () => {
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('');
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(searchModels).not.toHaveBeenCalled();
    expect(discoverRepository).not.toHaveBeenCalled();
    expect(downloadRepository).not.toHaveBeenCalled();
  });

  it('checks the exact chosen search result through the existing metadata flow without downloading', async () => {
    vi.mocked(searchModels).mockResolvedValue({ results: [{ id: 'owner/repo', downloads: 12, likes: 3 }], nextCursor: undefined });
    vi.mocked(discoverRepository).mockResolvedValue({ ...selection, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(discoverRepository).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('gemma');
    expect(searchModels).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="llama-hf-search-result-query"]').text()).toBe('Results for “qwen”');
    await wrapper.get('[data-testid="llama-hf-search-result"]').trigger('click');
    await flushPromises();
    expect(discoverRepository).toHaveBeenCalledOnce();
    expect(vi.mocked(discoverRepository).mock.calls[0]?.[0].input).toBe('owner/repo');
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-hf-repository"]').element.value).toBe('owner/repo');
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('model-Q4_K_M.gguf');
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(downloadRepository).not.toHaveBeenCalled();
    expect(wrapper.emitted('modelReady')).toBeUndefined();
  });

  it('keeps search pending until explicit cancellation and blocks concurrent repository inspection in the UI', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockReturnValue(pending.promise);
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-hf-search-query"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('busy')?.at(-1)).toEqual([true]);
    await wrapper.get('[data-testid="llama-hf-search-cancel"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('busy')?.at(-1)).toEqual([false]);
    pending.resolve({ results: [{ id: 'old/repo' }], nextCursor: undefined });
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-search-result"]').exists()).toBe(false);
    expect(discoverRepository).not.toHaveBeenCalled();
  });

  it('marks existing selections downloaded and publishes the exact local model without downloading', async () => {
    const model = { modelId: 'hf.co/owner/repo:Q4_K_M', size: 128, importedAt: 1 };
    vi.mocked(installedSelection).mockResolvedValue(model);
    vi.mocked(discoverRepository).mockResolvedValue({ ...selection, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').text()).toContain('Downloaded');
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    expect(wrapper.emitted('modelReady')).toEqual([[model]]);
    expect(downloadRepository).not.toHaveBeenCalled();
    vi.mocked(installedSelection).mockResolvedValue(undefined);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.emitted('changed')).toHaveLength(1);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });

  it('rechecks completed downloads and ignores an earlier selection check', async () => {
    const stale = Promise.withResolvers<Awaited<ReturnType<typeof installedSelection>>>();
    const models = ['repo-Q4_K_M.gguf', 'repo-Q8_0.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    const ready = { modelId: 'hf.co/owner/repo:Q8_0', size: 128, importedAt: 1 };
    vi.mocked(discoverRepository).mockResolvedValue({ ...selection, models, projectors: [] });
    vi.mocked(installedSelection).mockReturnValueOnce(stale.promise);
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('repo-Q8_0.gguf');
    await flushPromises();
    stale.resolve({ ...ready, modelId: 'hf.co/owner/repo:Q4_K_M' });
    await flushPromises();
    expect(wrapper.emitted('modelReady')).toBeUndefined();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    vi.mocked(downloadRepository).mockImplementation(async () => {
      vi.mocked(installedSelection).mockResolvedValue(ready);
    });
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('modelReady')).toEqual([[ready]]);
    expect(wrapper.get('[data-testid="llama-hf-download"]').text()).toContain('Downloaded');
  });

  it('keeps prepared inputs and manual choices across modal tabs without another metadata request', async () => {
    const models = ['repo-Q4_K_M.gguf', 'repo-Q8_0.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ ...selection, models, projectors: [] });
    const visible = ref(true);
    const modelPreset: ModelPreset = { input: 'hf.co/owner/repo:Q4_K_M', target: 'onboarding', claim: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) };
    const wrapper = mount(defineComponent({
      components: { LlamaCppBrowserHuggingFaceManager },
      setup() {
        provideHuggingFaceSession();
        return { visible, modelPreset };
      },
      template: '<LlamaCppBrowserHuggingFaceManager v-if="visible" :disabled="false" :model-preset="modelPreset" />',
    }));
    wrappers.push(wrapper);
    await flushPromises();
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('repo-Q8_0.gguf');
    await flushPromises();
    const checks = vi.mocked(installedSelection).mock.calls.length;
    visible.value = false;
    await flushPromises();
    visible.value = true;
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-hf-repository"]').element.value).toBe(modelPreset.input);
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('repo-Q8_0.gguf');
    expect(discoverRepository).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installedSelection).mock.calls.length).toBeGreaterThan(checks);
  });

  it('prepares a preset once after availability without starting a download or reapplying on remount', async () => {
    const claim = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const modelPreset: ModelPreset = { input: 'hf.co/owner/repo:QAD-Q4_0', target: 'settings', claim };
    const paths = ['repo-Q4_K_M.gguf', 'repo-QAD-Q4_0.gguf'];
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/repo', revision: selection.revision, models: paths.map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 })), projectors: [] });
    const wrapper = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: true, modelPreset } });
    wrappers.push(wrapper);
    await flushPromises();
    expect(discoverRepository).not.toHaveBeenCalled();
    await wrapper.setProps({ disabled: false });
    await flushPromises();
    expect(discoverRepository).toHaveBeenCalledTimes(1);
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('repo-QAD-Q4_0.gguf');
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('options')).toHaveLength(2);
    expect(downloadRepository).not.toHaveBeenCalled();
    wrapper.unmount();
    const reopened = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false, modelPreset } });
    wrappers.push(reopened);
    await flushPromises();
    expect(discoverRepository).toHaveBeenCalledTimes(1);
  });

  it('discards a superseded metadata response and prepares the newer preset', async () => {
    const first = Promise.withResolvers<Awaited<ReturnType<typeof discoverRepository>>>();
    vi.mocked(discoverRepository).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ repository: 'owner/repo', revision: selection.revision, models: [{ label: 'repo-Q8_0.gguf', files: [{ path: 'repo-Q8_0.gguf', size: 128 }], size: 128 }], projectors: [] });
    const preset = ({ input }: { input: string }): ModelPreset => ({ input, target: 'settings', claim: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) });
    const wrapper = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false, modelPreset: preset({ input: 'hf.co/owner/repo:Q4_K_M' }) } });
    wrappers.push(wrapper);
    await flushPromises();
    const signal = vi.mocked(discoverRepository).mock.calls[0]![0].signal;
    await wrapper.setProps({ modelPreset: preset({ input: 'hf.co/owner/repo:Q8_0' }) });
    expect(signal.aborted).toBe(true);
    first.resolve({ repository: 'owner/repo', revision: selection.revision, models: [], projectors: [] });
    await flushPromises();
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('repo-Q8_0.gguf');
    expect(downloadRepository).not.toHaveBeenCalled();
  });

  it('selects a complete quantization group and an independent optional projector', async () => {
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [{ path: 'mmproj-F16.gguf', size: 64 }] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('model-Q4_K_M.gguf');
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('options')).toContainEqual(expect.objectContaining({ label: 'model-Q4_K_M', detail: '0.1 KiB' }));
    expect(wrapper.get('[data-testid="llama-model-quantization"]').text()).toBe('model-Q4_K_M');
    expect(wrapper.get('[data-testid="llama-model-multimodal"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-testid="llama-hf-details"]').text()).toContain('mmproj-F16.gguf');
    expect(modelConfigurationControl({ view: wrapper, field: 'companion' }).props('options')).toContainEqual(expect.objectContaining({ label: 'F16', detail: '0.1 KiB' }));
    expect(wrapper.get('[data-testid="llama-model-companion"]').text()).toBe('F16');
    expect(wrapper.get('[data-testid="llama-hf-repository-link"]').attributes('href')).toBe('https://huggingface.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click');
    await flushPromises();
    expect(downloadRepository).toHaveBeenCalledWith(expect.objectContaining({ selection: { ...selection, files: [...selection.files, { path: 'mmproj-F16.gguf', size: 64 }] } }));
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });

  it('keeps an explicit quantization and multimodal OFF when checking the same repository again', async () => {
    const models = ['model-Q8_0.gguf', 'model-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models, projectors: [{ path: 'mmproj.gguf', size: 64 }] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('model-Q8_0.gguf');
    await wrapper.get('[data-testid="llama-model-multimodal"]').trigger('click');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('model-Q8_0.gguf');
    expect(wrapper.get('[data-testid="llama-model-quantization"]').text()).toBe('model-Q8_0');
    expect(wrapper.get('[data-testid="llama-model-multimodal"]').attributes('aria-checked')).toBe('false');
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(downloadRepository).mock.calls[0]?.[0].selection.files).toEqual([{ path: 'model-Q8_0.gguf', size: 128 }]);
  });

  it('prioritizes explicit variants over saved choices while keeping every model selectable', async () => {
    const models = ['repo-Q4_K_M.gguf', 'repo-QAD-Q4_0.gguf', 'repo-AWQ-Q4_K_M.gguf', 'repo-UD-Q4_K_XL.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/repo', revision: selection.revision, models, projectors: [] });
    const wrapper = render();
    await flushPromises();
    const input = wrapper.get('[data-testid="llama-hf-repository"]');
    await input.setValue('hf.co/owner/repo:QAD-Q4_0');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    const select = modelConfigurationControl({ view: wrapper, field: 'quantization' });
    expect(select.props('modelValue')).toBe('repo-QAD-Q4_0.gguf');
    expect(select.props('options')).toHaveLength(4);
    await select.setValue('repo-Q4_K_M.gguf');
    for (const variant of ['AWQ-Q4_K_M', 'UD-Q4_K_XL']) {
      await input.setValue(`hf.co/owner/repo:${variant}`);
      await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
      await flushPromises();
      expect(select.props('modelValue')).toBe(`repo-${variant}.gguf`);
      expect(select.get('button').attributes('title')).toContain(variant);
      expect(wrapper.get('[data-testid="llama-model-quantization"]').text()).toBe(variant);
    }
    await input.setValue('hf.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(select.props('modelValue')).toBe('repo-UD-Q4_K_XL.gguf');
  });

  it('keeps ordinary and UD choices distinct and retains all selected UD shards after refreshing', async () => {
    const paths = ['repo-IQ4_NL.gguf', 'UD-IQ4_NL/repo-UD-IQ4_NL-00001-of-00002.gguf', 'UD-IQ4_NL/repo-UD-IQ4_NL-00002-of-00002.gguf'];
    const files = paths.map(path => ({ path, size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, ...groupModelFiles({ files }) });
    const wrapper = render();
    await flushPromises();
    const input = wrapper.get('[data-testid="llama-hf-repository"]');
    await input.setValue('hf.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    const select = modelConfigurationControl({ view: wrapper, field: 'quantization' });
    expect(select.props('options')).toEqual([
      { value: paths[0], label: 'IQ4_NL', detail: '0.1 KiB' },
      { value: paths[1], label: 'UD-IQ4_NL', detail: '0.3 KiB' },
    ]);
    expect(select.props('modelValue')).toBe(paths[0]);
    await select.setValue(paths[1]);
    expect(wrapper.get('[data-testid="llama-model-quantization"]').text()).toBe('UD-IQ4_NL');
    expect(select.get('button').attributes('title')).toContain('UD-IQ4_NL');
    for (const variant of ['UD-IQ4_NL', 'IQ4_NL · UD']) {
      await input.setValue(`hf.co/owner/repo:${variant}`);
      await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
      await flushPromises();
      expect(select.props('modelValue')).toBe(paths[1]);
      expect(select.get('button').attributes('title')).toContain('UD-IQ4_NL');
      expect(vi.mocked(installedSelection).mock.lastCall?.[0].selection.files).toEqual(files.slice(1));
    }
    await input.setValue('hf.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(select.props('modelValue')).toBe(paths[1]);
    expect(select.get('button').attributes('title')).toContain('UD-IQ4_NL');
    const planFiles = wrapper.get('[data-testid="llama-hf-files"]').text();
    for (const path of paths.slice(1)) {
      expect(planFiles).toContain(path);
    }
    expect(planFiles).not.toContain(paths[0]);
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click');
    await flushPromises();
    expect(downloadRepository).toHaveBeenCalledWith(expect.objectContaining({ selection: { ...selection, files: files.slice(1) } }));
  });

  it('disambiguates coincident variant labels with their paths in the options and selected title', async () => {
    const repository = 'owner/repo-A3B-GGUF';
    const paths = ['repo-Q4_K_M.gguf', 'repo-A3B-Q4_K_M.gguf'];
    const files = paths.map(path => ({ path, size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository, revision: selection.revision, ...groupModelFiles({ files }) });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue(repository);
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    const select = modelConfigurationControl({ view: wrapper, field: 'quantization' });
    expect(select.props('options')).toHaveLength(paths.length);
    expect(select.props('options')).toEqual(expect.arrayContaining(paths.map(path => ({ value: path, label: `Q4_K_M (${path})`, detail: '0.1 KiB' }))));
    await select.setValue(paths[1]);
    expect(wrapper.get('[data-testid="llama-model-quantization"]').text()).toBe(`Q4_K_M (${paths[1]})`);
    expect(select.get('button').attributes('title')).toContain(`Q4_K_M (${paths[1]})`);
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click');
    await flushPromises();
    expect(downloadRepository).toHaveBeenCalledWith(expect.objectContaining({ selection: { repository, revision: selection.revision, files: [files[1]] } }));
  });

  it.each(['unknown', 'Q4_K_M'])('requires an explicit choice for an unavailable or ambiguous variant: %s', async requestedVariant => {
    const models = ['repo-Q4_K_M.gguf', 'repo-Q4_K_M-00001-of-00002.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/repo', revision: selection.revision, models, projectors: [] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue(`hf.co/owner/repo:${requestedVariant}`);
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('modelValue')).toBe('');
    expect(wrapper.get('[data-testid="llama-model-quantization"]').text()).toBe('Choose model files');
    expect(wrapper.find('[data-testid="llama-hf-requested-variant-unresolved"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('repo-Q4_K_M.gguf');
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-requested-variant-unresolved"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
  });

  it('keeps distinct variants directly selectable and hides multimodal controls when unavailable', async () => {
    const models = ['base-Q4_K_M.gguf', 'other-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models, projectors: [] });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    expect(modelConfigurationControl({ view: wrapper, field: 'quantization' }).props('options')).toContainEqual(expect.objectContaining({ label: 'base-Q4_K_M', detail: '0.1 KiB' }));
    expect(wrapper.find('[data-testid="llama-hf-selection-required"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="llama-model-multimodal"]').exists()).toBe(false);
    await modelConfigurationControl({ view: wrapper, field: 'quantization' }).setValue('other-Q4_K_M.gguf');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="llama-hf-files"]').text()).toContain('other-Q4_K_M.gguf');
  });

  it.each([
    { failure: new DownloadConflictError({ reason: 'existing-files' }), message: 'Model files already exist' },
    { failure: new DownloadConflictError({ reason: 'different-download' }), message: 'A different download already exists' },
    { failure: new Error('private source path and network details'), message: 'The operation failed. Retry or resume' },
  ])('explains the download failure without exposing raw details: $message', async ({ failure, message }) => {
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [] });
    vi.mocked(downloadRepository).mockRejectedValueOnce(failure);
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click');
    await flushPromises();
    const alert = wrapper.get('[role="alert"]').text();
    expect(alert).toContain(message);
    expect(alert).not.toContain('private source path');
    if (failure instanceof DownloadConflictError) {
      expect(alert).not.toContain('Retry or resume');
    }
  });

  it('keeps pending files when deletion confirmation is cancelled and refreshes a changed plan', async () => {
    vi.mocked(listPendingDownloads).mockResolvedValue([{ version: 1, selection, bytes: [48], complete: [false] }]);
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="dialog-cancel-button"]').trigger('click');
    await flushPromises();
    expect(cancelDownload).not.toHaveBeenCalled();
    vi.mocked(cancelDownload).mockResolvedValueOnce('changed');
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click');
    await flushPromises();
    expect(prepareRepositoryRemoval).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[role="alert"]').text()).toContain('Deletion stopped because the files changed');
    expect(listPendingDownloads).toHaveBeenCalledTimes(2);
  });

  it.each(['complete', 'pause', 'unmount'] as const)('updates remaining time independently of events and disposes its clock on %s', async ending => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    vi.mocked(listPendingDownloads).mockResolvedValue([{ version: 1, selection, bytes: [64], complete: [false] }]);
    const gate = Promise.withResolvers<void>();
    let report: Parameters<typeof downloadRepository>[0]['onProgress'] | undefined;
    vi.mocked(downloadRepository).mockImplementation(({ signal, onProgress }) => {
      report = onProgress;
      onProgress({ progress: { completed: 64, total: 128, processed: 0, phase: 'transferring' } });
      signal.addEventListener('abort', () => gate.reject(new DOMException('paused', 'AbortError')), { once: true });
      return gate.promise;
    });
    const wrapper = render();
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-resume"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('Estimating remaining time…');
    for (let tick = 1; tick <= 3; tick++) {
      report!({ progress: { completed: 64 + tick * 10, total: 128, processed: tick * 10, phase: 'transferring' } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('About 5 seconds remaining');
    report!({ progress: { completed: 94, total: 36104, processed: 30, phase: 'transferring' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('About 1 h 10 min remaining');
    await vi.advanceTimersByTimeAsync(10000);
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('Estimating remaining time…');
    report!({ progress: { completed: 128, total: 128, processed: 64, phase: 'verifying' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('Performing final checks…');
    expect(vi.getTimerCount()).toBe(1);
    switch (ending) {
    case 'complete': gate.resolve();
      break;
    case 'pause': await wrapper.get('[data-testid="llama-download-pause"]').trigger('click');
      break;
    case 'unmount': wrapper.unmount();
      wrappers.splice(wrappers.indexOf(wrapper), 1);
      break;
    default: {
      const exhaustive: never = ending;
      throw new Error(String(exhaustive));
    }
    }
    await flushPromises();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores pending downloads on mount and supports resume, pause and cancel-delete', async () => {
    vi.mocked(listPendingDownloads).mockResolvedValue([{ version: 1, selection, bytes: [48], complete: [false] }]);
    vi.mocked(downloadRepository).mockImplementation(({ signal, onProgress }) => {
      onProgress({ progress: { completed: 64, total: 128, processed: 16, phase: 'transferring' } });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-pending"]').text()).toContain('hf.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-resume"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-download-progress"]').text()).toContain('50%');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
    await wrapper.get('[data-testid="llama-download-pause"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-delete-details"]').text()).toContain('model-Q4_K_M.gguf');
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click');
    await flushPromises();
    expect(cancelDownload).toHaveBeenCalledWith({ repository: 'owner/repo', plan, destination: { kind: 'opfs' } });
  });
});
