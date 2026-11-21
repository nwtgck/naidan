vi.mock('@/components/SettingsSelect.vue', async () => ({
  default: (await import('@/components/settings-select.test-support')).SettingsSelectStub,
}));
import LlamaCppBrowserRepositoryPicker from '@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryPicker.vue';
import ModelSelectorFileImport from '@/components/ModelSelectorFileImport.vue';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import type { DownloadJob, getDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import type { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import type { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { repositoryDefaultDownloadKey } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { targetForSelection } from '@/features/llama-cpp-browser/model-launch/target';
import { acquireRepositoryModel } from '@/features/llama-cpp-browser/model-launch/acquire-repository-model';
import { localRepositories } from '@/features/llama-cpp-browser/runtime/local-repository-store';
import { audioModelCatalog } from './model-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import ModelSelector from '@/components/ModelSelector.vue';
import { useSettings } from '@/composables/useSettings';
import { DOMWrapper, mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { setLocale } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import type { EngineState, LocalModel } from '@/features/llama-cpp-browser/types';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { audioResult } from './test-utils/wav.test-support';
import AudioGenerationView from './AudioGenerationView.vue';
import AudioReferenceInput from './components/AudioReferenceInput.vue';
import * as referencePreparation from './reference-audio';
import type { inspectStoredAudioModel } from './model-detection';
vi.mock('@/composables/useSettings', async importOriginal => {
  const actual = await importOriginal<typeof import('@/composables/useSettings')>();
  return {
    ...actual,
    useSettings: () => ({
      // The real catalog also consumes shared settings for its download target.
      ...actual.useSettings(),
      availableModels: ref<string[]>([]),
      isFetchingModels: ref(false),
      fetchModels: vi.fn<ReturnType<typeof actual.useSettings>['fetchModels']>(),
    }),
  };
});
const detection = vi.hoisted(() => ({ inspect: vi.fn<typeof inspectStoredAudioModel>() }));
vi.mock('./model-detection', async importOriginal => ({ ...await importOriginal<typeof import('./model-detection')>(), inspectStoredAudioModel: detection.inspect }));

const service = vi.hoisted(() => ({
  getState: vi.fn<LlamaCppBrowserService['getState']>(),
  getOptions: vi.fn<LlamaCppBrowserService['getOptions']>(),
  subscribe: vi.fn<LlamaCppBrowserService['subscribe']>(),
  subscribeModelList: vi.fn<LlamaCppBrowserService['subscribeModelList']>(() => () => {}),
  generateAudio: vi.fn<LlamaCppBrowserService['generateAudio']>(),
  restartRuntime: vi.fn<LlamaCppBrowserService['restartRuntime']>(),
  cancel: vi.fn(),
  release: vi.fn(),
  setOptions: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
const inventory = vi.hoisted(() => ({
  list: vi.fn<typeof listModelInventory>(),
  subscribe: vi.fn<({ listener }: { listener: () => void }) => () => void>(),
  openSettings: vi.fn<typeof import('@/composables/useAppEntry').requestAppSettings>(),
}));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: inventory.list }));
vi.mock('@/features/llama-cpp-browser/model-files', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/llama-cpp-browser/model-files')>();
  return { ...actual, llamaCppBrowserModelFiles: { ...actual.llamaCppBrowserModelFiles, subscribeModelList: inventory.subscribe, inspectModelFiles: download.files } };
});
vi.mock('@/composables/useAppEntry', async importOriginal => ({
  ...await importOriginal<typeof import('@/composables/useAppEntry')>(),
  requestAppSettings: inventory.openSettings,
}));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserRuntimeSettings.vue', () => ({
  default: defineComponent({
    name: 'LlamaCppBrowserRuntimeSettings',
    props: ['disabled', 'releaseDisabled'],
    emits: ['runtimeReady'],
    template: '<div />',
  }),
}));
const download = vi.hoisted(() => ({
  enqueue: vi.fn<ReturnType<typeof getDownloadQueue>['enqueue']>(),
  inspect: vi.fn<ReturnType<typeof getMetadataSession>['inspect']>(),
  installed: vi.fn<typeof installedSelection>(),
  files: vi.fn<typeof llamaCppBrowserModelFiles.inspectModelFiles>(),
}));
const downloadJobs = shallowRef<DownloadJob[]>([]);
const downloadRevision = ref(0);
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/download-queue')>(),
  getDownloadQueue: () => ({ jobs: downloadJobs, changed: downloadRevision, enqueue: download.enqueue }),
}));
vi.mock('@/features/llama-cpp-browser/hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: download.inspect }) }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/storage')>(),
  installedSelection: download.installed,
}));
const defaultRepository = 'mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF';
const defaultModelId = `hf.co/${defaultRepository}:Q4_K_M`;
const defaultMain = { path: 'Qwen3-TTS-12Hz-0.6B-Base.Q4_K_M.gguf', size: 361 };
const defaultCompanion = { path: 'Qwen3-TTS-12Hz-0.6B-Base.mmproj-Q8_0.gguf', size: 401 };
const defaultCatalog = {
  repository: defaultRepository,
  revision: 'a'.repeat(40),
  models: [{ label: 'Q4_K_M', size: defaultMain.size, files: [defaultMain] }],
  projectors: [defaultCompanion],
};
const urls = { create: vi.fn(), revoke: vi.fn() };
let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  useSettings().TEST_ONLY.__testOnlyReset();
  inventory.list.mockResolvedValue([]);
  downloadJobs.value = [];
  downloadRevision.value = 0;
  download.inspect.mockResolvedValue(defaultCatalog);
  download.installed.mockResolvedValue(undefined);
  inventory.subscribe.mockReturnValue(() => {});
  service.getState.mockReturnValue({ status: 'idle' });
  service.getOptions.mockReturnValue({ profile: 'cpu-wasm32' });
  service.restartRuntime.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  service.subscribe.mockReturnValue(service.unsubscribe);
  service.generateAudio.mockResolvedValue(audioResult());
  urls.create.mockReturnValue('blob:generated-audio');
  detection.inspect.mockResolvedValue({ status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = urls.create; static override revokeObjectURL = urls.revoke;
  });
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadInventory({ view, entries, ready }: { view: VueWrapper, entries: LocalModel[], ready: boolean }): Promise<void> {
  inventory.list.mockResolvedValue(entries);
  inventory.subscribe.mock.lastCall?.[0].listener();
  view.getComponent({ name: 'LlamaCppBrowserRuntimeSettings' }).vm.$emit('runtimeReady', ready);
  await flushPromises();
}

