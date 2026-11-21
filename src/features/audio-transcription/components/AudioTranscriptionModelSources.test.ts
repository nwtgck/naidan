import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { computed, defineComponent, h, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ModelSelectorHuggingFaceSearch from '@/components/ModelSelectorHuggingFaceSearch.vue';
import type { useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import AudioTranscriptionModelSelector from './AudioTranscriptionModelSelector.vue';
import AudioTranscriptionModelSources from './AudioTranscriptionModelSources.vue';

const mocks = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: mocks.inspect }) }));

const searchStub = defineComponent({
  name: 'ModelSelectorHuggingFaceSearch',
  props: ['query', 'active', 'disabled', 'expandedRepository'],
  emits: ['update:query', 'select', 'choose', 'search'],
  setup(_props, { slots, expose }) {
    expose({ focusOrigin: vi.fn() });
    return () => h('div', slots.repository?.());
  },
});

function createModels(): ReturnType<typeof useAudioTranscriptionModels> {
  const view: ReturnType<typeof useAudioTranscriptionModels>['downloadDestination']['view'] = {
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
  };
  return {
    models: computed(() => []),
    pickerModels: computed(() => []),
    selectedId: computed(() => undefined),
    selectedModelId: computed(() => undefined),
    select: vi.fn(),
    refresh: vi.fn(async () => {}),
    refreshing: ref(false),
    openSelected: vi.fn(),
    openSelectedLocal: vi.fn(),
    importModels: vi.fn(async () => ({ models: [], skipped: [] })),
    addRepositoryModel: vi.fn(),
    backgroundDownload: vi.fn(async () => {}),
    stopBackgroundDownload: vi.fn(),
    downloadStates: computed(() => new Map()),
    downloadDestination: {
      view,
      linkedFolders: view,
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
    detailsForModel: vi.fn(),
    quantizationsForModel: vi.fn(() => []),
    variantDownloadRequest: vi.fn(),
    requestForId: vi.fn(),
    isInstalledAtDestination: vi.fn(() => false),
    configurationSummary: vi.fn(() => 'standard' as const),
    modelVariant: vi.fn(),
    inspectQuantizations: vi.fn(async () => undefined),
    busy: computed(() => false),
    progress: computed(() => undefined),
    failure: ref(undefined),
    TEST_ONLY: {},
  };
}

function mountSources({ models }: { models: ReturnType<typeof useAudioTranscriptionModels> }) {
  const wrapper = mount(AudioTranscriptionModelSources, { props: { models, disabled: false, active: true, query: '' }, global: { stubs: { ModelSelectorHuggingFaceSearch: searchStub } } });
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

describe('Audio transcription model selector', () => {
  it('keeps the file details of an imported model alongside its copyable ID', async () => {
    const models = createModels();
    const modelId = '~user/ASR';
    models.pickerModels = computed(() => [{ id: modelId, label: modelId, description: undefined, availability: 'local', modelId, compatibility: undefined }]);
    vi.mocked(models.detailsForModel).mockImplementation(({ id }) => id === modelId ? { kind: 'local', name: 'ASR', fileName: 'ASR-Q8_0.gguf', bytes: 1024 } : undefined);
    const wrapper = mount(AudioTranscriptionModelSelector, { props: { models }, global: { stubs: { Teleport: true } } });
    using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
    await wrapper.get('button[data-testid="audio-transcription-model-selector"]').trigger('click');
    await wrapper.get('[data-testid="model-selector-stored-variant-details"]').trigger('click');
    expect(wrapper.get('code').text()).toBe(modelId);
    expect(wrapper.find('[data-testid="model-selector-copy-model-id"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('ASR-Q8_0.gguf');
    expect(wrapper.text()).toContain('1.0 KiB');
    void cleanup;
  });

  it('can inspect the Hugging Face configuration of an installed model', async () => {
    const models = createModels();
    const modelId = 'hf.co/test/ASR:Q8_0';
    models.pickerModels = computed(() => [{ id: modelId, label: modelId, description: undefined, availability: 'local', modelId, compatibility: undefined }]);
    vi.mocked(models.detailsForModel).mockImplementation(({ id }) => id === modelId ? { kind: 'huggingface', repository: 'test/ASR', repositoryUrl: 'https://huggingface.co/test/ASR', revision: undefined, files: undefined } : undefined);
    const wrapper = mount(AudioTranscriptionModelSelector, { props: { models }, global: { stubs: { Teleport: true } } });
    using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
    await wrapper.get('button[data-testid="audio-transcription-model-selector"]').trigger('click');
    await wrapper.get('[data-testid="model-selector-stored-variant-details"]').trigger('click');
    expect(wrapper.find('a[href="https://huggingface.co/test/ASR"]').exists()).toBe(true);
    expect(models.inspectQuantizations).not.toHaveBeenCalled();
    const inspect = wrapper.findAll('button').find(button => button.text() === 'Show model configuration')!;
    await inspect.trigger('click');
    expect(models.inspectQuantizations).toHaveBeenCalledExactlyOnceWith({ id: modelId, signal: expect.any(AbortSignal), pinCurrent: false });
    void cleanup;
  });

  it('selects a curated model by name and applies a quantization change without closing', async () => {
    const models = createModels();
    const id = 'suggestion:test-asr';
    const standard = { id: 'suggestion:q8_0', label: 'Q8_0', filePath: 'asr-Q8_0.gguf', bytes: 1024 };
    const smaller = { id: 'suggestion:q4_k', label: 'Q4_K', filePath: 'asr-Q4_K.gguf', bytes: 512 };
    const selected = ref<string>();
    const selectedVariant = ref(standard.id);
    models.pickerModels = computed(() => [{ id, label: 'Test ASR', description: undefined, availability: 'download_required', modelId: undefined, compatibility: undefined }]);
    models.selectedId = computed(() => selected.value);
    vi.mocked(models.modelVariant).mockImplementation(() => selectedVariant.value);
    vi.mocked(models.detailsForModel).mockReturnValue({ kind: 'huggingface', repository: 'test/asr', repositoryUrl: 'https://huggingface.co/test/asr', revision: undefined, files: undefined });
    vi.mocked(models.quantizationsForModel).mockReturnValue([standard, smaller]);
    vi.mocked(models.select).mockImplementation(({ id: entryId }) => {
      selected.value = entryId;
    });
    vi.mocked(models.selectQuantization).mockImplementation(({ id: variant, entryId }) => {
      selected.value = entryId;
      selectedVariant.value = variant;
    });
    const wrapper = mount(AudioTranscriptionModelSelector, { attachTo: document.body, props: { models }, global: { stubs: { Teleport: true, ModelSelectorVariantDownload: true } } });
    using cleanup = { [Symbol.dispose]: () => wrapper.unmount() };

    const trigger = wrapper.get('[data-testid="audio-transcription-model-selector"]');
    await trigger.trigger('click');
    const row = wrapper.get('[data-testid="audio-transcription-suggested-model"]');
    await row.trigger('click');
    expect(row.attributes('aria-expanded')).toBe('true');
    expect(models.select).not.toHaveBeenCalled();
    expect(models.selectQuantization).not.toHaveBeenCalled();

    const name = wrapper.get('[data-testid="audio-transcription-suggested-model-choose"]');
    await name.trigger('click');
    expect(models.select).toHaveBeenCalledExactlyOnceWith({ id });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    expect(wrapper.get('[data-testid="audio-transcription-suggested-model-choose"]').attributes('aria-pressed')).toBe('true');
    await wrapper.get('[data-testid="audio-transcription-suggested-model"]').trigger('click');
    await wrapper.get('[data-testid="model-selector-edit-configuration"]').trigger('click');
    const smallerVariant = wrapper.findAll('[data-testid="audio-transcription-model-variant"]').find(option => option.text().includes('Q4_K'))!;
    await smallerVariant.trigger('click');
    expect(smallerVariant.attributes('aria-pressed')).toBe('true');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(models.selectQuantization).toHaveBeenCalledExactlyOnceWith({ id: smaller.id, entryId: id });
    expect(models.inspectQuantizations).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="model-selector-choose-configuration"]').attributes('aria-pressed')).toBe('true');
    void cleanup;
  });
});

describe('Audio transcription model sources', () => {
  it('selects the standard single-file model from the result name', async () => {
    const file = { path: 'asr-Q8_0.gguf', size: 1024 };
    mocks.inspect.mockResolvedValue({ repository: 'test/asr', revision: 'a'.repeat(40), models: [{ label: 'Q8_0', size: file.size, files: [file] }], projectors: [] });
    const models = createModels();
    using mounted = mountSources({ models });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('choose', 'test/asr');
    await flushPromises();
    expect(models.addRepositoryModel).toHaveBeenCalledExactlyOnceWith({ selection: { repository: 'test/asr', revision: 'a'.repeat(40), files: [file] } });
    expect(mounted.wrapper.emitted('selected')).toEqual([[]]);
    expect(models.openSelected).not.toHaveBeenCalled();
  });

  it('only forwards the shared query and does not inspect repositories when opening or typing', async () => {
    using mounted = mountSources({ models: createModels() });
    const search = mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch);
    search.vm.$emit('update:query', 'private model name');
    await flushPromises();
    expect(mounted.wrapper.emitted('update:query')).toEqual([['private model name']]);
    await mounted.wrapper.setProps({ query: 'private model name' });
    expect(search.props('query')).toBe('private model name');
    await mounted.wrapper.setProps({ active: false });
    expect(search.props('active')).toBe(false);
    await mounted.wrapper.setProps({ active: true });
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('shows Q8_0 by default and applies a different variant without a second confirmation', async () => {
    mocks.inspect.mockResolvedValue({
      repository: 'test/asr',
      revision: 'a'.repeat(40),
      models: [
        { label: 'Q4_K_M', size: 512, files: [{ path: 'asr-Q4_K_M.gguf', size: 512 }] },
        { label: 'Q8_0', size: 1024, files: [{ path: 'asr-Q8_0.gguf', size: 1024 }] },
      ],
      projectors: [],
    });
    const models = createModels();
    const selectedPath = ref<string>();
    const preparing = ref(false);
    models.selectedQuantizationId = computed(() => selectedPath.value);
    models.selectedDetails = computed(() => selectedPath.value === undefined ? undefined : { kind: 'huggingface', repository: 'test/asr', repositoryUrl: 'https://huggingface.co/test/asr', revision: 'a'.repeat(40), files: undefined });
    models.busy = computed(() => preparing.value);
    vi.mocked(models.addRepositoryModel).mockImplementation(({ selection }) => {
      selectedPath.value = selection.files[0]?.path;
    });
    using mounted = mountSources({ models });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr', 'result');
    await flushPromises();
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith({ input: 'test/asr', signal: expect.any(AbortSignal), freshness: 'reuse' });
    expect(models.addRepositoryModel).not.toHaveBeenCalled();
    expect(mounted.wrapper.text()).toContain('Default configuration');
    expect(mounted.wrapper.text()).toContain('Q8_0');
    expect(mounted.wrapper.find('[data-testid="audio-transcription-model-variant"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="model-selector-repository-source"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="model-selector-edit-configuration"]').trigger('click');
    const variant = mounted.wrapper.get('[data-testid="audio-transcription-model-variant"]');
    await variant.trigger('click');
    expect(models.addRepositoryModel).toHaveBeenCalledExactlyOnceWith({ selection: { repository: 'test/asr', revision: 'a'.repeat(40), files: [{ path: 'asr-Q4_K_M.gguf', size: 512 }] } });
    expect(mounted.wrapper.emitted('selected')).toBeUndefined();
    expect(models.openSelected).not.toHaveBeenCalled();
    preparing.value = true;
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="audio-transcription-model-variant"]').element).toBe(variant.element);
    expect(variant.attributes('aria-pressed')).toBe('true');
    const collapse = mounted.wrapper.get('[aria-label="Collapse model configuration"]');
    expect(collapse.text()).toBe('');
    await collapse.trigger('click');
    expect(mounted.wrapper.find('[data-testid="audio-transcription-model-variant"]').exists()).toBe(false);
  });

  it('does not offer sharded models as single-file recognition choices', async () => {
    mocks.inspect.mockResolvedValue({ repository: 'test/asr', revision: 'a'.repeat(40), models: [{ label: 'Q8_0', size: 2048, files: [{ path: 'asr-Q8_0-00001-of-00002.gguf', size: 1024 }, { path: 'asr-Q8_0-00002-of-00002.gguf', size: 1024 }] }], projectors: [] });
    const models = createModels();
    using mounted = mountSources({ models });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr', 'result');
    await flushPromises();
    expect(mounted.wrapper.findAll('[data-testid="audio-transcription-model-variant"]')).toHaveLength(0);
    expect(models.addRepositoryModel).not.toHaveBeenCalled();
  });

  it('drops late metadata after unmounting', async () => {
    const gate = Promise.withResolvers<unknown>();
    mocks.inspect.mockReturnValue(gate.promise);
    const models = createModels();
    using mounted = mountSources({ models });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr', 'result');
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
    using mounted = mountSources({ models });
    mounted.wrapper.getComponent(ModelSelectorHuggingFaceSearch).vm.$emit('select', 'test/asr', 'result');
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
    expect(mounted.wrapper.find('[data-testid="audio-transcription-model-variant"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(models.addRepositoryModel).not.toHaveBeenCalled();
  });
});
