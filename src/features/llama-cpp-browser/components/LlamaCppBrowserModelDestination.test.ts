import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, ref, type Ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { useSettings } from '@/composables/useSettings';
import { TEST_ONLY as destinationTest } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { getDownloadQueue, TEST_ONLY as queueTest } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { TEST_ONLY as metadataTest } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { downloadRepository } from '@/features/llama-cpp-browser/hugging-face/download';
import { discoverRepository, groupModelFiles } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { modelSuggestions, preferredQuantizationHint } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import type { AuthorizedModelDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import type { HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { hostModelRoot, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import LlamaCppBrowserModelSuggestion from './LlamaCppBrowserModelSuggestion.vue';
import LlamaCppBrowserModelSuggestions from './LlamaCppBrowserModelSuggestions.vue';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';

vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async original => ({ ...await original<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), discoverRepository: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download', () => ({ downloadRepository: vi.fn(), cancelDownload: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ installedSelection: vi.fn(), repositoryDirectories: vi.fn(async () => []), listPendingDownloads: vi.fn(async () => []) }));
vi.mock('@/features/llama-cpp-browser/runtime/model-destination', async original => ({ ...await original<typeof import('@/features/llama-cpp-browser/runtime/model-destination')>(), hostModelRoot: vi.fn(async () => ({ name: 'Models', isSameEntry: async () => true })) }));
let settings: Ref<Settings>;
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings,
    captureExperimentalStorage: () => () => true,
    updateExperimentalForStorage: async ({ isCurrent, updater }: Parameters<ReturnType<typeof useSettings>['updateExperimentalForStorage']>[0]) => {
      if (!isCurrent()) return 'changed';
      settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
      return 'saved';
    },
  }),
}));
vi.mock('@/composables/useHostModelDirectories', () => ({
  useHostModelDirectories: () => {
    const destination = ref('opfs');
    const entries = [{ id: 'root-a', name: 'Models A', access: 'readwrite' as const, error: undefined }, { id: 'root-b', name: 'Models B', access: 'readwrite' as const, error: undefined }];
    return {
      registrations: () => entries,
      refresh: async () => {},
      currentHandle: () => ({ name: 'Models' }),
      downloadDestination: async ({ id }: { id: string }) => id === 'opfs' ? { kind: 'opfs' } : { kind: 'host', directoryId: id },
      hostDownloadDestination: async ({ id }: { id: string }) => ({ kind: 'host', directoryId: id }),
      view: {
        supported: computed(() => true),
        entries: computed(() => entries),
        busy: ref(false),
        destination,
        add: vi.fn(),
        reconnect: vi.fn(),
        remove: vi.fn(),
        selectDestination: ({ id }: { id: string }) => {
          destination.value = id;
        },
      },
    };
  },
}));
const wrappers: VueWrapper[] = [];
const suggestion = modelSuggestions.find(entry => entry.id === 'lfm-2-5-230m')!;
const quantization = preferredQuantizationHint({ suggestion });
const catalog = { repository: quantization.repository, revision: 'a'.repeat(40), ...groupModelFiles({ files: [{ path: `model-${quantization.preferredQuantization}.gguf`, size: 128 }] }) };

function renderRow({ authorize }: { authorize: ({ destination }: { destination: ModelDestination }) => Promise<AuthorizedModelDestination> }) {
  const wrapper = mount(LlamaCppBrowserModelSuggestion, { props: { suggestion, models: [], disabled: false, defaultModel: undefined, defaultActionDisabled: false, destination: { kind: 'host', directoryId: 'root-a' }, authorizeDestination: authorize } });
  wrappers.push(wrapper); return wrapper;
}

beforeEach(async () => {
  vi.clearAllMocks(); queueTest.reset(); metadataTest.reset(); destinationTest.reset();
  settings = ref({ ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: '' }, storageType: 'local' });
  vi.mocked(hostModelRoot).mockResolvedValue({ name: 'Models', isSameEntry: async () => true } as unknown as HostModelDirectoryHandle);
  vi.mocked(installedSelection).mockResolvedValue(undefined); vi.mocked(discoverRepository).mockResolvedValue(catalog);
  vi.mocked(downloadRepository).mockResolvedValue(); await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  for (const job of getDownloadQueue().jobs.value) getDownloadQueue().cancel({ id: job.id });
  await flushPromises();
});

