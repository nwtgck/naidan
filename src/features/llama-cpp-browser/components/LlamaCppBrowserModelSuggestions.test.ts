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
function render({ models }: { models: LocalModel[] }): VueWrapper {
  const wrapper = mount(LlamaCppBrowserModelSuggestions, { props: { models, disabled: false, defaultModel: { endpoint: { type: 'llama_cpp_browser' }, modelId: undefined }, defaultActionDisabled: false } });
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
    const wrapper = render({ models: [] }); await flushPromises();
    expect(wrapper.get('[data-testid="llama-suggestions-toggle"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="llama-suggestions-memory"]').findAll('button')).toHaveLength(4);
    await wrapper.get('[data-testid="llama-suggestions-memory-8"]').trigger('click');
    expect(wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]').isVisible()).toBe(false);
    expect(wrapper.get('[data-testid="llama-suggestion-lfm-2-5-230m"]').isVisible()).toBe(true);
    await wrapper.get('[data-testid="llama-suggestions-memory-all"]').trigger('click');
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    expect(row.get('[role="switch"]').attributes('aria-checked')).toBe('false');
    await row.get('[data-testid="llama-suggestion-details-toggle"]').trigger('click'); await row.get('[role="switch"]').trigger('click'); await flushPromises();
    expect(row.get('[role="switch"]').attributes('aria-checked')).toBe('true');
    await wrapper.get('[data-testid="llama-suggestions-toggle"]').trigger('click');
    expect(discoverRepository).not.toHaveBeenCalled(); expect(downloadRepository).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="llama-suggestions-find-more"]').attributes('href')).toBe('https://huggingface.co/models?library=gguf');
  });
  it('starts open for new and returning users without letting local updates override manual folding', async () => {
    const wrapper = render({ models: [] });
    const toggle = wrapper.get('[data-testid="llama-suggestions-toggle"]');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    await flushPromises();
    await wrapper.setProps({ models: [local] });
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const existing = render({ models: [local] }); await flushPromises();
    expect(existing.get('[data-testid="llama-suggestions-toggle"]').attributes('aria-expanded')).toBe('true');
    await toggle.trigger('click');
    const content = wrapper.get(`[id="${toggle.attributes('aria-controls')}"]`);
    expect(content.attributes('aria-hidden')).toBe('true');
    expect(content.attributes('inert')).toBeDefined();
    await wrapper.setProps({ models: [] });
    await wrapper.setProps({ models: [local] });
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(content.attributes('inert')).toBeUndefined();
    expect(discoverRepository).not.toHaveBeenCalled();
  });
  it('keeps details next to options, uniquely labelled, initially inert and separate from the repository action', async () => {
    const wrapper = render({ models: [] }); await flushPromises();
    const toggles = wrapper.findAll('[data-testid="llama-suggestion-details-toggle"]');
    expect(toggles).toHaveLength(modelSuggestions.length);
    expect(new Set(toggles.map(toggle => toggle.attributes('aria-controls'))).size).toBe(modelSuggestions.length);
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    const options = row.get('[data-testid="llama-suggestion-options"]');
    expect(options.find('[data-testid="llama-suggestion-multimodal"]').exists()).toBe(true);
    const toggle = options.get('[data-testid="llama-suggestion-details-toggle"]');
    const details = row.get('[data-testid="llama-suggestion-details"]');
    expect(toggle.attributes('aria-controls')).toBe(details.attributes('id'));
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(details.attributes('aria-hidden')).toBe('true');
    expect(details.attributes('inert')).toBeDefined();
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(details.attributes('aria-hidden')).toBe('false');
    expect(details.attributes('inert')).toBeUndefined();
    const repositoryRow = details.get('[data-testid="llama-suggestion-repository-row"]');
    const toolbar = details.get('[data-testid="llama-suggestion-plan-toolbar"]');
    expect(repositoryRow.get('[data-testid="llama-suggestion-repository"]').attributes('href')).toBe(`https://huggingface.co/${muse.repository}`);
    expect(repositoryRow.find('[data-testid="llama-suggestion-check"]').exists()).toBe(false);
    expect(toolbar.find('[data-testid="llama-suggestion-repository"]').exists()).toBe(false);
    await toggle.trigger('click');
    expect(details.attributes('inert')).toBeDefined();
    expect(discoverRepository).not.toHaveBeenCalled();
    expect(downloadRepository).not.toHaveBeenCalled();
  });
  it.each([
    { locale: 'en', title: 'Model catalog', more: 'Browse more models', contents: 'Download contents', check: 'Check contents' },
    { locale: 'ja', title: 'モデルカタログ', more: 'ほかのモデルを探す', contents: 'ダウンロード内容', check: '内容を確認' },
    { locale: 'de', title: 'Modellkatalog', more: 'Weitere Modelle entdecken', contents: 'Download-Inhalt', check: 'Inhalt prüfen' },
    { locale: 'es', title: 'Catálogo de modelos', more: 'Explorar más modelos', contents: 'Archivos de descarga', check: 'Ver archivos' },
    { locale: 'ko', title: '모델 카탈로그', more: '다른 모델 찾아보기', contents: '다운로드 내용', check: '내용 확인' },
    { locale: 'pt-BR', title: 'Catálogo de modelos', more: 'Explorar mais modelos', contents: 'Conteúdo do download', check: 'Conferir arquivos' },
    { locale: 'zh-Hans', title: '模型目录', more: '浏览更多模型', contents: '下载内容', check: '查看内容' },
  ] as const)('localizes the catalog and discovery actions in $locale', async ({ locale, title, more, contents, check }) => {
    await ensureAllStringsForTest({ locale });
    const wrapper = render({ models: [] }); await flushPromises();
    expect(wrapper.get('[data-testid="llama-suggestions-toggle"]').text()).toBe(title);
    const link = wrapper.get('[data-testid="llama-suggestions-find-more"]');
    expect(link.text()).toBe(more);
    expect(link.attributes('href')).toBe('https://huggingface.co/models?library=gguf');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    await row.get('[data-testid="llama-suggestion-details-toggle"]').trigger('click');
    const toolbar = row.get('[data-testid="llama-suggestion-plan-toolbar"]');
    expect(toolbar.text()).toContain(contents);
    expect(toolbar.get('[data-testid="llama-suggestion-check"]').text()).toBe(check);
    expect(discoverRepository).not.toHaveBeenCalled();
  });
  it('shows a pinned file plan only after explicit inspection and recalculates multimodal locally', async () => {
    const wrapper = render({ models: [] }); await flushPromises();
    const row = wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"]');
    expect(row.find('[data-testid="llama-download-plan-files"]').exists()).toBe(false);
    await row.get('[data-testid="llama-suggestion-details-toggle"]').trigger('click');
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
    await row.get('[data-testid="llama-suggestion-details-toggle"]').trigger('click');
    expect(row.get('[data-testid="llama-suggestion-details"]').attributes('inert')).toBeDefined();
    await row.get('[data-testid="llama-suggestion-details-toggle"]').trigger('click');
    expect(row.get('[data-testid="llama-download-plan-files"]').text()).toContain(projector);
    expect(row.get('[data-testid="llama-suggestion-check"]').text()).toBe('Refresh contents');
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
    const wrapper = render({ models: [] }); await flushPromises();
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
    const wrapper = render({ models: [] }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-muse-glimmer-30b"] [data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(signal?.aborted).toBe(false);
    const again = render({ models: [] }); await flushPromises();
    expect(again.find('[data-testid="llama-suggestion-muse-glimmer-30b"] [data-testid="llama-download-pause"]').exists()).toBe(true);
    expect(discoverRepository).toHaveBeenCalledOnce();
    gate.resolve(); await flushPromises();
  });
  it('uses exact local quantization state and changes the action instead of re-downloading', async () => {
    const wrapper = render({ models: [local] }); await flushPromises();
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