async function ready(): Promise<VueWrapper> {
  wrapper = mount(AudioGenerationView);
  await loadInventory({ view: wrapper, entries: [{ modelId: 'user/voice', size: 100, importedAt: 1 }], ready: true });
  await wrapper.get('[data-testid="audio-text"]').setValue('Hello');
  return wrapper;
}

async function submit({ view }: { view: VueWrapper }): Promise<void> {
  await view.get('form').trigger('submit');
  await flushPromises();
}

function notify({ state }: { state: EngineState }): void {
  service.subscribe.mock.calls[0]?.[0].listener({ state });
}

describe('first-use audio model download', () => {
  it('shows a compact first-use hint beside the destination and starts only after a valid Generate', async () => {
    wrapper = mount(AudioGenerationView);
    const view = wrapper;
    await loadInventory({ view, entries: [], ready: true });
    const picker = view.getComponent(ModelSelector);
    expect(picker.props('modelValue')).toBe(defaultModelId);
    expect(picker.get('[data-testid="model-selector-trigger"]').classes()).toContain('min-h-11');
    const hint = picker.get('[data-testid="model-selector-download-hint"]');
    expect(hint.get('[data-testid="model-selector-first-use-destination"]').text()).toBe('OPFS');
    expect(picker.get('[data-testid="model-selector-trigger"]').attributes('aria-describedby')).toBe(hint.attributes('id'));
    expect(download.inspect).not.toHaveBeenCalled();
    expect(download.enqueue).not.toHaveBeenCalled();

    await submit({ view });
    expect(view.find('[data-testid="audio-error"]').exists()).toBe(true);
    expect(download.enqueue).not.toHaveBeenCalled();
    const transfer = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => transfer.resolve() };
    download.installed.mockResolvedValue({ modelId: defaultModelId, size: 762, importedAt: 1 });
    download.enqueue.mockImplementationOnce(({ key, repository, source, destination, prepare }) => ({
      id: 5,
      done: prepare({ signal: new AbortController().signal }).then(async selection => {
        const identity = { id: 5, key, repository, source, destination: destination ?? { kind: 'opfs' as const }, selection, error: undefined };
        downloadJobs.value = [{ ...identity, status: 'downloading', progress: { phase: 'transferring', completed: 381, processed: 381, total: 762 } }];
        await transfer.promise;
        return { ...identity, status: 'complete', progress: undefined };
      }),
    }));
    await view.get('[data-testid="audio-text"]').setValue('Hello, this is Naidan.');
    await submit({ view });
    expect(download.inspect).toHaveBeenCalledOnce();
    expect(download.enqueue).toHaveBeenCalledWith(expect.objectContaining({ repository: defaultRepository, destination: { kind: 'opfs' } }));
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(view.get('[data-testid="audio-model-download-progress"]').text()).toContain('50%');
    transfer.resolve();
    await flushPromises();
    expect(download.installed).toHaveBeenCalledWith({
      destination: { kind: 'opfs' },
      expectedRoot: undefined,
      selection: { repository: defaultRepository, revision: defaultCatalog.revision, files: [defaultMain, defaultCompanion] },
    });
    expect(service.generateAudio).toHaveBeenCalledOnce();
    expect(service.generateAudio.mock.calls[0]?.[0].input.modelId).toBe(defaultModelId);
    expect(picker.find('[data-testid="model-selector-download-hint"]').exists()).toBe(false);
    expect(view.find('[data-testid="audio-history"]').exists()).toBe(true);
  });

  it('joins the same default model already downloading from a search row', async () => {
    wrapper = mount(AudioGenerationView);
    const view = wrapper;
    await loadInventory({ view, entries: [], ready: true });
    await view.get('[data-testid="audio-text"]').setValue('Hello');
    const key = repositoryDefaultDownloadKey({ repository: defaultRepository, usage: 'audio-generation' });
    const selection = { repository: defaultRepository, revision: defaultCatalog.revision, files: [defaultMain, defaultCompanion] };
    const joined: DownloadJob = {
      id: 8,
      key,
      repository: defaultRepository,
      source: 'repository',
      destination: { kind: 'opfs' },
      status: 'downloading',
      selection,
      progress: undefined,
      error: undefined,
    };
    downloadJobs.value = [joined];
    download.enqueue.mockReturnValueOnce({ id: joined.id, done: Promise.resolve({ ...joined, status: 'complete', selection }) });
    download.installed.mockResolvedValue({ modelId: defaultModelId, size: 762, importedAt: 1 });
    await nextTick();
    expect(view.find('[data-testid="model-selector-download-hint"]').exists()).toBe(false);
    await submit({ view });
    expect(download.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key }));
    expect(download.inspect).not.toHaveBeenCalled();
    expect(service.generateAudio).toHaveBeenCalledOnce();
  });

  it('retains the hint and downloads the selected quantization if a search job is fetching another one', async () => {
    wrapper = mount(AudioGenerationView);
    const view = wrapper;
    await loadInventory({ view, entries: [], ready: true });
    await view.get('[data-testid="audio-text"]').setValue('Hello');
    const searchKey = repositoryDefaultDownloadKey({ repository: defaultRepository, usage: 'audio-generation' });
    const selection = { repository: defaultRepository, revision: defaultCatalog.revision, files: [defaultMain, defaultCompanion] };
    downloadJobs.value = [{
      id: 8,
      key: searchKey,
      repository: defaultRepository,
      source: 'repository',
      destination: { kind: 'opfs' },
      status: 'downloading',
      selection: { ...selection, files: [{ path: 'Qwen3-TTS-12Hz-0.6B-Base.Q8_0.gguf', size: 646 }, defaultCompanion] },
      progress: undefined,
      error: undefined,
    }];
    download.enqueue.mockImplementationOnce(({ key, repository, source, destination }) => ({
      id: 9,
      done: Promise.resolve({ id: 9, key, repository, source, destination: destination ?? { kind: 'opfs' }, status: 'complete', selection, progress: undefined, error: undefined }),
    }));
    download.installed.mockResolvedValue({ modelId: defaultModelId, size: 762, importedAt: 1 });
    await nextTick();
    expect(view.find('[data-testid="model-selector-download-hint"]').exists()).toBe(true);
    await submit({ view });
    expect(download.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: expect.not.stringMatching(searchKey) }));
    expect(service.generateAudio).toHaveBeenCalledOnce();
  });

  it.each(['already-readable', 'read-grant-expired'] as const)('reuses a linked model when access is %s', async access => {
    const files = { repository: defaultRepository, revision: defaultCatalog.revision, files: [defaultMain, defaultCompanion] };
    const target = targetForSelection({ selection: files });
    const destination = { kind: 'host' as const, directoryId: 'models' };
    const model = { modelId: `host/models/${defaultRepository}:Q4_K_M`, size: 762, importedAt: 1 };
    const authorizeDestination = vi.fn(async () => ({ destination, expectedRoot: undefined }));
    switch (access) {
    case 'already-readable':
      authorizeDestination.mockRejectedValueOnce(new Error('Write permission denied'));
      break;
    case 'read-grant-expired':
      download.installed.mockRejectedValueOnce(new Error('Read permission expired'));
      break;
    default: throw new Error(String(access satisfies never));
    }
    download.installed.mockResolvedValue(model);
    const pending = acquireRepositoryModel({
      usage: 'audio-generation',
      selection: { modelId: target.modelId, source: { kind: 'resolved', target }, destination, authorizeDestination },
      models: [],
      capturedRoot: {} as FileSystemDirectoryHandle,
      signal: new AbortController().signal,
      onDownload: vi.fn(),
    });
    expect(authorizeDestination).toHaveBeenCalledOnce();
    await expect(pending).resolves.toEqual(model);
    expect(download.enqueue).not.toHaveBeenCalled();
  });

  it('lets the user pick another catalog model without fetching it', async () => {
    wrapper = mount(AudioGenerationView);
    const view = wrapper;
    await loadInventory({ view, entries: [], ready: true });
    await view.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const popup = new DOMWrapper(document.body).get('[data-testid="model-selector-dropdown"]');
    await popup.get('[data-testid="chat-model-suggestion-choose"][aria-label="Qwen3-TTS 1.7B Base"]').trigger('click');
    await flushPromises();
    expect(view.getComponent(ModelSelector).props('modelValue')).toBe('hf.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF:Q4_K_M');
    expect(download.inspect).not.toHaveBeenCalled();
    expect(download.enqueue).not.toHaveBeenCalled();
  });

  it('cancels the generation wait even if the shared download finishes afterwards', async () => {
    wrapper = mount(AudioGenerationView);
    const view = wrapper;
    await loadInventory({ view, entries: [], ready: true });
    await view.get('[data-testid="audio-text"]').setValue('Hello');
    const transfer = Promise.withResolvers<DownloadJob>();
    download.enqueue.mockReturnValueOnce({ id: 7, done: transfer.promise });
    await submit({ view });
    await view.get('[data-testid="audio-stop"]').trigger('click');
    await flushPromises();
    expect(view.find('[data-testid="audio-stopped"]').exists()).toBe(true);
    transfer.resolve({
      id: 7,
      key: 'download',
      repository: defaultRepository,
      source: 'repository',
      destination: { kind: 'opfs' },
      status: 'complete',
      selection: { repository: defaultRepository, revision: defaultCatalog.revision, files: [defaultMain, defaultCompanion] },
      progress: undefined,
      error: undefined,
    });
    await flushPromises();
    expect(service.generateAudio).not.toHaveBeenCalled();
  });
});

