import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { discoverRepository, groupModelFiles, type RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { downloadRepository } from '@/features/llama-cpp-browser/hugging-face/download';
import { installedSelection, repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import { getDownloadQueue, TEST_ONLY as queueTest } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { TEST_ONLY as metadataTest } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { modelSuggestions, type ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import LlamaCppBrowserModelSuggestion from './LlamaCppBrowserModelSuggestion.vue';

vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), discoverRepository: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download', () => ({ downloadRepository: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ installedSelection: vi.fn(), repositoryDirectories: vi.fn() }));

const gemma = modelSuggestions.find(suggestion => suggestion.id === 'gemma-4-e2b')!;
const official = gemma.quantizationHints.find(choice => choice.checkpoint === 'qat')!;
const community = gemma.quantizationHints.find(choice => choice.id === 'q4_k_m')!;
const qatPath = 'gemma-4-E2B_q4_0-it.gguf';
const qatProjector = 'gemma-4-E2B-it-mmproj.gguf';
const communityProjector = 'mmproj-community-gemma-4-E2B-it-F16.gguf';
const revision = 'a'.repeat(40);
const otherRevision = 'b'.repeat(40);
const officialCatalog: RepositoryCatalog = {
  repository: official.repository, revision,
  ...groupModelFiles({ files: [{ path: qatPath, size: 128 }, { path: qatProjector, size: 96 }] }),
};
const communityCatalog: RepositoryCatalog = {
  repository: community.repository, revision: otherRevision,
  ...groupModelFiles({ files: [
    { path: 'gemma-4-E2B-it-Q4_K_M.gguf', size: 144 },
    { path: 'gemma-4-E2B-it-Q6_K.gguf', size: 160 },
    { path: 'gemma-4-E2B-it-Q8_0.gguf', size: 192 },
    { path: 'dflash-gemma-4-E2B-it-Q8_0.gguf', size: 64 },
    { path: communityProjector, size: 112 },
  ] }),
};
const localQat: LocalModel = { id: `hf.co/${official.repository}:${encodeURIComponent(qatPath)}`, name: `hf.co/${official.repository}:${qatPath}`, size: 128, importedAt: 1 };
const localCommunity: LocalModel = { id: `hf.co/${community.repository}:gemma-4-E2B-it-Q4_K_M.gguf`, name: `hf.co/${community.repository}:Q4_K_M`, size: 144, importedAt: 1 };
const wrappers: VueWrapper[] = [];

function render({ suggestion, models }: { suggestion: ModelSuggestion, models: LocalModel[] }): VueWrapper {
  const wrapper = mount(LlamaCppBrowserModelSuggestion, { props: { suggestion, models, disabled: false, defaultModel: { endpoint: { type: 'llama_cpp_browser' }, modelId: undefined }, defaultActionDisabled: false } });
  wrappers.push(wrapper); return wrapper;
}
function unrender({ wrapper }: { wrapper: VueWrapper }): void {
  wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
}
function selected({ wrapper }: { wrapper: VueWrapper }): string {
  return wrapper.get<HTMLSelectElement>('[data-testid="llama-suggestion-quantization"]').element.value;
}
async function forceSelectionChange({ wrapper, value }: { wrapper: VueWrapper, value: string }): Promise<void> {
  // Test Utils suppresses trigger() on disabled elements; dispatch directly to
  // exercise the handler's guard against synthetic changes to a frozen intent.
  const select = wrapper.get<HTMLSelectElement>('select').element;
  select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}
function holdDownloadUntilPaused(): void {
  vi.mocked(downloadRepository).mockImplementationOnce(({ signal }) => new Promise<void>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true });
  }));
}
beforeEach(async () => {
  vi.resetAllMocks(); queueTest.reset(); metadataTest.reset();
  vi.mocked(installedSelection).mockResolvedValue(undefined);
  vi.mocked(repositoryDirectories).mockResolvedValue([]);
  vi.mocked(discoverRepository).mockImplementation(async ({ input }) => {
    if (input === official.repository) return officialCatalog;
    if (input === community.repository) return communityCatalog;
    throw new Error(`Unexpected metadata source: ${input}`);
  });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  for (const job of getDownloadQueue().jobs.value) getDownloadQueue().cancel({ id: job.id });
  await flushPromises();
});

