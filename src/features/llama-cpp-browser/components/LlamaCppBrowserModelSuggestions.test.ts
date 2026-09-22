import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { discoverRepository, groupModelFiles } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { downloadRepository } from '@/features/llama-cpp-browser/hugging-face/download';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { getDownloadQueue, TEST_ONLY as queueTest } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { TEST_ONLY as metadataTest } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { modelSuggestions } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserModelSuggestions from './LlamaCppBrowserModelSuggestions.vue';
vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), discoverRepository: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download', () => ({ downloadRepository: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ installedSelection: vi.fn(), repositoryDirectories: vi.fn(async () => []) }));
const muse = modelSuggestions.find(entry => entry.id === 'muse-glimmer-30b')!;
const main = 'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf';
const projector = 'mmproj-Muse-Glimmer-30B-Q4_K_M.gguf';
const local: LocalModel = { id: `hf.co/${muse.repository}:${encodeURIComponent(main)}`, name: `hf.co/${muse.repository}:KQuant-17GB-Q4_K_M`, size: 128, importedAt: 1 };
const revision = 'a'.repeat(40);
const wrappers: VueWrapper[] = [];
function render({ models, modelsReady }: { models: LocalModel[], modelsReady: boolean }): VueWrapper {
  const wrapper = mount(LlamaCppBrowserModelSuggestions, { props: { models, modelsReady, disabled: false, defaultModel: { endpoint: { type: 'llama_cpp_browser' }, modelId: undefined }, defaultActionDisabled: false } });
  wrappers.push(wrapper); return wrapper;
}
beforeEach(async () => {
  vi.resetAllMocks(); queueTest.reset(); metadataTest.reset();
  vi.mocked(installedSelection).mockResolvedValue(undefined);
  vi.mocked(discoverRepository).mockResolvedValue({ repository: muse.repository, revision, ...groupModelFiles({ files: [main, projector, 'dflash-Q4_K_M.gguf'].map(path => ({ path, size: 128 })) }) });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  for (const job of getDownloadQueue().jobs.value) getDownloadQueue().cancel({ id: job.id });
  await flushPromises(); vi.useRealTimers();
});
describe('offline-first suggested model UI', () => {
  it('does not contact repositories on mount, expansion, filtering, details or multimodal toggles', async () => {
    const wrapper = render({ models: [], modelsReady: false }); await flushPromises();
    expect(wrapper.get('[data-testid="llama-suggestions-toggle"]').attributes('aria-expanded')).toBe('false');
    await wrapper.setProps({ modelsReady: true });
    expect(wrapper.get('[data-testid="llama-suggestions-toggle"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="llama-suggestions-memory"]').findAll('button')).toHaveLength(4);
    await wrapper.get('[data-testid="llama-suggestions-memory-8"]').trigger('click');
    expect(wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]').isVisible()).toBe(false);
    expect(wrapper.get('[data-testid="llama-suggestion-lfm-2-5-230m"]').isVisible()).toBe(true);
    await wrapper.get('[data-testid="llama-suggestions-memory-all"]').trigger('click');
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    expect(row.get('[role="switch"]').attributes('aria-checked')).toBe('false');
    await row.get('summary').trigger('click'); await row.get('[role="switch"]').trigger('click'); await flushPromises();
    expect(row.get('[role="switch"]').attributes('aria-checked')).toBe('true');
    await wrapper.get('[data-testid="llama-suggestions-toggle"]').trigger('click');
    expect(discoverRepository).not.toHaveBeenCalled(); expect(downloadRepository).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="llama-suggestions-find-more"]').attributes('href')).toBe('https://huggingface.co/models?library=gguf');
  });
  it('chooses the initial fold state once without collapsing when the first model is installed', async () => {
    const wrapper = render({ models: [], modelsReady: true }); await flushPromises();
    await wrapper.setProps({ models: [local] });
    expect(wrapper.get('[data-testid="llama-suggestions-toggle"]').attributes('aria-expanded')).toBe('true');
    const existing = render({ models: [local], modelsReady: true }); await flushPromises();
    expect(existing.get('[data-testid="llama-suggestions-toggle"]').attributes('aria-expanded')).toBe('false');
  });
  it('shows a pinned file plan only after explicit inspection and recalculates multimodal locally', async () => {
    const wrapper = render({ models: [], modelsReady: true }); await flushPromises();
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    expect(row.find('[data-testid="llama-download-plan-files"]').exists()).toBe(false);
    await row.get('[data-testid="llama-suggestion-check"]').trigger('click'); await flushPromises();
    expect(discoverRepository).toHaveBeenCalledOnce();
    expect(row.get('[data-testid="llama-download-plan-files"]').text()).toContain(main);
    expect(row.get('[data-testid="llama-download-plan-files"]').text()).not.toContain(projector);
    const link = row.get('[data-testid="llama-download-plan-files"] a');
    expect(link.attributes('href')).toBe(`https://huggingface.co/${muse.repository}/resolve/${revision}/${main}?download=true`);
    expect(link.attributes('download')).toBeDefined();
    await row.get('[role="switch"]').trigger('click'); await flushPromises();
    expect(row.get('[data-testid="llama-download-plan-files"]').text()).toContain(projector);
    expect(discoverRepository).toHaveBeenCalledOnce();
    await row.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    expect(discoverRepository).toHaveBeenCalledOnce();
    expect(vi.mocked(downloadRepository).mock.calls[0]?.[0].selection.files.map(file => file.path)).toEqual([main, projector]);
  });
  it('downloads with one click, defaults to text-only, keeps other rows queueable and cancels waiting work', async () => {
    const gate = Promise.withResolvers<void>();
    vi.mocked(downloadRepository).mockImplementationOnce(async ({ signal, onProgress }) => {
      onProgress({ progress: { total: 128, completed: 64, processed: 64, phase: 'transferring' } });
      await gate.promise; signal.throwIfAborted();
    });
    const wrapper = render({ models: [], modelsReady: true }); await flushPromises();
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    await row.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    expect(vi.mocked(downloadRepository).mock.calls[0]?.[0].selection.files.map(file => file.path)).toEqual([main]);
    expect(row.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
    const small = wrapper.get('[data-testid="llama-suggestion-smollm2-135m"]');
    await small.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    expect(small.text()).toContain('Waiting');
    expect(discoverRepository).toHaveBeenCalledOnce();
    await small.get('[data-testid="llama-download-cancel"]').trigger('click'); await flushPromises();
    expect(small.find('[data-testid="llama-suggestion-download"]').exists()).toBe(true);
    gate.resolve(); await flushPromises();
    expect(downloadRepository).toHaveBeenCalledOnce();
  });
  it('keeps the active request alive across unmount and remount without re-inspecting', async () => {
    const gate = Promise.withResolvers<void>(); let signal: AbortSignal | undefined;
    vi.mocked(downloadRepository).mockImplementationOnce(async request => {
      signal = request.signal; await gate.promise;
    });
    const wrapper = render({ models: [], modelsReady: true }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"] [data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(signal?.aborted).toBe(false);
    const again = render({ models: [], modelsReady: true }); await flushPromises();
    expect(again.find('[data-testid="llama-suggestion-muse-glimmer-30b"] [data-testid="llama-download-pause"]').exists()).toBe(true);
    expect(discoverRepository).toHaveBeenCalledOnce();
    gate.resolve(); await flushPromises();
  });
  it('uses exact local quantization state and changes the action instead of re-downloading', async () => {
    const wrapper = render({ models: [local], modelsReady: true }); await flushPromises();
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    expect(row.find('[data-testid="llama-suggestion-download"]').exists()).toBe(false);
    await row.get('[data-testid="llama-default-model-action"]').trigger('click');
    expect(wrapper.emitted('selectDefault')).toEqual([[local]]);
    await wrapper.setProps({ defaultModel: { endpoint: { type: 'llama_cpp_browser' }, modelId: local.name } });
    expect(row.get('[data-testid="llama-default-model-action"]').text()).toBe('In use');
    expect(row.get('[data-testid="llama-default-model-action"]').attributes('disabled')).toBeDefined();
    await wrapper.setProps({ models: [{ ...local, id: `hf.co/${muse.repository}:model-Q8_0.gguf` }] }); await flushPromises();
    expect(row.find('[data-testid="llama-suggestion-download"]').exists()).toBe(true);
    expect(discoverRepository).not.toHaveBeenCalled();
  });
});