describe('independent audio generation screen', () => {
  it('loads local models on mount while runtime settings are collapsed, without changing chat options', async () => {
    const view = await ready();
    expect(inventory.list).toHaveBeenCalled();
    expect(view.get<HTMLDetailsElement>('[data-testid="audio-runtime-settings"]').element.open).toBe(false);
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(service.setOptions).not.toHaveBeenCalled();
    expect(view.getComponent(ModelSelector).props('modelValue')).toBe('user/voice');
    await submit({ view });
    expect(service.generateAudio.mock.calls[0]?.[0].input.modelId).toBe('user/voice');
    expect(download.inspect).not.toHaveBeenCalled();
    expect(download.enqueue).not.toHaveBeenCalled();
  });

  it('starts with the interface language and displays localized/native names', async () => {
    await ensureAllStringsForTest({ locale: 'ja' });
    const view = await ready();
    const select = view.get<HTMLSelectElement>('[data-testid="audio-language"]');
    expect(select.element.value).toBe('ja');
    expect(view.get('option[value="en"]').text()).toBe('英語 (English)');
    expect(view.get('option[value="ja"]').text()).toBe('日本語');
    expect(view.get('option[value="zh"]').text()).toBe('中国語 (中文)');
  });

  it('updates labels after a real interface locale switch without overwriting the speech selection', async () => {
    const view = await ready();
    await view.get('[data-testid="audio-language"]').setValue('de');
    await setLocale({ locale: 'ja' });
    await flushPromises();
    expect(view.get('option[value="en"]').text()).toBe('英語 (English)');
    expect(view.get<HTMLSelectElement>('[data-testid="audio-language"]').element.value).toBe('de');
  });

  it('offers manual language and model default without advertising the removed downstream auto feature', async () => {
    const view = await ready();
    const select = view.get('[data-testid="audio-language"]');
    expect(select.find('option[value="auto"]').exists()).toBe(false);
    expect(select.find('option[value="default"]').exists()).toBe(true);
    expect(select.findAll('option')).toHaveLength(11);
    expect(view.find('[data-testid="audio-auto-unavailable"]').exists()).toBe(false);
    await select.setValue('default');
    await submit({ view });
    expect(service.generateAudio.mock.calls[0]?.[0].input.language).toBe('default');
  });

  it('shows a field error for a stale auto value instead of submitting it or falling back', async () => {
    const view = await ready();
    const select = view.get<HTMLSelectElement>('[data-testid="audio-language"]');
    // Emulate a stale/different caller that can supply a no-longer-offered value.
    select.element.add(new Option('Retired automatic language', 'auto'));
    view.findAllComponents({ name: 'SettingsFormSelect' }).find(choice => choice.attributes('data-testid') === 'audio-language')!.vm.$emit('update:modelValue', 'auto');
    await nextTick();
    await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(view.get('[data-testid="audio-error"]').text()).toContain('Language');
    expect(select.attributes('aria-invalid')).toBe('true');
    expect(select.element.value).toBe('auto');
  });

  it('keeps the input and Generate together while opening settings under the card', async () => {
    const view = await ready();
    expect(view.get('[data-testid="audio-generation-scroll"]').find('[data-testid="audio-generation-page"]').exists()).toBe(true);
    const composer = view.get('[data-testid="audio-composer"]');
    const settingsPanel = view.get('[data-testid="audio-settings-panel"]');
    const referencePanel = view.get('[data-testid="audio-reference-panel"]');
    const text = composer.get('[data-testid="audio-text"]').element;
    const generate = composer.get('[data-testid="audio-generate"]').element;
    const controls = composer.findAll('[data-testid="audio-model"], [data-testid="audio-language"], [data-testid="audio-text"], [data-testid="audio-generate"]');
    expect(controls.map(control => control.attributes('data-testid'))).toEqual(['audio-model', 'audio-language', 'audio-text', 'audio-generate']);
    expect(settingsPanel.attributes('hidden')).toBeDefined();
    expect(referencePanel.attributes('hidden')).toBeDefined();
    expect(view.get('form').element.nextElementSibling?.id).toBe('audio-generation-results');

    await composer.get('[data-testid="audio-toggle-reference"]').trigger('click');
    expect(referencePanel.attributes('hidden')).toBeUndefined();
    expect(composer.get('[data-testid="audio-generate"]').element).toBe(generate);
    await composer.get('[data-testid="audio-toggle-settings"]').trigger('click');
    expect(referencePanel.attributes('hidden')).toBeDefined();
    expect(settingsPanel.attributes('hidden')).toBeUndefined();
    expect(composer.get('[data-testid="audio-text"]').element).toBe(text);
    expect(composer.get('[data-testid="audio-generate"]').element).toBe(generate);

    const settings = settingsPanel.get<HTMLDetailsElement>('[data-testid="audio-runtime-settings"]');
    settings.element.open = true;
    const manage = settings.get('[data-testid="audio-open-model-management"]');
    await manage.trigger('click');
    expect(inventory.openSettings).toHaveBeenCalledWith({ tab: 'llama_cpp_browser', opener: manage.element });
  });

  it('reveals hash sections without replacing the input or cancelling an active generation', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/audio-generation', component: defineComponent({ render: () => undefined }) }] });
    await router.push('/audio-generation#audio-generation-results');
    await router.isReady();
    const host = document.createElement('div');
    document.body.append(host);
    using mounted = {
      view: mount(AudioGenerationView, { attachTo: host, global: { plugins: [router] } }),
      [Symbol.dispose]() {
        this.view.unmount();
        host.remove();
      },
    };
    const view = mounted.view;
    expect(document.activeElement).toBe(view.get('#audio-generation-results').element);
    expect(view.find('[data-testid="audio-history"]').exists()).toBe(false);
    await loadInventory({ view, entries: [{ modelId: 'user/voice', size: 100, importedAt: 1 }], ready: true });
    const input = view.get('[data-testid="audio-text"]');
    await input.setValue('Keep this input');
    using gate = {
      ...Promise.withResolvers<Awaited<ReturnType<LlamaCppBrowserService['generateAudio']>>>(),
      [Symbol.dispose]() {
        this.resolve(audioResult());
      },
    };
    service.generateAudio.mockReturnValue(gate.promise);
    await submit({ view });
    const signal = service.generateAudio.mock.calls[0]![0].cancellationSignal;
    const details = view.get<HTMLDetailsElement>('[data-testid="audio-runtime-settings"]');
    details.element.open = false;
    await router.push('/audio-generation#audio-generation-models');
    await flushPromises();
    expect(details.element.open).toBe(true);
    expect(view.get('[data-testid="audio-settings-panel"]').attributes('hidden')).toBeUndefined();
    expect(document.activeElement).toBe(details.get('summary').element);
    expect(view.get('[data-testid="audio-text"]').element).toBe(input.element);
    expect(view.get<HTMLTextAreaElement>('[data-testid="audio-text"]').element.value).toBe('Keep this input');
    expect(signal?.aborted).toBe(false);
    await router.push('/audio-generation#audio-generation-input');
    await flushPromises();
    expect(document.activeElement).toBe(view.get('form').element);
    expect(service.generateAudio).toHaveBeenCalledOnce();
    gate.resolve(audioResult());
    await flushPromises();
    expect(view.find('[data-testid="audio-history"]').exists()).toBe(true);
    expect(service.unsubscribe).not.toHaveBeenCalled();
  });

  it('reveals invalid fields hidden inside advanced details instead of relying on browser form validation', async () => {
    const view = await ready();
    expect(view.get<HTMLFormElement>('form').element.noValidate).toBe(true);
    const context = view.get<HTMLInputElement>('[data-testid="audio-context"]');
    const details = context.element.closest('details')!;
    expect(details.open).toBe(false);
    expect(view.get('[data-testid="audio-settings-panel"]').attributes('hidden')).toBeDefined();
    await context.setValue('1');
    await submit({ view });
    expect(view.get('[data-testid="audio-settings-panel"]').attributes('hidden')).toBeUndefined();
    expect(details.open).toBe(true);
    expect(context.attributes('aria-invalid')).toBe('true');
    expect(view.get('[data-testid="audio-error"]').text()).toContain('1024');
    expect(service.generateAudio).not.toHaveBeenCalled();
  });

  it('reports empty text in the page and removes old validation errors on a successful retry', async () => {
    const view = await ready();
    await view.get('[data-testid="audio-text"]').setValue('   ');
    await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(view.get('[data-testid="audio-error"]').text()).toContain('text');
    await view.get('[data-testid="audio-text"]').setValue('Hello');
    await submit({ view });
    expect(service.generateAudio).toHaveBeenCalledOnce();
    expect(view.find('[data-testid="audio-error"]').exists()).toBe(false);
  });

  it('accepts context requests above the old 8192 UI limit', async () => {
    const view = await ready();
    const context = view.get('[data-testid="audio-context"]');
    expect(context.attributes('max')).not.toBe('8192');
    await context.setValue('32768');
    await submit({ view });
    expect(service.generateAudio.mock.calls[0]?.[0].input.contextTokens).toBe(32768);
  });

  it('uses the local model ID and emits a downloadable WAV without autoplay', async () => {
    const view = await ready();
    await view.get('[data-testid="audio-language"]').setValue('ja');
    await submit({ view });
    expect(service.generateAudio).toHaveBeenCalledOnce();
    expect(service.generateAudio.mock.calls[0]?.[0].input).toMatchObject({ modelId: 'user/voice', text: 'Hello', language: 'ja', audioBackend: 'profile', contextTokens: 4096, debug: 'off' });
    expect(service.generateAudio.mock.calls[0]?.[0].input).not.toHaveProperty('messages');
    const player = view.get('[data-testid="audio-player"]');
    expect(player.attributes('src')).toBe('blob:generated-audio');
    expect(player.attributes()).not.toHaveProperty('autoplay');
    expect(view.get('[data-testid="audio-download"]').attributes('download')).toBe('naidan-audio-1.wav');
    expect(urls.create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect((urls.create.mock.calls[0]?.[0] as Blob).type).toBe('audio/wav');
    expect(view.find('[data-testid="audio-truncated"]').exists()).toBe(false);
  });

  it.each([
    { modelId: 'user/voice', source: 'user', name: 'voice' },
    { modelId: 'hf.co/owner/Voice-GGUF:Q8_0', source: 'hf.co/owner', name: 'Voice-GGUF:Q8_0' },
    { modelId: 'host/MyModels1/owner/Voice-GGUF:Q8_0', source: 'host/MyModels1/owner', name: 'Voice-GGUF:Q8_0' },
    { modelId: 'temp/Voice-GGUF', source: 'temp', name: 'Voice-GGUF' },
  ])('selects, generates and displays the same readable modelId: $modelId', async ({ modelId, source, name }) => {
    wrapper = mount(AudioGenerationView);
    await loadInventory({ view: wrapper, entries: [{ modelId, size: 100, importedAt: 1 }], ready: true });
    await flushPromises();
    expect(detection.inspect).toHaveBeenCalledWith({ modelId, signal: expect.any(AbortSignal) });
    const selector = wrapper.getComponent(ModelSelector);
    expect(selector.props('modelValue')).toBe(modelId);
    expect(selector.props('models')).toEqual([{ id: modelId, label: modelId, description: undefined, availability: 'local' }]);
    const trigger = selector.get('[data-testid="model-selector-trigger"]');
    expect(trigger.attributes('title')).toBe(modelId);
    const metadata = trigger.get('[data-testid="model-selector-trigger-metadata"]');
    expect(metadata.element.previousElementSibling?.textContent).toBe(name);
    expect(metadata.text()).toBe(source);
    await wrapper.get('[data-testid="audio-text"]').setValue('Hello');
    await submit({ view: wrapper });
    expect(service.generateAudio.mock.calls[0]![0].input.modelId).toBe(modelId);
    expect(wrapper.get('[data-testid="audio-result-model"]').text()).toBe(modelId);
  });

  it.each(['frame-limit', 'context-limit'] as const)('labels truncated output: %s', async finishReason => {
    service.generateAudio.mockResolvedValueOnce({ ...audioResult(), finishReason });
    const view = await ready();
    await submit({ view });
    expect(view.get('[data-testid="audio-truncated"]').text()).not.toBe('');
  });

  it('does not submit invalid values even when HTML validation is bypassed', async () => {
    const view = await ready();
    await view.get('[data-testid="audio-context"]').setValue('1');
    await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(view.find('[data-testid="audio-error"]').exists()).toBe(true);
  });

  it('waits for runtime availability and avoids starting alongside another active operation', async () => {
    const view = await ready();
    const runtime = view.getComponent({ name: 'LlamaCppBrowserRuntimeSettings' });
    runtime.vm.$emit('runtimeReady', false);
    await nextTick();
    await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled();
    runtime.vm.$emit('runtimeReady', true);
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 10 } } });
    await nextTick();
    await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled();
  });

  it('clears a selection whose model was removed', async () => {
    const view = await ready();
    await loadInventory({ view, entries: [], ready: true });
    expect(view.getComponent(ModelSelector).props('modelValue')).toBe(defaultModelId);
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(download.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the selected reference when the panel closes and lets the user clear it', async () => {
    const view = await ready();
    await view.get('[data-testid="audio-toggle-reference"]').trigger('click');
    const input = view.get<HTMLInputElement>('[data-testid="audio-reference"]');
    const file = new File(['reference'], 'speaker.wav');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    await input.trigger('change');
    expect(view.get('[data-testid="audio-composer-reference-count"]').text()).toBe('1');
    await submit({ view });
    expect(service.generateAudio.mock.calls[0]?.[0].input.reference).toBe(file);
    expect(view.get('[data-testid="audio-reference-panel"]').attributes('hidden')).toBeDefined();
    expect(view.get('[data-testid="audio-history"]').isVisible()).toBe(true);
    await view.get('[data-testid="audio-toggle-reference"]').trigger('click');
    await view.get('[data-testid="audio-clear-reference"]').trigger('click');
    expect(view.find('[data-testid="audio-composer-reference-count"]').exists()).toBe(false);
    await submit({ view });
    expect(service.generateAudio.mock.calls[1]?.[0].input.reference).toBeUndefined();
  });

  it('reveals the reference controls when the selected model requires a reference', async () => {
    detection.inspect.mockResolvedValue({ status: 'detected', pipeline: 'pocket-tts', reference: 'required' });
    const view = await ready();
    expect(view.find('[data-testid="audio-reference-needed"]').exists()).toBe(true);
    expect(view.get('[data-testid="audio-reference-panel"]').attributes('hidden')).toBeDefined();
    await submit({ view });
    expect(view.get('[data-testid="audio-reference-panel"]').attributes('hidden')).toBeUndefined();
    expect(view.get('[data-testid="audio-error"]').text()).toContain('audio-reference-required');
    expect(service.generateAudio).not.toHaveBeenCalled();
  });

  it('keeps recording controls reachable and reopens the reference panel after a recording error', async () => {
    const view = await ready();
    await view.get('[data-testid="audio-toggle-reference"]').trigger('click');
    const reference = view.getComponent(AudioReferenceInput);
    reference.vm.$emit('busy', true);
    await view.get('[data-testid="audio-toggle-settings"]').trigger('click');
    expect(view.get('[data-testid="audio-reference-panel"]').attributes('hidden')).toBeUndefined();
    expect(view.get('[data-testid="audio-settings-panel"]').attributes('hidden')).toBeUndefined();

    reference.vm.$emit('recording-failed');
    reference.vm.$emit('busy', false);
    await nextTick();
    expect(view.get('[data-testid="audio-reference-panel"]').attributes('hidden')).toBeUndefined();
    expect(view.get('[data-testid="audio-settings-panel"]').attributes('hidden')).toBeDefined();
  });

  it('returns focus to reference selection after generation fails on the reference', async () => {
    service.generateAudio.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'audio-reference-invalid' }));
    const view = await ready();
    const focus = vi.spyOn(HTMLButtonElement.prototype, 'focus');
    await submit({ view });
    const browse = view.get<HTMLButtonElement>('[data-testid="audio-reference-browse"]');
    expect(browse.element.disabled).toBe(false);
    expect(focus.mock.contexts).toContain(browse.element);
    expect(view.get('[data-testid="audio-reference-panel"]').attributes('hidden')).toBeUndefined();
  });

  it('rejects stale success after Stop and aborts only its own request', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise);
    const view = await ready();
    await submit({ view });
    await view.get('[data-testid="audio-stop"]').trigger('click');
    expect(service.generateAudio.mock.calls[0]?.[0].cancellationSignal?.aborted).toBe(true);
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.release).not.toHaveBeenCalled();
    pending.resolve(audioResult());
    await flushPromises();
    expect(urls.create).not.toHaveBeenCalled();
    expect(view.find('[data-testid="audio-stopped"]').exists()).toBe(true);
  });

  it('aborts on navigation and ignores a success arriving after unmount', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise);
    const view = await ready();
    await submit({ view });
    view.unmount();
    wrapper = undefined;
    expect(service.generateAudio.mock.calls[0]?.[0].cancellationSignal?.aborted).toBe(true);
    expect(service.unsubscribe).toHaveBeenCalledOnce();
    pending.resolve(audioResult());
    await flushPromises();
    expect(urls.create).not.toHaveBeenCalled();
  });

  it('retains previous output URLs on new generation and revokes all on unmount', async () => {
    const view = await ready();
    await submit({ view });
    await submit({ view });
    expect(urls.revoke).not.toHaveBeenCalled();
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(2);
    view.unmount();
    wrapper = undefined;
    expect(urls.revoke).toHaveBeenCalledTimes(2);
  });

  it.each(['audio-model-unsupported', 'audio-reference-required', 'audio-reference-invalid', 'audio-output-empty', 'context-full'] as const)('shows a specific failure without producing audio: %s', async code => {
    service.generateAudio.mockRejectedValueOnce(new LlamaCppBrowserError({ code }));
    const view = await ready();
    await submit({ view });
    expect(view.get('[data-testid="audio-error"]').text()).toContain(code);
    expect(urls.create).not.toHaveBeenCalled();
  });

  it('rejects malformed WAV bytes even when the transport metadata is valid', async () => {
    const result = audioResult();
    result.wav[0] = 0;
    service.generateAudio.mockResolvedValueOnce(result);
    const view = await ready();
    await submit({ view });
    expect(view.find('[data-testid="audio-error"]').exists()).toBe(true);
    expect(urls.create).not.toHaveBeenCalled();
  });
});

