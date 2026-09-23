import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { audioModelCatalog } from '@/features/audio-generation/model-catalog';
import { discoverRepository, groupModelFiles, parseRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { downloadRepository } from '@/features/llama-cpp-browser/hugging-face/download';
import { TEST_ONLY as metadataTest } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { getDownloadQueue, TEST_ONLY as queueTest } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import LlamaCppBrowserManager from './LlamaCppBrowserManager.vue';
import LlamaCppBrowserRepositoryCatalog from './LlamaCppBrowserRepositoryCatalog.vue';
const service = vi.hoisted(() => ({
  getState: vi.fn<LlamaCppBrowserService['getState']>(() => ({ status: 'idle' })),
  getOptions: vi.fn<LlamaCppBrowserService['getOptions']>(() => ({ profile: 'auto' })),
  getProfileState: vi.fn<LlamaCppBrowserService['getProfileState']>(() => ({ status: 'idle' })),
  subscribe: vi.fn(() => () => {}), subscribeModelList: vi.fn(() => () => {}), subscribeProfiles: vi.fn(() => () => {}),
  listModels: vi.fn(async () => []), probeProfiles: vi.fn(async () => ({ profiles: [] })), release: vi.fn(),
}));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
vi.mock('../hugging-face/catalog', async original => ({ ...await original<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), discoverRepository: vi.fn() }));
vi.mock('../hugging-face/download', () => ({ downloadRepository: vi.fn(), cancelDownload: vi.fn() }));
vi.mock('../hugging-face/storage', () => ({ listPendingDownloads: vi.fn(async () => []), installedSelection: vi.fn(async () => undefined) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn() }) }));
let wrapper: VueWrapper | undefined;
const revision = 'a'.repeat(40);
const families = [
  { name: 'Qwen3-TTS-12Hz-0.6B-Base', projector: 'Qwen3-TTS-12Hz-0.6B-Base.mmproj-Q8_0.gguf' },
  { name: 'Qwen3-TTS-12Hz-1.7B-Base', projector: 'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf' },
] as const;
function render(): VueWrapper {
  wrapper = mount(LlamaCppBrowserManager, {
    props: { suggestions: 'none' },
    slots: { catalog: ({ disabled, inspect }: { disabled: boolean, inspect: ({ input }: { input: string }) => Promise<void> }) =>
      h(LlamaCppBrowserRepositoryCatalog, { entries: audioModelCatalog, disabled, onInspect: input => {
        void inspect({ input });
      } }) },
  });
  return wrapper;
}
beforeEach(async () => {
  vi.clearAllMocks(); queueTest.reset(); metadataTest.reset(); await ensureAllStringsForTest({ locale: 'en' });
  vi.mocked(discoverRepository).mockImplementation(async ({ input }) => {
    const { repository } = parseRepository({ input });
    const family = repository.startsWith('mradermacher/') ? families[0] : families[1];
    const files = [`${family.name}.Q4_K_M.gguf`, `${family.name}.Q8_0.gguf`, family.projector]
      .map(path => ({ path, size: 128 }));
    return { repository, revision, ...groupModelFiles({ files }) };
  });
  vi.mocked(downloadRepository).mockResolvedValue();
});
afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined;
  for (const job of getDownloadQueue().jobs.value) getDownloadQueue().cancel({ id: job.id });
  await flushPromises(); vi.restoreAllMocks();
});
describe('reusable repository catalog and shared model manager', () => {
  it('renders the two user-selected sources without contacting Hugging Face', async () => {
    const view = render(); await flushPromises();
    const rows = view.findAll('[data-testid="llama-repository-catalog-entry"]');
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.get('a').attributes('href'))).toEqual(audioModelCatalog.map(entry => entry.url));
    expect(discoverRepository).not.toHaveBeenCalled(); expect(downloadRepository).not.toHaveBeenCalled();
    expect(view.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(true);
    expect(view.find('[data-testid="llama-cpp-browser-profile"]').exists()).toBe(true);
  });
  it.each([0, 1])('prepares source %i through the shared inspector and includes its companion only on explicit download', async index => {
    const view = render(); await flushPromises();
    await view.findAll('[data-testid="llama-repository-catalog-inspect"]')[index]!.trigger('click'); await flushPromises();
    expect(discoverRepository).toHaveBeenCalledWith(expect.objectContaining({ input: audioModelCatalog[index]!.input }));
    expect(view.get<HTMLInputElement>('[data-testid="llama-hf-repository"]').element.value).toBe(audioModelCatalog[index]!.input);
    expect(view.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toContain('Q4_K_M');
    expect(view.get<HTMLSelectElement>('[data-testid="llama-hf-projector"]').element.value).toBe(families[index]!.projector);
    expect(downloadRepository).not.toHaveBeenCalled();
    await view.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    expect(downloadRepository).toHaveBeenCalledOnce();
    expect(vi.mocked(downloadRepository).mock.calls[0]![0].selection).toEqual({
      repository: parseRepository({ input: audioModelCatalog[index]!.input }).repository, revision,
      files: [{ path: `${families[index]!.name}.Q4_K_M.gguf`, size: 128 }, { path: families[index]!.projector, size: 128 }],
    });
  });
  it('does not replace an in-flight inspection when another catalog button is pressed', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof discoverRepository>>>();
    vi.mocked(discoverRepository).mockReturnValueOnce(gate.promise);
    const view = render(); await flushPromises();
    await view.findAll('[data-testid="llama-repository-catalog-inspect"]')[0]!.trigger('click');
    await flushPromises();
    expect(view.findAll('[data-testid="llama-repository-catalog-inspect"]')[1]!.attributes('disabled')).toBeDefined();
    await view.findAll('[data-testid="llama-repository-catalog-inspect"]')[1]!.trigger('click');
    expect(discoverRepository).toHaveBeenCalledOnce();
    gate.resolve({ repository: 'mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF', revision, models: [], projectors: [] }); await flushPromises();
    expect(downloadRepository).not.toHaveBeenCalled();
  });
});
