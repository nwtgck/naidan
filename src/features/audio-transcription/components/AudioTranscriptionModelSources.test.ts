import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ModelSelectorHuggingFaceSearch from '@/components/ModelSelectorHuggingFaceSearch.vue';
import LlamaCppBrowserLocalFiles from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFiles.vue';
import type { AudioTranscriptionModelImport, useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import AudioTranscriptionModelSources from './AudioTranscriptionModelSources.vue';

const mocks = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: mocks.inspect }) }));

function createModels(): ReturnType<typeof useAudioTranscriptionModels> {
  return {
    models: computed(() => []),
    selectedId: computed(() => undefined),
    select: vi.fn(),
    refresh: vi.fn(async () => {}),
    refreshing: ref(false),
    openSelected: vi.fn(),
    importModels: vi.fn(async () => {}),
    addRepositoryModel: vi.fn(),
    backgroundDownload: vi.fn(async () => {}),
    downloadStates: computed(() => new Map()),
    downloadDestination: {
      view: {
        supported: computed(() => false),
        entries: computed(() => []),
        busy: ref(false),
        destination: computed(() => 'opfs'),
        destinationKind: computed(() => 'opfs'),
        selectDestination: vi.fn(async () => {}),
        add: vi.fn(async () => {}),
        addDroppedDirectory: vi.fn(async () => {}),
        reconnect: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      destination: computed(() => ({ kind: 'opfs' as const })),
      unavailable: computed(() => false),
      authorize: vi.fn(async () => ({ destination: { kind: 'opfs' as const }, expectedRoot: undefined })),
      revision: ref(0),
      failure: computed(() => false),
      persistence: computed(() => 'saved'),
      label: vi.fn(() => 'OPFS'),
      TEST_ONLY: {},
    },
    quantizations: computed(() => []),
    selectedQuantizationId: computed(() => undefined),
    selectedQuantizationLabel: computed(() => undefined),
    canInspectQuantizations: computed(() => false),
    quantizationsBusy: computed(() => false),
    quantizationsFailure: ref(undefined),
    inspectSelectedQuantizations: vi.fn(async () => {}),
    selectQuantization: vi.fn(),
    selectedDetails: computed(() => undefined),
    busy: computed(() => false),
    progress: computed(() => undefined),
    failure: ref(undefined),
    TEST_ONLY: {},
  };
}

function mountSources({ models, mode }: { models: ReturnType<typeof useAudioTranscriptionModels>, mode: 'files' | 'huggingface' }) {
  const wrapper = mount(AudioTranscriptionModelSources, { props: { models, disabled: false, mode, active: true, query: '' }, global: { stubs: { ModelSelectorHuggingFaceSearch: true, LlamaCppBrowserLocalFiles: true } } });
  return {
    wrapper,
    [Symbol.dispose]() {
      if (wrapper.exists()) {
        wrapper.unmount();
      }
    },
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('Audio transcription model sources', () => {
  it('only forwards the shared query and does not inspect repositories when opening, changing modes or typing', async () => {
    using mounted = mountSources({ models: createModels(), mode: 'files' });
    await mounted.wrapper.setProps({ mode: 'huggingface' });
    const search = mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch);
    search.vm.$emit('update:query', 'private model name');
    await flushPromises();
    expect(mounted.wrapper.emitted('update:query')).toEqual([['private model name']]);
    await mounted.wrapper.setProps({ query: 'private model name' });
    expect(search.props('query')).toBe('private model name');
    await mounted.wrapper.setProps({ active: false });
    expect(search.props('active')).toBe(false);
    await mounted.wrapper.setProps({ active: true, mode: 'files' });
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('checks only an explicitly selected repository and waits for a file choice', async () => {
    mocks.inspect.mockResolvedValue({ repository: 'test/asr', revision: 'a'.repeat(40), models: [{ label: 'Q8_0', size: 1024, files: [{ path: 'asr-Q8_0.gguf', size: 1024 }] }], projectors: [] });
    const models = createModels();
    using mounted = mountSources({ models, mode: 'huggingface' });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr');
    await flushPromises();
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith({ input: 'test/asr', signal: expect.any(AbortSignal), freshness: 'reuse' });
    expect(models.addRepositoryModel).not.toHaveBeenCalled();
    expect(mounted.wrapper.get('[data-testid="audio-transcription-model-select-repository"]').attributes('disabled')).toBeDefined();
    await mounted.wrapper.get('[data-testid="audio-transcription-model-repository-file"]').setValue('asr-Q8_0.gguf');
    await mounted.wrapper.get('[data-testid="audio-transcription-model-select-repository"]').trigger('click');
    expect(models.addRepositoryModel).toHaveBeenCalledExactlyOnceWith({ selection: { repository: 'test/asr', revision: 'a'.repeat(40), files: [{ path: 'asr-Q8_0.gguf', size: 1024 }] } });
    expect(mounted.wrapper.emitted('selected')).toHaveLength(1);
    expect(models.openSelected).not.toHaveBeenCalled();
  });

  it('does not offer sharded models as single-file recognition choices', async () => {
    mocks.inspect.mockResolvedValue({ repository: 'test/asr', revision: 'a'.repeat(40), models: [{ label: 'Q8_0', size: 2048, files: [{ path: 'asr-Q8_0-00001-of-00002.gguf', size: 1024 }, { path: 'asr-Q8_0-00002-of-00002.gguf', size: 1024 }] }], projectors: [] });
    using mounted = mountSources({ models: createModels(), mode: 'huggingface' });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr');
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="audio-transcription-model-repository-file"]').findAll('option')).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="audio-transcription-model-select-repository"]').attributes('disabled')).toBeDefined();
  });

  it('drops late metadata after unmounting', async () => {
    const gate = Promise.withResolvers<unknown>();
    mocks.inspect.mockReturnValue(gate.promise);
    const models = createModels();
    using mounted = mountSources({ models, mode: 'huggingface' });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr');
    await flushPromises();
    const request = mocks.inspect.mock.calls[0]?.[0];
    mounted.wrapper.unmount();
    expect(request.signal.aborted).toBe(true);
    gate.resolve({ repository: 'test/asr', revision: 'a'.repeat(40), models: [], projectors: [] });
    await flushPromises();
    expect(models.addRepositoryModel).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'query'] as const)('cancels metadata on %s changes without applying a late catalog', async change => {
    const gate = Promise.withResolvers<unknown>();
    mocks.inspect.mockReturnValue(gate.promise);
    const models = createModels();
    using mounted = mountSources({ models, mode: 'huggingface' });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr');
    await flushPromises();
    const request = mocks.inspect.mock.calls[0]?.[0];
    if (change === 'inactive') {
      await mounted.wrapper.setProps({ active: false });
    } else {
      await mounted.wrapper.setProps({ query: 'another repository' });
    }
    expect(request.signal.aborted).toBe(true);
    gate.resolve({ repository: 'test/asr', revision: 'a'.repeat(40), models: [{ label: 'Q8_0', size: 1024, files: [{ path: 'asr-Q8_0.gguf', size: 1024 }] }], projectors: [] });
    await flushPromises();
    expect(mounted.wrapper.find('[data-testid="audio-transcription-model-repository-file"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(models.addRepositoryModel).not.toHaveBeenCalled();
  });

  it('forwards a local file choice and only selects after the import finishes', async () => {
    const models = createModels();
    const gate = Promise.withResolvers<void>();
    vi.mocked(models.importModels).mockReturnValue(gate.promise);
    using mounted = mountSources({ models, mode: 'files' });
    const file = new File(['gguf'], 'asr.gguf');
    const request: AudioTranscriptionModelImport = { directories: Promise.resolve([{ rootName: 'asr', files: [{ relativePath: file.name, file }] }]), controller: new AbortController(), save: 'later', repositoryLayout: 'confirmed' };
    mounted.wrapper.getComponent(LlamaCppBrowserLocalFiles).vm.$emit('accept', request);
    expect(models.importModels).toHaveBeenCalledExactlyOnceWith(request);
    expect(mounted.wrapper.emitted('selected')).toBeUndefined();
    gate.resolve();
    await flushPromises();
    expect(mounted.wrapper.emitted('selected')).toHaveLength(1);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(models.openSelected).not.toHaveBeenCalled();
  });
});