it('distinguishes waveform decoding from frame generation without a misleading percent complete', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
  service.generateAudio.mockReturnValueOnce(pending.promise);
  const view = await ready();
  await submit({ view });
  notify({ state: { status: 'working', progress: { phase: 'decoding-audio', completed: 0, total: 0 } } });
  await nextTick();
  expect(view.get('[data-testid="audio-progress"]').text()).toContain('Decoding');
  expect(view.get('[data-testid="audio-progress"]').text()).not.toContain('%');
  pending.resolve(audioResult());
  await flushPromises();
});

describe('audio candidates and in-memory history in the view', () => {
  it('selects a metadata-detected model and offers the all-models override', async () => {
    detection.inspect.mockImplementation(async ({ modelId }) => modelId === 'user/chat'
      ? { status: 'unverified', reason: 'architecture' } : { status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' });
    wrapper = mount(AudioGenerationView);
    await loadInventory({ view: wrapper, entries: [{ modelId: 'user/chat', size: 10, importedAt: 1 }, { modelId: 'user/voice', size: 100, importedAt: 1 }], ready: true });
    const select = wrapper.getComponent(ModelSelector);
    expect(select.props('modelValue')).toBe('user/voice');
    expect(select.props('models').map(model => model.id)).toEqual(['user/voice']);
    await select.get('[data-testid="model-selector-trigger"]').trigger('click');
    const popup = new DOMWrapper(document.body).get('[data-testid="model-selector-dropdown"]');
    await popup.get('[data-testid="audio-all-models"]').setValue(true);
    expect(select.props('models').map(model => model.id)).toEqual(['user/chat', 'user/voice']);
    inventory.list.mockClear();
    await popup.get('[data-testid="model-selector-refresh"]').trigger('click');
    await flushPromises();
    expect(inventory.list).toHaveBeenCalledOnce();
    await popup.get('[data-testid="model-selector-option"][title="user/chat"]').trigger('click');
    await wrapper.get('[data-testid="audio-text"]').setValue('Unknown candidate');
    await submit({ view: wrapper });
    expect(service.generateAudio.mock.calls[0]![0].input.modelId).toBe('user/chat');
    expect(wrapper.get('[data-testid="audio-model-unverified"]').text()).not.toBe('');
  });

  it('keeps the escape hatch accessible when no metadata can be read', async () => {
    detection.inspect.mockRejectedValue(new Error('storage temporarily unavailable'));
    wrapper = mount(AudioGenerationView);
    await loadInventory({ view: wrapper, entries: [{ modelId: 'user/model', size: 100, importedAt: 1 }], ready: true });
    const select = wrapper.getComponent(ModelSelector);
    expect(select.props('modelValue')).toBe(defaultModelId);
    await select.get('[data-testid="model-selector-trigger"]').trigger('click');
    const popup = new DOMWrapper(document.body).get('[data-testid="model-selector-dropdown"]');
    await popup.get('[data-testid="model-selector-tabs"]').findAll('button')[1]!.trigger('click');
    await popup.get('[data-testid="audio-all-models"]').setValue(true);
    await popup.get('[data-testid="model-selector-option"][title="user/model"]').trigger('click');
    await nextTick();
    expect(select.props('modelValue')).toBe('user/model');
  });

  it('retains old audio during a pending generation, a failed attempt and invalid input', async () => {
    const view = await ready();
    await submit({ view });
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise);
    await submit({ view });
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    expect(urls.revoke).not.toHaveBeenCalled();
    pending.reject(new Error('failure'));
    await flushPromises();
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    await view.get('[data-testid="audio-text"]').setValue('');
    await submit({ view });
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    expect(urls.revoke).not.toHaveBeenCalled();
  });

  it('captures settings at submit rather than from the subsequently edited form', async () => {
    const view = await ready();
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise);
    service.getOptions.mockReturnValue({ profile: 'auto' });
    await view.get('[data-testid="audio-language"]').setValue('ja');
    await submit({ view });
    // Programmatic events can mutate a disabled input; delayed completion must
    // still use the submission snapshot, not the current reactive values.
    await view.get('[data-testid="audio-text"]').setValue('Changed after submit');
    await view.get('[data-testid="audio-language"]').setValue('de');
    pending.resolve(audioResult());
    await flushPromises();
    expect(view.get('[data-testid="audio-result-text"]').text()).toBe('Hello');
    expect(view.get('[data-testid="audio-result-language"]').text()).toContain('Japanese');
    expect(view.get('[data-testid="audio-result-settings"]').text()).toContain('4096');
    expect(view.get('[data-testid="audio-result-settings"]').text()).toContain('1024');
    expect(view.get('[data-testid="audio-result-settings"]').text()).toContain('Random');
    await view.get('[data-testid="audio-text"]').setValue('Second text');
    await submit({ view });
    expect(view.findAll('[data-testid="audio-result-text"]').map(e => e.text())).toEqual(['Second text', 'Hello']);
  });

  it('deletes one result or all results, stops players and permits deletion during generation', async () => {
    urls.create.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second').mockReturnValueOnce('blob:third');
    const view = await ready();
    await submit({ view });
    await submit({ view });
    await view.findAll('[data-testid="audio-delete"]')[1]!.trigger('click');
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    expect(urls.revoke).toHaveBeenCalledWith('blob:first');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise);
    await submit({ view });
    await view.get('[data-testid="audio-delete-all"]').trigger('click');
    expect(view.find('[data-testid="audio-history"]').exists()).toBe(false);
    pending.resolve(audioResult());
    await flushPromises();
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    expect(view.get('[data-testid="audio-player"]').attributes('src')).toBe('blob:third');
  });

  it('does not clear completed history when a later generation is stopped', async () => {
    const view = await ready();
    await submit({ view });
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise);
    await submit({ view });
    await view.get('[data-testid="audio-stop"]').trigger('click');
    pending.resolve(audioResult());
    await flushPromises();
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    expect(urls.create).toHaveBeenCalledOnce();
  });

  it('uses the larger step cap without changing context default or retaining obsolete wording', async () => {
    const view = await ready();
    expect(view.get<HTMLInputElement>('[data-testid="audio-max-frames"]').element.value).toBe('1024');
    expect(view.get<HTMLInputElement>('[data-testid="audio-context"]').element.value).toBe('4096');
    await setLocale({ locale: 'ja' });
    await flushPromises();
    expect(view.text()).not.toContain('8192は全モデル共通の上限ではありません');
  });
});