describe('catalog quantization selection', () => {
  it('places a labelled static selector next to the model name, with QAT preferred and no network on changes', async () => {
    const wrapper = render({ suggestion: gemma, models: [] }); await flushPromises();
    const title = wrapper.get('[data-testid="llama-suggestion-title-options"]');
    const select = title.get('[data-testid="llama-suggestion-quantization"]');
    expect(title.get('h4').text()).toBe('Gemma 4 E2B it');
    expect(select.attributes('aria-labelledby')?.split(' ')).toContain(title.get('h4').attributes('id'));
    expect(title.get('label').text()).toBe('Quantization');
    expect(select.findAll('option').map(option => option.text())).toEqual(['Q4_0 (QAT)', 'Q4_K_M', 'Q6_K', 'Q8_0']);
    expect(selected({ wrapper })).toBe('qat-q4_0');
    const initialSize = wrapper.get('[data-testid="llama-suggestion-metadata"] p').text();
    await select.setValue('q8_0'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-suggestion-repository"]').attributes('href')).toBe(`https://huggingface.co/${community.repository}`);
    expect(wrapper.get('[data-testid="llama-suggestion-metadata"] p').text()).not.toBe(initialSize);
    await wrapper.get('[data-testid="llama-suggestion-details-toggle"]').trigger('click');
    await wrapper.get('[data-testid="llama-suggestion-multimodal"]').trigger('click');
    await select.setValue('q6_k'); await flushPromises();
    expect(discoverRepository).not.toHaveBeenCalled(); expect(downloadRepository).not.toHaveBeenCalled();
    expect(wrapper.emitted('selectDefault')).toBeUndefined();
  });

  it('keeps the one valid gpt-oss choice visible without listing auxiliary model quantizations', async () => {
    const wrapper = render({ suggestion: modelSuggestions.find(suggestion => suggestion.id === 'gpt-oss-20b')!, models: [] });
    await flushPromises();
    expect(wrapper.get('select').attributes('disabled')).toBeDefined();
    expect(wrapper.get('select').findAll('option').map(option => option.text())).toEqual(['MXFP4']);
    expect(wrapper.find('[data-testid="llama-suggestion-multimodal"]').exists()).toBe(false);
    expect(discoverRepository).not.toHaveBeenCalled();
  });

  it('isolates source snapshots, locally recomputes same-source selections and uses only the selected projector', async () => {
    const wrapper = render({ suggestion: gemma, models: [] }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-details-toggle"]').trigger('click');
    await wrapper.get('[data-testid="llama-suggestion-check"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-download-plan-files"]').text()).toContain(qatPath);
    await wrapper.get('select').setValue('q4_k_m'); await flushPromises();
    expect(wrapper.find('[data-testid="llama-download-plan-files"]').exists()).toBe(false);
    expect(discoverRepository).toHaveBeenCalledOnce();
    await wrapper.get('[data-testid="llama-suggestion-check"]').trigger('click'); await flushPromises();
    expect(discoverRepository).toHaveBeenCalledTimes(2);
    await wrapper.get('[data-testid="llama-suggestion-multimodal"]').trigger('click');
    await wrapper.get('select').setValue('q6_k'); await flushPromises();
    const files = wrapper.get('[data-testid="llama-download-plan-files"]');
    expect(files.text()).toContain('gemma-4-E2B-it-Q6_K.gguf');
    expect(files.text()).toContain(communityProjector);
    expect(files.text()).not.toContain(qatProjector);
    expect(files.findAll('a').every(link => link.attributes('href')?.includes(`/${community.repository}/resolve/${otherRevision}/`))).toBe(true);
    expect(discoverRepository).toHaveBeenCalledTimes(2);
    await wrapper.get('select').setValue('qat-q4_0'); await flushPromises();
    const originalFiles = wrapper.get('[data-testid="llama-download-plan-files"]');
    expect(originalFiles.text()).toContain(qatPath); expect(originalFiles.text()).toContain(qatProjector);
    expect(originalFiles.text()).not.toContain(communityProjector);
    expect(discoverRepository).toHaveBeenCalledTimes(2);
  });

  it('allows disabling multimodal when the chosen source no longer has the hinted projector', async () => {
    vi.mocked(discoverRepository).mockResolvedValueOnce({ repository: community.repository, revision, ...groupModelFiles({ files: [{ path: 'gemma-4-E2B-it-Q4_K_M.gguf', size: 128 }] }) });
    const wrapper = render({ suggestion: gemma, models: [] }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-multimodal"]').trigger('click');
    await wrapper.get('select').setValue('q4_k_m');
    await wrapper.get('[data-testid="llama-suggestion-check"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[data-testid="llama-download-plan-files"]').exists()).toBe(false);
    const toggle = wrapper.get('[data-testid="llama-suggestion-multimodal"]');
    expect(toggle.attributes('aria-checked')).toBe('true');
    expect(toggle.attributes('disabled')).toBeUndefined();
    await toggle.trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-download-plan-files"]').text()).toContain('gemma-4-E2B-it-Q4_K_M.gguf');
    expect(toggle.attributes('aria-checked')).toBe('false');
    expect(toggle.attributes('disabled')).toBeDefined();
    expect(discoverRepository).toHaveBeenCalledOnce();
  });

  it('downloads the explicitly selected community quantization directly and pins the plan on remount and resume', async () => {
    holdDownloadUntilPaused();
    const wrapper = render({ suggestion: gemma, models: [] }); await flushPromises();
    await wrapper.get('select').setValue('q8_0');
    await wrapper.get('[data-testid="llama-suggestion-multimodal"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    const first = vi.mocked(downloadRepository).mock.calls[0]![0];
    expect(first.selection.repository).toBe(community.repository);
    expect(first.selection.revision).toBe(otherRevision);
    expect(first.selection.files.map(file => file.path)).toEqual(['gemma-4-E2B-it-Q8_0.gguf', communityProjector]);
    expect(wrapper.get('select').attributes('disabled')).toBeDefined();
    // A synthetic change must not mutate the submitted intent either.
    await forceSelectionChange({ wrapper, value: 'qat-q4_0' });
    expect(selected({ wrapper })).toBe('q8_0');
    unrender({ wrapper });
    expect(first.signal.aborted).toBe(false);
    const again = render({ suggestion: gemma, models: [] }); await flushPromises();
    expect(selected({ wrapper: again })).toBe('q8_0');
    expect(again.get('[data-testid="llama-suggestion-multimodal"]').attributes('aria-checked')).toBe('true');
    await again.get('[data-testid="llama-download-pause"]').trigger('click'); await flushPromises();
    expect(getDownloadQueue().jobs.value[0]?.status).toBe('paused');
    expect(again.get('select').attributes('disabled')).toBeDefined();
    unrender({ wrapper: again });
    const paused = render({ suggestion: gemma, models: [] }); await flushPromises();
    expect(selected({ wrapper: paused })).toBe('q8_0');
    await paused.get('[data-testid="llama-download-resume"]').trigger('click'); await flushPromises();
    expect(vi.mocked(downloadRepository).mock.calls[1]![0].selection).toEqual(first.selection);
    expect(discoverRepository).toHaveBeenCalledOnce();
    expect(paused.get('select').attributes('disabled')).toBeUndefined();
    // A terminal Q8 job must not become the Q4 plan when the user changes options.
    await paused.get('select').setValue('q4_k_m'); await flushPromises();
    expect(paused.find('[data-testid="llama-download-plan-files"]').exists()).toBe(false);
    expect(paused.find('[data-testid="llama-download-job"]').exists()).toBe(false);
  });

  it('queues immutable selections without metadata fan-out and unlocks them after waiting cancellation', async () => {
    holdDownloadUntilPaused();
    const running = render({ suggestion: gemma, models: [] }); await flushPromises();
    await running.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    const waiting = render({ suggestion: modelSuggestions.find(suggestion => suggestion.id === 'lfm-2-5-230m')!, models: [] }); await flushPromises();
    await waiting.get('select').setValue('q6_k'); await flushPromises();
    await waiting.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    expect(getDownloadQueue().jobs.value[1]?.status).toBe('queued');
    expect(waiting.get('select').attributes('disabled')).toBeDefined();
    await forceSelectionChange({ wrapper: waiting, value: 'q8_0' });
    expect(selected({ wrapper: waiting })).toBe('q6_k');
    await waiting.get('[data-testid="llama-download-cancel"]').trigger('click'); await flushPromises();
    expect(waiting.get('select').attributes('disabled')).toBeUndefined();
    await waiting.get('select').setValue('q8_0'); await flushPromises();
    expect(selected({ wrapper: waiting })).toBe('q8_0');
    expect(discoverRepository).toHaveBeenCalledOnce();
    expect(downloadRepository).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'ambiguous'] as const)('does not guess a fallback source or quantization when the requested choice is %s', async problem => {
    const files = [{ path: 'gemma-4-E2B-it-Q4_K_M.gguf', size: 128 }];
    if (problem === 'ambiguous') files.push({ path: 'one-Q8_0.gguf', size: 192 }, { path: 'two-Q8_0.gguf', size: 192 });
    vi.mocked(discoverRepository).mockResolvedValueOnce({ repository: community.repository, revision, ...groupModelFiles({ files }) });
    const wrapper = render({ suggestion: gemma, models: [] }); await flushPromises();
    await wrapper.get('select').setValue('q8_0'); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    expect(getDownloadQueue().jobs.value[0]?.error).toBe('selection-unavailable');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(selected({ wrapper })).toBe('q8_0');
    expect(downloadRepository).not.toHaveBeenCalled(); expect(discoverRepository).toHaveBeenCalledOnce();
    expect(vi.mocked(discoverRepository).mock.calls[0]?.[0].input).toBe(community.repository);
    await wrapper.get('select').setValue('qat-q4_0'); await flushPromises();
    expect(wrapper.find('[data-testid="llama-download-job"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-suggestion-download"]').exists()).toBe(true);
    expect(discoverRepository).toHaveBeenCalledOnce();
  });

  it('shows and emits only the exact installed source/quantization, without changing defaults on selection', async () => {
    const wrapper = render({ suggestion: gemma, models: [localCommunity] }); await flushPromises();
    expect(wrapper.find('[data-testid="llama-default-model-action"]').exists()).toBe(false);
    await wrapper.get('select').setValue('q4_k_m'); await flushPromises();
    expect(wrapper.find('[data-testid="llama-default-model-action"]').exists()).toBe(true);
    expect(wrapper.emitted('selectDefault')).toBeUndefined();
    await wrapper.get('[data-testid="llama-default-model-action"]').trigger('click');
    expect(wrapper.emitted('selectDefault')).toEqual([[localCommunity]]);
    await wrapper.setProps({ models: [localQat, localCommunity], defaultModel: { endpoint: { type: 'llama_cpp_browser' }, modelId: localQat.name } });
    await wrapper.get('select').setValue('qat-q4_0'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-default-model-action"]').text()).toBe('In use');
    await wrapper.get('select').setValue('q8_0'); await flushPromises();
    expect(wrapper.find('[data-testid="llama-default-model-action"]').exists()).toBe(false);
    expect(discoverRepository).not.toHaveBeenCalled(); expect(downloadRepository).not.toHaveBeenCalled();
  });

  it('ignores an old asynchronous local check after switching source', async () => {
    const pendingLocal = Promise.withResolvers<LocalModel | undefined>();
    vi.mocked(installedSelection).mockReturnValueOnce(pendingLocal.promise);
    const wrapper = render({ suggestion: gemma, models: [] }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-check"]').trigger('click'); await flushPromises();
    expect(installedSelection).toHaveBeenCalledOnce();
    await wrapper.get('select').setValue('q4_k_m'); await flushPromises();
    pendingLocal.resolve(localQat); await flushPromises();
    expect(wrapper.find('[data-testid="llama-default-model-action"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-suggestion-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="llama-download-plan-files"]').exists()).toBe(false);
  });

  it('locks source changes during inspection and honors the shared disabled state', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>();
    vi.mocked(discoverRepository).mockReturnValueOnce(pending.promise);
    const wrapper = render({ suggestion: gemma, models: [] }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-check"]').trigger('click'); await flushPromises();
    expect(wrapper.get('select').attributes('disabled')).toBeDefined();
    await forceSelectionChange({ wrapper, value: 'q8_0' });
    expect(selected({ wrapper })).toBe('qat-q4_0');
    pending.resolve(officialCatalog); await flushPromises();
    expect(wrapper.get('select').attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ disabled: true });
    await forceSelectionChange({ wrapper, value: 'q8_0' });
    await wrapper.get('[data-testid="llama-suggestion-check"]').trigger('click');
    await wrapper.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    expect(selected({ wrapper })).toBe('qat-q4_0');
    expect(discoverRepository).toHaveBeenCalledOnce(); expect(downloadRepository).not.toHaveBeenCalled();
  });
});