describe('destination-bound model downloads', () => {
  it('captures the host root before permission yields and does not fall back to a later selection', async () => {
    const permission = Promise.withResolvers<AuthorizedModelDestination>();
    const expectedRoot = { name: 'Original folder' } as FileSystemDirectoryHandle;
    const enqueue = vi.spyOn(getDownloadQueue(), 'enqueue');
    const authorize = vi.fn(() => permission.promise);
    const wrapper = renderRow({ authorize }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-download"]').trigger('click');
    expect(authorize).toHaveBeenCalledWith({ destination: { kind: 'host', directoryId: 'root-a' } });
    await wrapper.setProps({ destination: { kind: 'opfs' } });
    permission.resolve({ destination: { kind: 'host', directoryId: 'root-a' }, expectedRoot }); await flushPromises();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ destination: { kind: 'host', directoryId: 'root-a' }, expectedRoot }));
    expect(downloadRepository).toHaveBeenCalledWith(expect.objectContaining({ destination: { kind: 'host', directoryId: 'root-a' } }));
    expect(getDownloadQueue().jobs.value[0]?.destination).toEqual({ kind: 'host', directoryId: 'root-a' });
  });

  it('rejects a root relinked under the same ID while permission was open, before metadata or file writes', async () => {
    const permission = Promise.withResolvers<AuthorizedModelDestination>();
    const expectedRoot = { name: 'Original folder' } as FileSystemDirectoryHandle;
    const wrapper = renderRow({ authorize: () => permission.promise }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-download"]').trigger('click');
    vi.mocked(hostModelRoot).mockResolvedValue({ name: 'Replacement folder', isSameEntry: async () => false } as unknown as HostModelDirectoryHandle);
    permission.resolve({ destination: { kind: 'host', directoryId: 'root-a' }, expectedRoot }); await flushPromises();
    expect(getDownloadQueue().jobs.value[0]?.status).toBe('failed');
    expect(downloadRepository).not.toHaveBeenCalled(); expect(discoverRepository).not.toHaveBeenCalled();
  });

  it('keeps a paused job visible and resumes to its captured root after selector changes', async () => {
    vi.mocked(downloadRepository).mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true })));
    const authorize = vi.fn(async ({ destination }: { destination: ModelDestination }) => ({ destination, expectedRoot: undefined }));
    const wrapper = renderRow({ authorize }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="llama-download-pause"]').trigger('click'); await flushPromises();
    await wrapper.setProps({ destination: { kind: 'host', directoryId: 'root-b' } }); await flushPromises();
    const bound = wrapper.get('[data-testid="llama-suggestion-other-destination-job"]');
    expect(bound.text()).toContain('host/root-a');
    await bound.get('[data-testid="llama-download-resume"]').trigger('click'); await flushPromises();
    expect(authorize).toHaveBeenLastCalledWith({ destination: { kind: 'host', directoryId: 'root-a' } });
    expect(vi.mocked(downloadRepository).mock.calls.at(-1)?.[0].destination).toEqual({ kind: 'host', directoryId: 'root-a' });
  });

  it('does not enqueue or discover anything after permission denial', async () => {
    const wrapper = renderRow({
      authorize: async () => {
        throw new Error('Permission denied');
      },
    }); await flushPromises();
    await wrapper.get('[data-testid="llama-suggestion-download"]').trigger('click'); await flushPromises();
    expect(getDownloadQueue().jobs.value).toHaveLength(0); expect(discoverRepository).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="llama-suggestion-destination-error"]').text()).toBeTruthy();
  });

  it('shares the repository and catalog destination choice through settings', async () => {
    const repository = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false } });
    const catalogView = mount(LlamaCppBrowserModelSuggestions, { props: { models: [], disabled: false, defaultModel: undefined, defaultActionDisabled: false, suggestions: [suggestion] } });
    wrappers.push(repository, catalogView); await flushPromises();
    await repository.get('[data-testid="llama-download-destination"]').setValue('host:root-a'); await flushPromises();
    expect(catalogView.get<HTMLSelectElement>('[data-testid="llama-download-destination"]').element.value).toBe('host:root-a');
    await catalogView.get('[data-testid="llama-download-destination"]').setValue('host:root-b'); await flushPromises();
    expect(repository.get<HTMLSelectElement>('[data-testid="llama-download-destination"]').element.value).toBe('host:root-b');
    expect(settings.value.experimental?.llamaCppBrowser?.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'root-b' });
    expect(discoverRepository).not.toHaveBeenCalled();
  });
});