describe('non-destructive runtime recovery in the audio workspace', () => {
  it('re-enables generation after a failed runtime is checked again without losing results or input', async () => {
    const view = await ready();
    await submit({ view });
    service.generateAudio.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'worker-failed' }));
    await submit({ view });
    const runtime = view.getComponent({ name: 'LlamaCppBrowserRuntimeSettings' });
    runtime.vm.$emit('runtimeReady', false);
    notify({ state: { status: 'error', code: 'worker-failed' } });
    await nextTick();
    expect(view.get('[data-testid="audio-generate"]').attributes('disabled')).toBeDefined();
    const pending = Promise.withResolvers<Awaited<ReturnType<LlamaCppBrowserService['restartRuntime']>>>();
    service.restartRuntime.mockReturnValueOnce(pending.promise);
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click');
    expect(view.get('[data-testid="audio-restart-runtime"]').attributes('disabled')).toBeDefined();
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    pending.resolve({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
    runtime.vm.$emit('runtimeReady', true);
    notify({ state: { status: 'idle' } });
    await flushPromises();
    expect(view.get('[data-testid="audio-generate"]').attributes('disabled')).toBeUndefined();
    expect(view.get<HTMLTextAreaElement>('[data-testid="audio-text"]').element.value).toBe('Hello');
    expect(view.find('[data-testid="audio-error"]').exists()).toBe(false);
    expect(service.generateAudio).toHaveBeenCalledTimes(2);
    expect(urls.revoke).not.toHaveBeenCalled();
    await submit({ view });
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(2);
  });

  it('keeps reinitialization failures visible and allows another explicit attempt', async () => {
    const view = await ready();
    service.restartRuntime.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'unavailable' }));
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click');
    await flushPromises();
    expect(view.get('[data-testid="audio-error"]').text()).toContain('unavailable');
    expect(view.get('[data-testid="audio-restart-runtime"]').attributes('disabled')).toBeUndefined();
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click');
    await flushPromises();
    expect(service.restartRuntime).toHaveBeenCalledTimes(2);
  });

  it('does not restart while another operation is working', async () => {
    const view = await ready();
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 2 } } });
    await nextTick();
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click');
    expect(service.restartRuntime).not.toHaveBeenCalled();
    expect(service.release).not.toHaveBeenCalled();
  });

  it('detaches only its recovery observer when the route is left', async () => {
    const view = await ready();
    const pending = Promise.withResolvers<Awaited<ReturnType<LlamaCppBrowserService['restartRuntime']>>>();
    service.restartRuntime.mockReturnValueOnce(pending.promise);
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click');
    view.unmount();
    wrapper = undefined;
    expect(service.restartRuntime.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(service.release).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
    pending.reject(new Error('late recovery failure'));
    await flushPromises();
  });
});

describe('finish partial audio without discarding history', () => {
  it('enables finishing only after a frame and records the partial result with original settings', async () => {
    const view = await ready();
    await submit({ view });
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view });
    expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(true);
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 1024 } } });
    await nextTick();
    expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(false);
    await view.get('[data-testid="audio-finish"]').trigger('click');
    const args = service.generateAudio.mock.calls[1]![0];
    expect(args.completionSignal?.aborted).toBe(true);
    expect(args.cancellationSignal?.aborted).toBe(false);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(true);
    notify({ state: { status: 'working', progress: { phase: 'decoding-audio', completed: 0, total: 0 } } });
    await nextTick();
    expect(view.get<HTMLButtonElement>('[data-testid="audio-stop"]').element.disabled).toBe(false);
    gate.resolve({ ...audioResult(), finishReason: 'user-stop' });
    await flushPromises();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(2);
    expect(view.findAll('[data-testid="audio-finished-early"]')).toHaveLength(1);
    expect(view.findAll('[data-testid="audio-truncated"]')).toHaveLength(0);
  });

  it('keeps the older result and discards the pending one when cancelled after finish', async () => {
    const view = await ready();
    await submit({ view });
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view });
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 1024 } } });
    await nextTick();
    await view.get('[data-testid="audio-finish"]').trigger('click');
    await view.get('[data-testid="audio-stop"]').trigger('click');
    gate.resolve({ ...audioResult(), finishReason: 'user-stop' });
    await flushPromises();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(1);
    expect(service.generateAudio.mock.calls[1]![0].cancellationSignal?.aborted).toBe(true);
  });
});

it('can cancel pending browser reference decoding before entering the inference service', async () => {
  const gate = Promise.withResolvers<Blob | undefined>();
  const prepare = vi.spyOn(referencePreparation, 'prepareReferenceAudio').mockReturnValueOnce(gate.promise);
  const view = await ready();
  await submit({ view });
  expect(prepare).toHaveBeenCalledOnce();
  expect(service.generateAudio).not.toHaveBeenCalled();
  expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(true);
  await view.get('[data-testid="audio-stop"]').trigger('click');
  expect(prepare.mock.calls[0]![0].signal?.aborted).toBe(true);
  gate.resolve(undefined);
  await flushPromises();
  expect(service.generateAudio).not.toHaveBeenCalled();
  expect(view.get<HTMLButtonElement>('[data-testid="audio-generate"]').element.disabled).toBe(false);
  await submit({ view });
  expect(service.generateAudio).toHaveBeenCalledOnce();
});

describe('catalog placement and continuing previews', () => {
  it('offers the audio catalog, saved models, Hugging Face and file imports in one picker', async () => {
    wrapper = mount(AudioGenerationView);
    await flushPromises();
    const picker = wrapper.getComponent(ModelSelector);
    expect(wrapper.findComponent(LlamaCppBrowserRepositoryPicker).exists()).toBe(false);
    await picker.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const popup = new DOMWrapper(document.body).get('[data-testid="model-selector-dropdown"]');
    const tabs = popup.get('[data-testid="model-selector-tabs"]').findAll('button');
    expect(tabs.map(tab => tab.attributes('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    const catalog = picker.getComponent(LlamaCppBrowserRepositoryPicker);
    expect(catalog.props('suggestions')).toEqual(audioModelCatalog);
    expect(catalog.props('layout')).toBe('candidate-results');
    expect(popup.text()).toContain('Qwen3-TTS 0.6B Base');
    expect(popup.text()).toContain('Qwen3-TTS 1.7B Base');
    expect(popup.text()).not.toContain('Gemma');
    await tabs[2]!.trigger('click');
    await flushPromises();
    expect(picker.findAllComponents(LlamaCppBrowserRepositoryPicker).some(source => source.props('layout') === 'inline-results' && !source.props('disabled'))).toBe(true);
    await tabs[3]!.trigger('click');
    await flushPromises();
    const files = picker.getComponent(ModelSelectorFileImport);
    const imported = { modelId: '~user/voice', size: 100, importedAt: 1 };
    expect(picker.props('modelValue')).toBe(defaultModelId);
    inventory.list.mockResolvedValue([imported]);
    files.vm.$emit('update:added', [imported]);
    files.vm.$emit('inventory-changed');
    await flushPromises();
    expect(picker.props('models').some(option => option.id === imported.modelId)).toBe(true);
    await files.get('button[aria-label="~user/voice"]').trigger('click');
    await flushPromises();
    expect(picker.props('modelValue')).toBe(imported.modelId);
    expect(service.generateAudio).not.toHaveBeenCalled();

    await picker.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const reopened = new DOMWrapper(document.body).get('[data-testid="model-selector-dropdown"]');
    await reopened.get('[data-testid="model-selector-tabs"]').findAll('button')[3]!.trigger('click');
    await flushPromises();
    const reopenedFiles = picker.getComponent(ModelSelectorFileImport);
    expect(reopenedFiles.find('button[aria-label="~user/voice"]').exists()).toBe(true);

    const saved = { ...imported, modelId: 'user/voice' };
    const savedId = vi.spyOn(localRepositories, 'savedModelId').mockImplementation(({ modelId }) => modelId === imported.modelId ? saved.modelId : modelId);
    using restoreSavedId = { [Symbol.dispose]: () => savedId.mockRestore() };
    void restoreSavedId;
    inventory.list.mockResolvedValue([saved]);
    inventory.subscribe.mock.calls[0]![0].listener();
    await flushPromises();
    expect(reopenedFiles.find('button[aria-label="~user/voice"]').exists()).toBe(false);
    expect(reopenedFiles.find('button[aria-label="user/voice"]').exists()).toBe(true);

    // File Explorer refreshes the inventory after a model's files are removed.
    inventory.list.mockResolvedValue([]);
    inventory.subscribe.mock.calls[0]![0].listener();
    await flushPromises();
    expect(reopenedFiles.find('button[aria-label="user/voice"]').exists()).toBe(false);
  });

  it('adds repeated previews with their actual step counts and original settings without ending the request', async () => {
    const view = await ready();
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view });
    expect(view.get<HTMLButtonElement>('[data-testid="audio-preview"]').element.disabled).toBe(true);
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 20, total: 1024 } } });
    await nextTick();
    await view.get('[data-testid="audio-preview"]').trigger('click');
    const args = service.generateAudio.mock.calls[0]![0];
    expect(args.preview!.requests.version).toBe(1);
    expect(args.cancellationSignal?.aborted).toBe(false);
    expect(args.completionSignal?.aborted).toBe(false);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-preview"]').element.disabled).toBe(true);
    await view.get('[data-testid="audio-text"]').setValue('Later edits do not change the request');
    await args.preview!.onPreview({ event: { requestVersion: 1, result: { ...audioResult(), frames: 72, finishReason: 'preview' } } });
    await nextTick();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(1);
    expect(view.get('[data-testid="audio-result-steps"]').text()).toBe('72');
    expect(view.get('[data-testid="audio-result-text"]').text()).toBe('Hello');
    expect(view.find('[data-testid="audio-preview-result"]').exists()).toBe(true);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-preview"]').element.disabled).toBe(false);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-generate"]').element.disabled).toBe(true);
    await view.get('[data-testid="audio-preview"]').trigger('click');
    await args.preview!.onPreview({ event: { requestVersion: 2, result: { ...audioResult(), frames: 144, finishReason: 'preview' } } });
    await nextTick();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(2);
    gate.resolve({ ...audioResult(), frames: 200 });
    await flushPromises();
    expect(view.findAll('[data-testid="audio-result-steps"]').map(node => node.text())).toEqual(['200', '144', '72']);
    expect(view.findAll('[data-testid="audio-preview-result"]')).toHaveLength(2);
    expect(service.generateAudio).toHaveBeenCalledOnce();
  });

  it('keeps already accepted previews when cancelled and ignores late output after cancellation or unmount', async () => {
    const view = await ready();
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view });
    const args = service.generateAudio.mock.calls[0]![0];
    await args.preview!.onPreview({ event: { requestVersion: 1, result: { ...audioResult(), frames: 72, finishReason: 'preview' } } });
    await nextTick();
    await view.get('[data-testid="audio-stop"]').trigger('click');
    await args.preview!.onPreview({ event: { requestVersion: 2, result: { ...audioResult(), frames: 144, finishReason: 'preview' } } });
    gate.resolve({ ...audioResult(), frames: 200 });
    await flushPromises();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(1);
    const created = urls.create.mock.calls.length;
    view.unmount();
    wrapper = undefined;
    await args.preview!.onPreview({ event: { requestVersion: 3, result: { ...audioResult(), frames: 216, finishReason: 'preview' } } });
    expect(urls.create).toHaveBeenCalledTimes(created);
    expect(urls.revoke).toHaveBeenCalledOnce();
  });
});
