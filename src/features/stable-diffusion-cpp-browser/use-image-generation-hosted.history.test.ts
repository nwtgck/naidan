import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { Request } from './types';
import type { ImageGenerationView } from './use-image-generation-types';
import type { ImageClient } from './worker/types';
import { artifactFixture, ggufFile, parametersFixture, requestFixture } from './test-fixtures';
import { engineSnapshotFixture } from './test-utils/engine-state';
import type { ImageEngineInspection } from './engine-state';
import { snapshotImageGeneration, finishImageGenerationSnapshot } from './history/snapshot';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationEditor from './components/ImageGenerationEditor.vue';
import ImageGenerationResults from './components/ImageGenerationResults.vue';
import ImageGenerationProgress from './components/ImageGenerationProgress.vue';
const mocks = vi.hoisted(() => {
  const models: Request['models'] = [];
  let selection: ({ family, turbo }: { family: 'z-image', turbo: boolean }) => void = () => {};
  return { generate: vi.fn(), inspectEngine: vi.fn(), cancel: vi.fn(), release: vi.fn(), dispose: vi.fn(), save: vi.fn(), remove: vi.fn(), removeBinary: vi.fn(), getFile: vi.fn(), query: vi.fn(), prepareFiles: vi.fn(), downloadBlob: vi.fn(), download: vi.fn(), setTransfer: vi.fn(), models,
    storageType: 'opfs', listeners: new Set<({ event }: { event: { type: 'migration', timestamp: number } }) => void>(),
    select(value: { family: 'z-image', turbo: boolean }) {
      selection(value);
    },
    selection(callback: typeof selection) {
      selection = callback;
    },
  };
});
const preferenceSettings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } });
const preferencesInitialized = ref(false);
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: preferenceSettings, initialized: preferencesInitialized, updateExperimental: vi.fn() }) }));
vi.mock('@/00-storage/service', () => ({ storageService: {
  getCurrentType: () => mocks.storageType,
  subscribeToChanges: ({ listener }: { listener: ({ event }: { event: { type: 'migration', timestamp: number } }) => void }) => {
    mocks.listeners.add(listener); return () => {
      mocks.listeners.delete(listener);
    };
  },
  saveImageGeneration: (...args: unknown[]) => mocks.save(...args),
  deleteImageGeneration: (...args: unknown[]) => mocks.remove(...args),
  deleteBinaryObject: (...args: unknown[]) => mocks.removeBinary(...args),
  getFile: (...args: unknown[]) => mocks.getFile(...args),
} }));
vi.mock('./history/worker/client-hosted', () => ({ createImageHistoryClient: () => ({ query: mocks.query, async dispose() {} }) }));
vi.mock('./capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify', supportsJspi: () => false, supportsMemory64: () => false }));
vi.mock('./inventory-worker/client', () => ({ inspectImageInventory: vi.fn() }));
vi.mock('./worker/client', () => ({ createImageClient: () => ({ generate: mocks.generate, inspectEngine: mocks.inspectEngine, release: mocks.release, dispose: mocks.dispose, cancel: mocks.cancel, updatePreview() {} }) }));
vi.mock('./history/download', () => ({ imageGenerationDownloadBlob: (...args: unknown[]) => mocks.downloadBlob(...args), downloadImageBlob: (...args: unknown[]) => mocks.download(...args) }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', async () => {
  const { artifactFixture } = await import('./test-fixtures');
  return { default: { kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [artifactFixture()] } };
});
vi.mock('./use-image-library', async () => {
  const { createDisabledImageLibrary } = await import('./library-standalone');
  return { useImageLibrary: ({ onSelection }: { onSelection: ({ family, turbo }: { family: 'z-image', turbo: boolean }) => void }) => {
    mocks.selection(onSelection);
    const library = createDisabledImageLibrary(); library.main.value = 'selected';
    const transfers = { importing: ref(false), downloading: ref(false) };
    mocks.setTransfer.mockImplementation(({ operation, active }: { operation: keyof typeof transfers, active: boolean }) => {
      transfers[operation].value = active;
    });
    return { ...library, ...transfers, ready: computed(() => true), selectedModels: () => mocks.models,
      selectedFacts: computed(() => ({ family: 'z-image', variant: 'turbo', evidence: [] })),
      prepareHistoryFiles: () => mocks.prepareFiles(),
      restoreModelSelection() {
        library.main.value = 'missing-primary';
        return { loras: [], missing: ['missing.gguf'], missingInactive: [] };
      },
      chooseMain({ id }: { id: string }) {
        library.main.value = id;
      },
      useManualFiles() {
        library.main.value = '';
      },
      historyFileLocation({ file }: { file: File }) {
        return { type: 'opfs', name: file.name, size: file.size, lastModified: file.lastModified, path: `models/user/example/${file.name}` };
      },
      findHistoryFile({ location }: { location: { name: string } }) {
        return mocks.models.find(model => model.file.name === location.name)?.file;
      },
    };
  } };
});
import { useImageGeneration } from './use-image-generation-hosted';
let wrapper: VueWrapper | undefined;
let editor: VueWrapper | undefined;
let resultsPanel: VueWrapper | undefined;
let active: ImageGenerationView | undefined;
function open(): ImageGenerationView {
  wrapper = mount(defineComponent({ setup() {
    active = useImageGeneration(); return () => h('div');
  } }));
  if (!active) throw new Error('Missing image owner');
  active.parameters.value = parametersFixture();
  return active;
}
function result() {
  return { png: new Blob(['final'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false };
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  preferencesInitialized.value = false;
  preferenceSettings.value = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } };
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.storageType = 'opfs'; mocks.models = [{ slot: 'model', file: ggufFile() }];
  mocks.query.mockResolvedValue({ items: [], total: 0, warnings: [], warningCount: 0 }); mocks.save.mockResolvedValue(undefined); mocks.generate.mockResolvedValue(result());
  mocks.inspectEngine.mockReset().mockResolvedValue({ status: 'ready', snapshot: engineSnapshotFixture() });
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.prepareFiles.mockResolvedValue(undefined);
  mocks.downloadBlob.mockResolvedValue(new Blob(['download copy'], { type: 'image/png' }));
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('OffscreenCanvas', class {}); vi.stubGlobal('DecompressionStream', class {});
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:test'); static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  editor?.unmount(); editor = undefined;
  resultsPanel?.unmount(); resultsPanel = undefined;
  wrapper?.unmount(); wrapper = undefined; active = undefined; vi.unstubAllGlobals();
});

describe('hosted image history integration with a synthetic inference client', () => {
  it('keeps the running request, result and saved/exported metadata fixed while editing the next request', async () => {
    const view = open(); view.retainModel.value = true; view.seedMode.value = 'fixed';
    const accepted = { ...view.parameters.value };
    const inference = Promise.withResolvers<ReturnType<typeof result>>(), saving = Promise.withResolvers<void>();
    mocks.generate.mockImplementationOnce(({ onProgress }: Parameters<ImageClient['generate']>[0]) => {
      onProgress({ event: { phase: 'model', step: 0, steps: 0 } }); return inference.promise;
    });
    mocks.save.mockReturnValueOnce(saving.promise);
    editor = mount(ImageGenerationEditor, { props: { view, active: true } });
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    const generation = view.generate(); await flushPromises();
    const request: Request = mocks.generate.mock.calls[0]![0].request;
    mocks.release.mockClear();
    expect(view.formDisabled.value).toBe(true); expect(view.draftDisabled.value).toBe(false);
    const edits = [
      { key: 'prompt', value: 'next prompt' }, { key: 'negative-prompt', value: 'next negative' },
      { key: 'width', value: 512 }, { key: 'height', value: 768 }, { key: 'steps', value: 12 },
      { key: 'guidance', value: 3 }, { key: 'distilled-guidance', value: 2 },
      { key: 'sampler', value: 'euler' }, { key: 'scheduler', value: 'karras' }, { key: 'seed', value: '99' },
    ];
    for (const { key, value } of edits) await editor.get(`[data-testid="image-${key}"]`).setValue(value);
    await resultsPanel.get('[data-testid="image-save-history"]').setValue(false);
    expect(resultsPanel.get('[data-testid="image-history-next-generation"]').text()).toContain('next generation');
    expect(request.parameters).toEqual(accepted);
    mocks.generate.mock.calls[0]![0].onProgress({ event: { phase: 'sampling', step: 1, steps: accepted.steps } });
    await flushPromises();
    expect(resultsPanel.getComponent(ImageGenerationProgress).props()).toMatchObject({ width: accepted.width, height: accepted.height, progress: { step: 1, steps: accepted.steps } });
    expect(mocks.release).not.toHaveBeenCalled();
    await view.generate(); expect(mocks.generate).toHaveBeenCalledOnce();
    inference.resolve(result()); await flushPromises();
    expect(view.busy.value).toBe(true); expect(view.progress.value).toBeUndefined();
    expect(view.historySaving.status.value).toBe('saving');
    expect(mocks.save.mock.calls[0]![0].record.request.parameters).toEqual(accepted);
    expect(view.results.value[0]!.parameters).toEqual(accepted);
    expect(resultsPanel.get('[data-testid="image-generated-result"]').text()).toContain(`Seed: ${accepted.seed}`);
    await editor.get('[data-testid="image-prompt"]').setValue('draft during save');
    await editor.get('[data-testid="image-width"]').setValue(640);
    for (const format of ['png', 'webp', 'jpeg'] as const) {
      await view.downloadResult({ resultId: view.results.value[0]!.id, format, includeMetadata: true });
      expect(mocks.downloadBlob.mock.calls.at(-1)![0]).toMatchObject({ request: { parameters: accepted }, format, includeMetadata: true });
    }
    saving.resolve(); await generation;
    expect(view.parameters.value.prompt).toBe('draft during save');
    expect(view.parameters.value.seed).toBe('99');
    const next = { ...view.parameters.value }; await view.generate();
    expect(mocks.generate.mock.calls[1]![0].request.parameters).toEqual(next);
    expect(mocks.save).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'cancelled'] as const)('does not roll back the next draft when the active run is %s', async outcome => {
    const view = open(); view.seedMode.value = 'fixed';
    const accepted = { ...view.parameters.value };
    const inference = Promise.withResolvers<Awaited<ReturnType<ImageClient['generate']>>>();
    mocks.generate.mockReturnValueOnce(inference.promise);
    const generation = view.generate();
    view.parameters.value.prompt = 'keep next prompt'; view.parameters.value.seed = '77';
    if (outcome === 'failed') inference.reject(new Error('Native generation failed'));
    else {
      view.cancel(); inference.resolve({ cancelled: true, modelResident: true });
    }
    await generation;
    expect(mocks.generate.mock.calls[0]![0].request.parameters).toEqual(accepted);
    expect(view.parameters.value).toMatchObject({ prompt: 'keep next prompt', seed: '77' });
    expect(view.draftDisabled.value).toBe(false); expect(view.busy.value).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('observes only an existing idle model and drops observations after explicit release', async () => {
    const view = open(); view.retainModel.value = true;
    view.engineState.setOpened({ opened: true });
    expect(view.engineState.reason.value).toBe('not-loaded');
    expect(mocks.inspectEngine).not.toHaveBeenCalled();
    view.engineState.setOpened({ opened: false });
    await view.generate();
    expect(mocks.inspectEngine).not.toHaveBeenCalled();
    view.engineState.setOpened({ opened: true }); await flushPromises();
    expect(view.engineState.snapshot.value?.modelVersion).toBe(engineSnapshotFixture().modelVersion);
    const pending = Promise.withResolvers<Awaited<ReturnType<ImageClient['generate']>>>();
    mocks.generate.mockImplementationOnce(({ onProgress }: Parameters<ImageClient['generate']>[0]) => {
      onProgress({ event: { phase: 'sampling', step: 1, steps: 8 } }); return pending.promise;
    });
    const generation = view.generate(); await flushPromises();
    await view.engineState.refresh(); expect(mocks.inspectEngine).toHaveBeenCalledOnce();
    expect(view.engineState.snapshot.value?.collectedAt).toBe(engineSnapshotFixture().collectedAt);
    pending.resolve(result()); await generation; await flushPromises();
    expect(mocks.inspectEngine).toHaveBeenCalledTimes(2);
    const inspection = Promise.withResolvers<ImageEngineInspection>(); mocks.inspectEngine.mockReturnValueOnce(inspection.promise);
    const reading = view.engineState.refresh(); view.releaseModel();
    inspection.resolve({ status: 'ready', snapshot: engineSnapshotFixture() }); await reading;
    expect(view.engineState.snapshot.value).toBeUndefined();
    expect(view.modelResident.value).toBe(false);
  });
  it.each(['cooperative', 'forced'] as const)('keeps prior results distinct after %s cancellation during decoding', async mode => {
    const view = open();
    await view.generate();
    const previous = view.results.value[0]!;
    const pending = Promise.withResolvers<Awaited<ReturnType<ImageClient['generate']>>>();
    mocks.generate.mockImplementationOnce(({ onProgress }: Parameters<ImageClient['generate']>[0]) => {
      onProgress({ event: { phase: 'decoding', step: 8, steps: 8 } });
      return pending.promise;
    });
    editor = mount(ImageGenerationEditor, { props: { view, active: true } });
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    const generation = view.generate();
    await flushPromises();
    await editor.get('[data-testid="image-cancel"]').trigger('click');
    expect(mocks.cancel).toHaveBeenCalledOnce();
    if (mode === 'forced') {
      await editor.get('[data-testid="image-force-cancel"]').trigger('click');
      // A native completion racing with forced cancellation must not publish
      // its image or replace the cancellation presentation.
      pending.resolve(result());
    } else pending.resolve({ cancelled: true, modelResident: true });
    await generation;
    await flushPromises();
    expect(view.results.value.map(result => result.id)).toEqual([previous.id]);
    expect(resultsPanel.get('[data-testid="image-cancelled-result"]').text()).toContain('Generation cancelled.');
    expect(resultsPanel.get('[data-testid="image-previous-results"]').text()).toBe('Previous results');
    expect(resultsPanel.find('[data-testid="image-failure-diagnostics"]').exists()).toBe(false);
    expect(resultsPanel.find('[data-testid="image-failed-result"]').exists()).toBe(false);
    expect(resultsPanel.find('[data-testid="image-pending-result"]').exists()).toBe(false);
    await resultsPanel.setProps({ active: false });
    await resultsPanel.setProps({ active: true });
    expect(resultsPanel.find('[data-testid="image-cancelled-result"]').exists()).toBe(true);
    await view.generate();
    await flushPromises();
    expect(view.results.value).toHaveLength(2);
    expect(view.results.value[1]?.id).toBe(previous.id);
    expect(resultsPanel.find('[data-testid="image-cancelled-result"]').exists()).toBe(false);
    expect(resultsPanel.find('[data-testid="image-previous-results"]').exists()).toBe(false);
  });
  it('keeps the failed run visible above prior images across pane remounts and replaces it on the next run', async () => {
    const view = open();
    await view.generate();
    const previous = view.results.value[0]!;
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    const file = ggufFile();
    mocks.models = [{ slot: 'model', file }];
    view.parameters.value.prompt = 'Another model and prompt';
    view.preview.value.enabled = true;
    mocks.generate.mockImplementationOnce(async ({ onPreview }) => {
      onPreview({ frame: { type: 'naidan-image-preview-v1', runId: 2, revision: 0, step: 2, steps: 8, width: 128, height: 128,
        mode: 'vae', png: new Blob(['partial image'], { type: 'image/png' }) } });
      throw new Error('VAE decoding failed');
    });
    await view.generate();
    await flushPromises();
    expect(mocks.generate.mock.calls[1]?.[0].request.models[0].file).toBe(file);
    expect(resultsPanel.get('[data-testid="image-failed-result"]').text()).toContain('Image generation failed');
    expect(resultsPanel.get('[data-testid="image-previous-results"]').text()).toBe('Previous results');
    expect(resultsPanel.find('[data-testid="image-pending-result"]').exists()).toBe(false);
    expect(view.results.value.map(result => result.id)).toEqual([previous.id]);
    expect(resultsPanel.get('[data-testid="image-live-preview"]').text()).toContain('unfinished');
    view.parameters.value.steps = NaN;
    await view.generate();
    expect(view.invalid.value).toBe(true);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    view.parameters.value.prompt = 'Editing must not relabel the failed run';
    await resultsPanel.setProps({ active: false });
    await resultsPanel.setProps({ active: true });
    resultsPanel.unmount();
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    expect(resultsPanel.find('[data-testid="image-failed-result"]').exists()).toBe(true);
    const diagnostics = resultsPanel.get('[data-testid="image-diagnostics-region"]');
    const scroll = vi.fn();
    Object.defineProperty(diagnostics.element, 'scrollIntoView', { value: scroll });
    await resultsPanel.get('[data-testid="image-failure-diagnostics"]').trigger('click');
    await flushPromises();
    expect(resultsPanel.get('[data-testid="image-live-diagnostics"]').attributes()).toHaveProperty('open');
    expect(diagnostics.text()).toContain('VAE decoding failed');
    expect(scroll).toHaveBeenCalledOnce();
    view.parameters.value.steps = 8;
    const next = Promise.withResolvers<ReturnType<typeof result>>();
    mocks.generate.mockReturnValueOnce(next.promise);
    const generation = view.generate();
    await flushPromises();
    expect(resultsPanel.find('[data-testid="image-failed-result"]').exists()).toBe(false);
    expect(resultsPanel.find('[data-testid="image-pending-result"]').exists()).toBe(true);
    next.resolve(result());
    await generation;
    await flushPromises();
    expect(resultsPanel.find('[data-testid="image-failed-result"]').exists()).toBe(false);
    expect(resultsPanel.find('[data-testid="image-previous-results"]').exists()).toBe(false);
    expect(view.results.value).toHaveLength(2);
  });
  it('distinguishes invalid inputs, cancellation and save failure from inference failure', async () => {
    const view = open();
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    view.parameters.value.steps = NaN;
    await view.generate();
    await flushPromises();
    expect(view.invalid.value).toBe(true);
    expect(resultsPanel.find('[data-testid="image-failed-result"]').exists()).toBe(false);
    view.parameters.value.steps = 8;
    view.preview.value.enabled = true;
    mocks.generate.mockImplementationOnce(async ({ onPreview }) => {
      onPreview({ frame: { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 1, steps: 8, width: 128, height: 128,
        mode: 'vae', png: new Blob(['partial image'], { type: 'image/png' }) } });
      return { cancelled: true, modelResident: true };
    });
    await view.generate();
    await flushPromises();
    expect(view.cancelled.value).toBe(true);
    expect(resultsPanel.find('[data-testid="image-failed-result"]').exists()).toBe(false);
    expect(resultsPanel.get('[data-testid="image-live-preview"]').text()).toContain('cancelled generation');
    mocks.save.mockRejectedValueOnce(new Error('No space left'));
    await view.generate();
    await flushPromises();
    expect(view.historySaving.status.value).toBe('failed');
    expect(resultsPanel.find('[data-testid="image-failed-result"]').exists()).toBe(false);
    expect(resultsPanel.find('[data-testid="image-generated-result"]').exists()).toBe(true);
  });
  it('keeps disabled LoRA choices in the editor and history while excluding them from inference', async () => {
    const view = open();
    const file = mocks.models[0]!.file;
    const unavailable = new File(['unreadable adapter fixture'], 'unavailable.gguf');
    const read = vi.spyOn(unavailable, 'slice').mockImplementation(() => {
      throw new Error('The adapter is unreadable');
    });
    view.loras.value = [
      { file, path: 'first.gguf', strength: 0.5, enabled: true },
      { file: unavailable, strength: -0.75, enabled: true },
      { file, path: 'zero.gguf', strength: 0, enabled: true },
    ];
    editor = mount(ImageGenerationEditor, { props: { view, active: true } });
    await editor.findAll('[data-testid="image-lora-enabled"]')[1]!.setValue(false);
    await view.generate();
    expect(view.invalid.value).toBe(false);
    expect(mocks.generate.mock.calls[0]?.[0].request.loras).toEqual([
      { file, path: 'first.gguf', strength: 0.5 }, { file, path: 'zero.gguf', strength: 0 },
    ]);
    expect(mocks.save.mock.calls[0]?.[0].record.request.loras.map((lora: { path: string, strength: number }) => [lora.path, lora.strength])).toEqual([
      ['first.gguf', 0.5], ['unavailable.gguf', 0], ['zero.gguf', 0],
    ]);
    expect(view.loras.value[1]).toEqual({ file: unavailable, strength: -0.75, enabled: false });
    expect(read).not.toHaveBeenCalled();
    await editor.findAll('[data-testid="image-lora-enabled"]')[1]!.setValue(true);
    await view.generate();
    expect(mocks.generate.mock.calls[1]?.[0].request.loras).toEqual([
      { file, path: 'first.gguf', strength: 0.5 }, { file: unavailable, strength: -0.75 }, { file, path: 'zero.gguf', strength: 0 },
    ]);
    expect(mocks.save.mock.calls[1]?.[0].record.request.loras[1].strength).toBe(-0.75);
  });
  it('does not reject generation or history capture for an invalid disabled adapter selection', async () => {
    const view = open();
    const file = new File([], 'empty.gguf');
    view.loras.value = [{ file, strength: NaN, enabled: false }];
    await view.generate();
    expect(view.invalid.value).toBe(false);
    expect(mocks.generate.mock.calls[0]?.[0].request.loras).toEqual([]);
    expect(mocks.save.mock.calls[0]?.[0].record.request.loras).toEqual([
      { path: file.name, strength: 0, file: { type: 'opfs', name: file.name, size: 0, lastModified: file.lastModified, path: `models/user/example/${file.name}` } },
    ]);
    expect(view.loras.value[0]).toEqual({ file, strength: NaN, enabled: false });
    view.loras.value = [{ file, strength: NaN, enabled: true }];
    await view.generate();
    expect(view.invalid.value).toBe(true);
    expect(mocks.generate).toHaveBeenCalledOnce();
  });
  it('does not acquire diagnostics ownership while a history image is being prepared', async () => {
    const view = open();
    await view.generate();
    const record = mocks.save.mock.calls[0]![0].record;
    const pending = Promise.withResolvers<Blob>();
    mocks.getFile.mockReturnValueOnce(pending.promise);
    const preparing = view.useHistoryImage({ binaryObjectId: record.result.binaryObjectId, role: 'initial' });
    expect(view.historyActions.busy.value).toBe(true);
    expect(view.acquireBenchmark()).toBe(false);
    pending.resolve(new Blob(['input'], { type: 'image/png' }));
    await preparing;
    expect(view.imageInputs.value.initImage).toBeDefined();
    expect(view.acquireBenchmark()).toBe(true);
    expect(view.acquireBenchmark()).toBe(false);
    view.releaseBenchmark();
    expect(view.formDisabled.value).toBe(false);
  });

  it.each(['importing', 'downloading'] as const)('only blocks conflicting history image actions while model files are %s', async operation => {
    const view = open();
    await view.generate();
    const record = mocks.save.mock.calls[0]![0].record;
    mocks.setTransfer({ operation, active: true });
    mocks.getFile.mockResolvedValue(new Blob(['reference'], { type: 'image/png' }));
    await view.useHistoryImage({ binaryObjectId: record.result.binaryObjectId, role: 'reference' });
    expect(mocks.getFile).toHaveBeenCalledTimes(operation === 'importing' ? 0 : 1);
    expect(view.historyActions.busy.value).toBe(false);
    expect(view.imageInputs.value.referenceImages).toHaveLength(operation === 'importing' ? 0 : 1);
    mocks.setTransfer({ operation, active: false });
    mocks.getFile.mockResolvedValueOnce(new Blob(['reference'], { type: 'image/png' }));
    await view.useHistoryImage({ binaryObjectId: record.result.binaryObjectId, role: 'reference' });
    expect(mocks.getFile).toHaveBeenCalledTimes(operation === 'importing' ? 1 : 2);
    expect(view.imageInputs.value.referenceImages).toHaveLength(operation === 'importing' ? 1 : 2);
  });

  it('clears an earlier generation save error when its explicit retry succeeds without regenerating either image', async () => {
    mocks.save.mockRejectedValueOnce(new Error('First save failed')).mockRejectedValueOnce(new Error('Earlier save is still unavailable'));
    const view = open();
    await view.generate();
    await view.generate();
    const results = [...view.results.value];
    expect(view.historySaving.status.value).toBe('saved');
    expect(view.historySaving.pendingCount.value).toBe(1);
    expect(view.historyActions.error.value).toBe('Earlier save is still unavailable');
    await view.historySaving.retry();
    expect(view.historySaving.pendingCount.value).toBe(0);
    expect(view.historyActions.error.value).toBe('');
    expect(view.historySaving.status.value).toBe('saved');
    expect(view.results.value).toEqual(results);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    for (const result of results) expect(view.savedHistoryId({ resultId: result.id })).toBeDefined();
  });

  it('clears save retry feedback only when a retry starts and preserves a newer action error received while saving', async () => {
    const view = open();
    view.historyActions.error.value = 'Unrelated action failure';
    await view.historySaving.retry();
    expect(view.historyActions.error.value).toBe('Unrelated action failure');
    mocks.save.mockRejectedValueOnce(new Error('First save failed')).mockRejectedValueOnce(new Error('Earlier save failed'));
    await view.generate(); await view.generate();
    const pending = Promise.withResolvers<void>();
    mocks.save.mockReturnValueOnce(pending.promise);
    const saving = view.historySaving.retry();
    expect(view.historyActions.error.value).toBe('');
    view.historyActions.error.value = 'A newer action failed';
    pending.resolve(); await saving;
    expect(view.historyActions.error.value).toBe('A newer action failed');
    expect(view.historySaving.pendingCount.value).toBe(0);
  });

  it('removes only the deleted history link while preserving both generated results and a newer detail selection', async () => {
    const view = open();
    await view.generate();
    const first = view.results.value[0]!;
    const firstId = view.savedHistoryId({ resultId: first.id });
    if (!firstId) throw new Error('Expected the first saved history record');
    await view.generate();
    const second = view.results.value[0]!;
    const secondId = view.savedHistoryId({ resultId: second.id });
    if (!secondId) throw new Error('Expected the second saved history record');
    const results = [...view.results.value];
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    expect(resultsPanel.findAll('[data-testid="image-result-view-saved"]')).toHaveLength(2);
    const pending = Promise.withResolvers<void>();
    mocks.remove.mockReturnValueOnce(pending.promise);
    const deleting = view.history.remove({ id: firstId });
    expect(view.savedHistoryId({ resultId: first.id })).toBe(firstId);
    view.history.selected.value = mocks.save.mock.calls[1]![0].record;
    pending.resolve(); await deleting; await flushPromises();
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ id: firstId });
    expect(view.savedHistoryId({ resultId: first.id })).toBeUndefined();
    expect(view.savedHistoryId({ resultId: second.id })).toBe(secondId);
    expect(view.history.selected.value?.id).toBe(secondId);
    expect(view.historySaving.status.value).toBe('saved');
    expect(view.results.value).toEqual(results);
    expect(mocks.removeBinary).not.toHaveBeenCalled();
    expect(resultsPanel.findAll('[data-testid="image-result-view-saved"]')).toHaveLength(1);
  });

  it('keeps a saved result link after deletion rejection and across an OPFS storage round trip', async () => {
    const view = open(); await view.generate();
    const resultId = view.results.value[0]!.id;
    const historyId = view.savedHistoryId({ resultId });
    if (!historyId) throw new Error('Expected saved history');
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    mocks.remove.mockRejectedValueOnce(new Error('Deletion denied'));
    await expect(view.history.remove({ id: historyId })).rejects.toThrow('Deletion denied');
    expect(view.savedHistoryId({ resultId })).toBe(historyId);
    expect(resultsPanel.find('[data-testid="image-result-view-saved"]').exists()).toBe(true);
    expect(view.historySaving.status.value).toBe('saved');
    mocks.storageType = 'memory'; for (const listener of mocks.listeners) listener({ event: { type: 'migration', timestamp: 1 } });
    await expect(view.history.remove({ id: historyId })).rejects.toThrow('requires OPFS');
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    mocks.storageType = 'opfs'; for (const listener of mocks.listeners) listener({ event: { type: 'migration', timestamp: 2 } });
    expect(view.savedHistoryId({ resultId })).toBe(historyId);
    expect(mocks.removeBinary).not.toHaveBeenCalled();
  });

  it('removes a successfully deleted record link even if refreshing history fails, without discarding the result image', async () => {
    const view = open(); await view.generate(); await flushPromises();
    const savedResult = view.results.value[0]!;
    const historyId = view.savedHistoryId({ resultId: savedResult.id });
    if (!historyId) throw new Error('Expected saved history');
    resultsPanel = mount(ImageGenerationResults, { props: { view, active: true } });
    mocks.query.mockRejectedValueOnce(new Error('History refresh failed'));
    await view.history.remove({ id: historyId }); await flushPromises();
    expect(view.history.error.value).toBe('History refresh failed');
    expect(view.savedHistoryId({ resultId: savedResult.id })).toBeUndefined();
    expect(view.historySaving.status.value).toBe('idle');
    expect(view.results.value).toEqual([savedResult]);
    expect(resultsPanel.find('[data-testid="image-result-view-saved"]').exists()).toBe(false);
    expect(resultsPanel.find('[data-testid="image-generated-result"]').exists()).toBe(true);
    expect(mocks.removeBinary).not.toHaveBeenCalled();
  });

  it('exposes gallery navigation only after saving and removes runtime links with their results', async () => {
    mocks.save.mockRejectedValueOnce(new Error('quota'));
    const view = open();
    await view.generate();
    const resultId = view.results.value[0]!.id;
    expect(view.savedHistoryId({ resultId })).toBeUndefined();
    await view.historySaving.retry();
    expect(view.savedHistoryId({ resultId })).toBe(mocks.save.mock.calls[0]![0].record.id);
    mocks.storageType = 'memory'; for (const listener of mocks.listeners) listener({ event: { type: 'migration', timestamp: 1 } });
    expect(view.savedHistoryId({ resultId })).toBeUndefined();
    mocks.storageType = 'opfs'; for (const listener of mocks.listeners) listener({ event: { type: 'migration', timestamp: 2 } });
    expect(view.savedHistoryId({ resultId })).toBeDefined();
    view.removeResult({ resultId });
    expect(view.savedHistoryId({ resultId })).toBeUndefined();
  });
  it('downloads final and retained preview copies using the original request and chosen format', async () => {
    mocks.generate.mockImplementationOnce(async ({ onPreview }) => {
      onPreview({ frame: { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 2, steps: 8, width: 128, height: 64, mode: 'projection', png: new Blob(['preview'], { type: 'image/png' }) } });
      return result();
    });
    const view = open(); view.preview.value.enabled = true;
    await view.generate();
    const record = mocks.save.mock.calls[0]![0].record;
    view.parameters.value.prompt = 'modified after generation';
    expect(await view.downloadResult({ resultId: view.results.value[0]!.id, format: 'jpeg', includeMetadata: true })).toEqual({ status: 'downloaded' });
    expect(mocks.downloadBlob.mock.calls[0]![0]).toMatchObject({ request: record.request, format: 'jpeg', includeMetadata: true, image: { kind: 'final', width: 256, height: 256 } });
    expect(mocks.download.mock.calls[0]![0].filename).toBe('naidan-generated-image.jpeg');
    const previewId = view.previewSnapshots.value[0]!.id;
    expect(await view.downloadPreview({ previewId, format: 'webp', includeMetadata: true })).toEqual({ status: 'downloaded' });
    expect(mocks.downloadBlob.mock.calls[1]![0]).toMatchObject({ request: record.request, format: 'webp', includeMetadata: true, image: { kind: 'preview', width: 128, height: 64, step: 2, steps: 8, mode: 'projection' } });
    expect(mocks.download.mock.calls[1]![0].filename).toBe('naidan-image-preview.webp');
    view.removePreview({ previewId });
    expect(await view.downloadPreview({ previewId, format: 'png', includeMetadata: false })).toMatchObject({ status: 'failed', message: 'The preview image is no longer available' });
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });
  it('returns download errors to the local menu without changing generation success or saving originals', async () => {
    const view = open(); await view.generate();
    view.historyActions.error.value = 'An unrelated history action failed';
    const resultId = view.results.value[0]!.id;
    mocks.downloadBlob.mockRejectedValueOnce(new Error('Generation settings are too large for JPEG metadata. Choose PNG or WebP.'));
    expect(await view.downloadResult({ resultId, format: 'jpeg', includeMetadata: true })).toEqual({ status: 'failed', message: 'Generation settings are too large for JPEG metadata. Choose PNG or WebP.' });
    expect(view.failure.value).toBe(''); expect(view.results.value).toHaveLength(1); expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(view.historyActions.error.value).toBe('An unrelated history action failed');
    expect(await view.downloadResult({ resultId, format: 'png', includeMetadata: true })).toEqual({ status: 'downloaded' });
    expect(view.historyActions.error.value).toBe('An unrelated history action failed');
  });
  it('downloads a saved preview with its dimensions and closes safely when disposed during conversion', async () => {
    mocks.generate.mockImplementationOnce(async ({ onPreview }) => {
      onPreview({ frame: { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 3, steps: 9, width: 64, height: 64, mode: 'vae', png: new Blob(['preview'], { type: 'image/png' }) } });
      return result();
    });
    const view = open(); view.preview.value.enabled = true; await view.generate();
    const record = mocks.save.mock.calls[0]![0].record;
    mocks.getFile.mockResolvedValue(new Blob(['stored PNG'], { type: 'image/png' }));
    expect(await view.downloadHistory({ record, binaryObjectId: record.previews[0].binaryObjectId, format: 'webp', includeMetadata: true })).toEqual({ status: 'downloaded' });
    expect(mocks.downloadBlob.mock.calls[0]![0]).toMatchObject({ request: record.request, format: 'webp', includeMetadata: true,
      image: { kind: 'preview', width: 64, height: 64, step: 3, steps: 9, mode: 'vae' } });
    const conversion = Promise.withResolvers<Blob>(); mocks.downloadBlob.mockReturnValueOnce(conversion.promise);
    const operation = view.downloadResult({ resultId: view.results.value[0]!.id, format: 'png', includeMetadata: true });
    wrapper?.unmount(); wrapper = undefined;
    conversion.resolve(new Blob(['download'], { type: 'image/png' }));
    expect(await operation).toEqual({ status: 'cancelled' }); expect(mocks.download).toHaveBeenCalledTimes(1);
  });
  it('clears a discarded result status even when its pending save finishes later', async () => {
    const view = open(); mocks.save.mockRejectedValueOnce(new Error('quota'));
    await view.generate();
    expect(view.historySaving.status.value).toBe('failed');
    const pending = Promise.withResolvers<void>(); mocks.save.mockReturnValueOnce(pending.promise);
    const retry = view.historySaving.retry();
    view.clearResults(); pending.reject(new Error('late failure')); await retry;
    expect(view.historySaving.pendingCount.value).toBe(0); expect(view.historySaving.status.value).toBe('idle'); expect(view.historySaving.error.value).toBe('');
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it('keeps a generated result when history saving fails and retries the identical immutable snapshot', async () => {
    mocks.save.mockRejectedValueOnce(new Error('OPFS quota exceeded'));
    const view = open();
    await view.generate();
    expect(view.results.value).toHaveLength(1); expect(view.failure.value).toBe('');
    expect(view.historySaving.status.value).toBe('failed'); expect(view.historySaving.error.value).toBe('OPFS quota exceeded');
    const first = mocks.save.mock.calls[0]?.[0];
    const acceptedSeed = first.record.request.parameters.seed;
    view.parameters.value.prompt = 'later edit';
    view.parameters.value.seed = '0'; view.seedMode.value = 'random';
    await view.historySaving.retry();
    expect(mocks.save.mock.calls[1]?.[0]).toBe(first);
    expect(first.record.request.parameters.prompt).toBe('a small tree');
    expect(first.record.request.parameters.seed).toBe(acceptedSeed); expect(view.parameters.value.seed).toBe('0');
    expect(view.historySaving.status.value).toBe('saved'); expect(view.failure.value).toBe('');
  });
  it('waits for saving but allows the next generation while history refresh is still pending', async () => {
    const saving = Promise.withResolvers<void>();
    const querying = Promise.withResolvers<{ items: [], total: number, warnings: [], warningCount: number }>();
    mocks.save.mockReturnValueOnce(saving.promise);
    mocks.query.mockReturnValueOnce(querying.promise);
    const view = open();
    let finished = false;
    const generation = view.generate().finally(() => {
      finished = true;
    });
    await flushPromises();
    expect(finished).toBe(false);
    expect(view.busy.value).toBe(true);
    expect(view.historySaving.status.value).toBe('saving');
    expect(mocks.query).not.toHaveBeenCalled();

    saving.resolve(); await flushPromises();
    expect(finished).toBe(true);
    await generation;
    expect(view.busy.value).toBe(false);
    expect(view.historySaving.status.value).toBe('saved');
    expect(view.history.loading.value).toBe(true);
    expect(view.savedHistoryId({ resultId: view.results.value[0]!.id })).toBeDefined();

    view.historySaving.enabled.value = false;
    await view.generate();
    expect(view.results.value).toHaveLength(2);
    querying.reject(new Error('History Worker unavailable')); await flushPromises();
    expect(view.history.error.value).toBe('History Worker unavailable');
    expect(view.failure.value).toBe('');
    expect(view.historySaving.status.value).toBe('idle');
    expect(view.historySaving.error.value).toBe('');
    await view.history.reload();
    expect(view.history.error.value).toBe('');
  });
  it.each(['saved', 'failed'] as const)('disables inference stop while saving and restores controls after a %s save', async outcome => {
    const saving = Promise.withResolvers<void>();
    mocks.save.mockReturnValueOnce(saving.promise);
    const view = open();
    editor = mount(ImageGenerationEditor, { props: { view, active: true } });
    const generation = view.generate();
    await flushPromises();
    const signal: AbortSignal = mocks.generate.mock.calls[0]![0].signal;
    expect(view.results.value).toHaveLength(1);
    expect(view.busy.value).toBe(true);
    expect(view.historySaving.status.value).toBe('saving');
    expect(view.progress.value).toBeUndefined();
    expect(editor.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(true);
    expect(editor.get('[data-testid="image-cancel"]').element.matches(':disabled')).toBe(true);
    expect(editor.find('[data-testid="image-force-cancel"]').exists()).toBe(false);
    await editor.get('[data-testid="image-cancel"]').trigger('click');
    view.cancel(); view.forceCancel();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    expect(view.stopping.value).toBe(false);
    await view.generate();
    expect(mocks.generate).toHaveBeenCalledOnce();

    if (outcome === 'saved') saving.resolve();
    else saving.reject(new Error('OPFS quota exceeded'));
    await generation; await flushPromises();
    expect(view.historySaving.status.value).toBe(outcome);
    expect(view.busy.value).toBe(false);
    expect(view.cancelled.value).toBe(false);
    expect(view.failure.value).toBe('');
    expect(view.results.value).toHaveLength(1);
    expect(editor.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(false);
    expect(editor.get('[data-testid="image-cancel"]').element.matches(':disabled')).toBe(true);
  });
  it('allows cooperative and forced stop from inference startup before its first progress callback', async () => {
    const inference = Promise.withResolvers<{ cancelled: true, modelResident: boolean }>();
    mocks.generate.mockReturnValueOnce(inference.promise);
    const view = open();
    editor = mount(ImageGenerationEditor, { props: { view, active: true } });
    const generation = view.generate();
    await flushPromises();
    const signal: AbortSignal = mocks.generate.mock.calls[0]![0].signal;
    expect(view.progress.value).toEqual({ phase: 'runtime', step: 0, steps: 0 });
    expect(editor.get('[data-testid="image-cancel"]').element.matches(':disabled')).toBe(false);
    await editor.get('[data-testid="image-cancel"]').trigger('click');
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(view.stopping.value).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(editor.get('[data-testid="image-force-cancel"]').element.matches(':disabled')).toBe(false);
    await editor.get('[data-testid="image-force-cancel"]').trigger('click');
    expect(signal.aborted).toBe(true);
    inference.reject(new DOMException('Image generation cancelled', 'AbortError'));
    await generation; await flushPromises();
    expect(view.busy.value).toBe(false);
    expect(view.stopping.value).toBe(false);
    expect(view.cancelled.value).toBe(true);
    expect(editor.find('[data-testid="image-force-cancel"]').exists()).toBe(false);
    expect(editor.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps a newer save failure retryable when an older history refresh finishes', async () => {
    const querying = Promise.withResolvers<{ items: [], total: number, warnings: [], warningCount: number }>();
    mocks.query.mockReturnValueOnce(querying.promise);
    const view = open();
    await view.generate();
    mocks.save.mockRejectedValueOnce(new Error('Quota exceeded'));
    await view.generate();
    const failedSnapshot = mocks.save.mock.calls[1]![0];
    expect(view.historySaving.status.value).toBe('failed');
    expect(view.historySaving.pendingCount.value).toBe(1);

    querying.reject(new Error('Old history query failed')); await flushPromises();
    expect(view.history.error.value).toBe('');
    expect(view.historySaving.status.value).toBe('failed');
    expect(view.historySaving.error.value).toBe('Quota exceeded');
    expect(view.historySaving.pendingCount.value).toBe(1);
    await view.historySaving.retry();
    expect(mocks.save.mock.calls[2]![0]).toBe(failedSnapshot);
    expect(view.historySaving.status.value).toBe('saved');
    expect(view.historySaving.pendingCount.value).toBe(0);
  });
  it('does not publish a delayed refresh failure or start a refresh after disposal during saving', async () => {
    const querying = Promise.withResolvers<{ items: [], total: number, warnings: [], warningCount: number }>();
    mocks.query.mockReturnValueOnce(querying.promise);
    const view = open();
    await view.generate();
    const saving = Promise.withResolvers<void>();
    mocks.save.mockReturnValueOnce(saving.promise);
    const generation = view.generate();
    await flushPromises();
    wrapper?.unmount(); wrapper = undefined;
    saving.resolve(); querying.reject(new Error('Detached history query failed'));
    await generation; await flushPromises();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(view.history.error.value).toBe('');
    expect(view.history.loading.value).toBe(false);
  });
  it('does not begin an OPFS save after storage changes to memory during generation', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof result>>(); mocks.generate.mockReturnValueOnce(pending.promise);
    const view = open(); const generation = view.generate();
    mocks.storageType = 'memory'; for (const listener of mocks.listeners) listener({ event: { type: 'migration', timestamp: 1 } });
    pending.resolve(result()); await generation;
    expect(view.results.value).toHaveLength(1); expect(mocks.save).not.toHaveBeenCalled(); expect(view.historySaving.supported.value).toBe(false);
  });
  it('saves only retained preview frames captured by the current generation', async () => {
    let runId = 0;
    mocks.generate.mockImplementation(async ({ onPreview }) => {
      const current = ++runId;
      onPreview({ frame: { type: 'naidan-image-preview-v1', runId: current, revision: 0, step: current, steps: 20, width: 128, height: 128, mode: 'projection', png: new Blob([`preview-${current}`], { type: 'image/png' }) } });
      return result();
    });
    const view = open(); view.preview.value.enabled = true;
    await view.generate(); await view.generate();
    expect(view.previewSnapshots.value).toHaveLength(2);
    expect(mocks.save.mock.calls[0]?.[0].record.previews.map((frame: { step: number }) => frame.step)).toEqual([1]);
    expect(mocks.save.mock.calls[1]?.[0].record.previews.map((frame: { step: number }) => frame.step)).toEqual([2]);
  });
  it('retains restored adapters, companion paths, input order and every setting after Vue watchers flush', async () => {
    const file = mocks.models[0]!.file;
    const request = requestFixture(); request.artifact = artifactFixture();
    request.parameters = { ...parametersFixture(), prompt: 'Restored', seed: '987654321', steps: 8, guidance: 1 };
    request.models = [{ slot: 'model', file, path: 'nested/model.gguf', companions: [{ path: 'nested/shard.gguf', file }] }];
    request.loras = [{ file, path: 'adapter.gguf', strength: 0.7 }];
    request.imageInputs = { initImage: new File(['init'], 'init.png', { type: 'image/png' }), strength: 0.3, referenceImages: [new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })] };
    const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), createdAt: 1, locateFile: ({ file }) => ({ type: 'opfs', name: file.name, size: file.size, lastModified: file.lastModified, path: `models/user/example/${file.name}` }) });
    const saved = finishImageGenerationSnapshot({ snapshot, result: result(), previews: [], elapsedMs: 1 });
    mocks.getFile.mockImplementation(async ({ binaryObjectId }) => saved.files.find(file => file.binaryObjectId === binaryObjectId)?.blob);
    const view = open();
    await view.reuseHistory({ record: saved.record }); await nextTick(); await flushPromises();
    expect(view.parameters.value).toEqual(request.parameters); expect(view.loras.value.map(lora => lora.strength)).toEqual([0.7]);
    expect(view.seedMode.value).toBe('fixed');
    expect(view.imageInputs.value.referenceImages.map(file => file.name)).toEqual(['one.png', 'two.png']);
    expect(view.imageInputs.value.strength).toBe(0.3);
    await view.generate();
    expect(mocks.generate.mock.calls[0]?.[0].request.models[0].companions[0].path).toBe('nested/shard.gguf');
    expect(mocks.generate.mock.calls[0]?.[0].request.parameters.seed).toBe('987654321');
    expect(view.historyActions.error.value).toBe('');
  });
  it('does not publish a cancelled or failed generation as a successful history record', async () => {
    const view = open(); mocks.generate.mockResolvedValueOnce({ cancelled: true, modelResident: false });
    await view.generate(); expect(mocks.save).not.toHaveBeenCalled(); expect(view.results.value).toHaveLength(0);
    mocks.generate.mockRejectedValueOnce(new Error('Native failure')); await view.generate();
    expect(mocks.save).not.toHaveBeenCalled(); expect(view.failure.value).toBe('Native failure');
  });

  it('preserves unchanged split models when replacing or clearing one component after history reuse', async () => {
    const base = ggufFile(), companion = new File(['companion'], 'part-two.gguf');
    const vae = new File(['original-vae'], 'original-vae.gguf');
    const replacement = new File(['replacement-vae'], 'replacement-vae.gguf');
    mocks.models = [{ slot: 'diffusion', file: base, path: 'split/base.gguf', companions: [{ path: 'split/part-two.gguf', file: companion }] },
      { slot: 'vae', file: vae, path: 'original/vae.gguf' }];
    const request = requestFixture(); request.models = mocks.models; request.parameters.seed = '42';
    const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), createdAt: 1,
      locateFile: ({ file }) => ({ type: 'opfs', name: file.name, size: file.size, lastModified: file.lastModified, path: `models/user/example/${file.name}` }) });
    const saved = finishImageGenerationSnapshot({ snapshot, result: result(), previews: [], elapsedMs: 1 });
    const original = structuredClone(saved.record);
    const view = open();
    view.library.findHistoryFile = ({ location }) => [base, companion, vae].find(file => file.name === location.name);
    await view.reuseHistory({ record: saved.record });
    const input = document.createElement('input'); input.type = 'file';
    Object.defineProperty(input, 'files', { value: [replacement], configurable: true });
    view.chooseFile({ slot: 'vae', event: { target: input } as unknown as Event });
    await view.generate();
    expect(mocks.generate).toHaveBeenCalledOnce();
    const models = mocks.generate.mock.calls[0]![0].request.models;
    expect(models.find((model: Request['models'][number]) => model.slot === 'diffusion')).toMatchObject({
      file: base, path: 'split/base.gguf', companions: [{ path: 'split/part-two.gguf', file: companion }],
    });
    expect(models.find((model: Request['models'][number]) => model.slot === 'vae')).toMatchObject({ file: replacement });
    expect(models.find((model: Request['models'][number]) => model.slot === 'vae').path).toBeUndefined();
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    view.chooseFile({ slot: 'vae', event: { target: input } as unknown as Event });
    await view.generate();
    const cleared = mocks.generate.mock.calls[1]![0].request.models;
    expect(cleared).toHaveLength(1);
    expect(cleared[0].companions[0].file).toBe(companion);
    // Replacing the base model still clears its previous split-file association.
    Object.defineProperty(input, 'files', { value: [replacement] });
    view.chooseFile({ slot: 'diffusion', event: { target: input } as unknown as Event });
    await view.generate();
    expect(mocks.generate.mock.calls[2]![0].request.models[0].companions).toBeUndefined();
    expect(saved.record).toEqual(original);
  });
  it.each(['model', 'diffusion'] as const)('retains untouched auxiliary split files when replacing the restored %s', async mainSlot => {
    const base = ggufFile(), oldPart = new File(['old-part'], 'base-part.gguf'), replacement = new File(['replacement'], 'replacement.gguf');
    const vae = new File(['vae-data'], 'vae.gguf'), vaePart = new File(['vae-part'], 'vae-part.gguf');
    const lm = new File(['lm-model'], 'lm.gguf'), lmPart = new File(['lm-part-data'], 'lm-part.gguf');
    const request = requestFixture();
    request.models = [{ slot: mainSlot, file: base, path: 'base/model.gguf', companions: [{ path: 'base/part.gguf', file: oldPart }] },
      { slot: 'vae', file: vae, path: 'vae/model.gguf', companions: [{ path: 'vae/part.gguf', file: vaePart }] },
      { slot: 'lm', file: lm, path: 'text/model.gguf', companions: [{ path: 'text/part.gguf', file: lmPart }] }];
    request.loras = [{ file: base, strength: 0.7 }];
    const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), createdAt: 1,
      locateFile: ({ file }) => ({ type: 'opfs', name: file.name, size: file.size, lastModified: file.lastModified, path: `models/user/example/${file.name}` }) });
    const saved = finishImageGenerationSnapshot({ snapshot, result: result(), previews: [], elapsedMs: 1 });
    const original = structuredClone(saved.record), view = open();
    view.library.findHistoryFile = ({ location }) => [base, oldPart, vae, vaePart, lm, lmPart].find(file => file.name === location.name);
    await view.reuseHistory({ record: saved.record });
    expect(view.historyActions.error.value).toBe('');
    view.imageInputs.value.referenceImages = [new File(['reference'], 'reference.png', { type: 'image/png' })];
    const input = document.createElement('input'); input.type = 'file';
    Object.defineProperty(input, 'files', { value: [replacement] });
    view.chooseFile({ slot: mainSlot, event: { target: input } as unknown as Event });
    await nextTick(); await view.generate();
    expect(mocks.generate).toHaveBeenCalledOnce();
    const generated = mocks.generate.mock.calls[0]![0].request as Request;
    expect(generated.models.find(model => model.slot === mainSlot)).toEqual({ slot: mainSlot, file: replacement });
    expect(generated.models.filter(model => model.slot !== mainSlot)).toEqual(request.models.slice(1));
    expect(generated.loras).toEqual([]); expect(generated.imageInputs.referenceImages).toEqual([]);
    expect(saved.record).toEqual(original);
  });
  it('keeps the editor unchanged while local reuse preparation is pending or fails', async () => {
    const request = requestFixture(); request.models = mocks.models; request.parameters.prompt = 'Saved prompt';
    const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), createdAt: 1,
      locateFile: ({ file }) => ({ type: 'opfs', name: file.name, size: file.size, lastModified: file.lastModified, path: `models/user/example/${file.name}` }) });
    const saved = finishImageGenerationSnapshot({ snapshot, result: result(), previews: [], elapsedMs: 1 });
    const pending = Promise.withResolvers<void>(); mocks.prepareFiles.mockReturnValueOnce(pending.promise);
    const view = open(); const restore = view.reuseHistory({ record: saved.record });
    expect(view.historyActions.busy.value).toBe(true); expect(view.parameters.value.prompt).toBe('a small tree');
    pending.reject(new Error('Local scan failed')); await restore;
    expect(view.parameters.value.prompt).toBe('a small tree'); expect(view.library.main.value).toBe('selected');
    expect(view.historyActions.missingFiles.value).toEqual([]); expect(view.historyActions.error.value).toBe('Local scan failed');
    await view.reuseHistory({ record: saved.record });
    expect(view.parameters.value.prompt).toBe('Saved prompt'); expect(view.historyActions.missingFiles.value).toEqual([]);
  });
  it.each(['settings', 'image'] as const)('ignores a delayed %s reuse error from before storage changed', async action => {
    const request = requestFixture(); request.models = mocks.models;
    const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), createdAt: 1,
      locateFile: ({ file }) => ({ type: 'opfs', name: file.name, size: file.size, lastModified: file.lastModified, path: `models/user/example/${file.name}` }) });
    const saved = finishImageGenerationSnapshot({ snapshot, result: result(), previews: [], elapsedMs: 1 });
    const pending = Promise.withResolvers<never>();
    const view = open();
    const operation = (() => {
      switch (action) {
      case 'settings':
        mocks.prepareFiles.mockReturnValueOnce(pending.promise);
        return view.reuseHistory({ record: saved.record });
      case 'image':
        mocks.getFile.mockReturnValueOnce(pending.promise);
        return view.useHistoryImage({ binaryObjectId: saved.record.result.binaryObjectId, role: 'reference' });
      default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
      }
    })();
    mocks.storageType = 'memory';
    for (const listener of mocks.listeners) listener({ event: { type: 'migration', timestamp: 1 } });
    pending.reject(new Error('Old OPFS read failed')); await operation;
    expect(view.historyActions.busy.value).toBe(false);
    expect(view.historyActions.error.value).toBe('');
    expect(view.parameters.value.prompt).toBe('a small tree');
    expect(view.imageInputs.value.referenceImages).toEqual([]);
  });
  it.each([0, 0.7])('keeps the base model and only requires acknowledgement for an enabled missing adapter (strength %s)', async strength => {
    const request = requestFixture(); request.models = mocks.models;
    request.loras = [{ file: new File(['adapter'], 'missing-adapter.gguf'), path: 'missing-adapter.gguf', strength }];
    const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), createdAt: 1,
      locateFile: ({ file }) => ({ type: 'opfs', name: file.name, size: file.size, lastModified: file.lastModified, path: `models/user/example/${file.name}` }) });
    const saved = finishImageGenerationSnapshot({ snapshot, result: result(), previews: [], elapsedMs: 1 });
    const view = open();
    await view.reuseHistory({ record: saved.record }); await nextTick(); await flushPromises();
    expect(view.files.value.model).toBe(mocks.models[0]!.file);
    expect(view.historyActions.missingFiles.value).toEqual(strength ? ['missing-adapter.gguf'] : []);
    expect(view.historyActions.missingInactiveFiles.value).toEqual(strength ? [] : ['missing-adapter.gguf']);
    if (strength) {
      await view.generate(); expect(mocks.generate).not.toHaveBeenCalled();
      view.clearHistoryMissingFiles();
    }
    await view.generate();
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.generate.mock.calls[0]?.[0].request.models[0].file).toBe(mocks.models[0]!.file);
    expect(mocks.generate.mock.calls[0]?.[0].request.loras).toEqual([]);
  });
  it('does not show a previous saved status for a later generation with history disabled', async () => {
    const view = open(); await view.generate(); expect(view.historySaving.status.value).toBe('saved');
    view.historySaving.enabled.value = false; await view.generate();
    expect(view.results.value).toHaveLength(2); expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(view.historySaving.status.value).toBe('idle'); expect(view.historySaving.error.value).toBe('');
  });
  it('keeps an earlier failed snapshot retryable without applying its saved status to a later cancelled run', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Quota exceeded'));
    const view = open(); await view.generate();
    const failed = mocks.save.mock.calls[0]?.[0];
    expect(view.historySaving.pendingCount.value).toBe(1);
    mocks.generate.mockResolvedValueOnce({ cancelled: true, modelResident: false });
    await view.generate(); expect(view.historySaving.status.value).toBe('idle'); expect(view.historySaving.error.value).toBe('');
    await view.historySaving.retry();
    expect(mocks.save.mock.calls[1]?.[0]).toBe(failed);
    expect(view.historySaving.status.value).toBe('idle'); expect(view.historySaving.pendingCount.value).toBe(0);
  });
  it('clears the visible saving status when storage changes and releases pending snapshots with removed results', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Quota exceeded'));
    const view = open(); await view.generate(); expect(view.historySaving.pendingCount.value).toBe(1);
    mocks.storageType = 'memory'; for (const listener of mocks.listeners) listener({ event: { type: 'migration', timestamp: 1 } });
    expect(view.historySaving.status.value).toBe('idle'); expect(view.historySaving.supported.value).toBe(false);
    view.clearResults(); expect(view.historySaving.pendingCount.value).toBe(0);
  });
  it('keeps the chosen dimensions for selection-time helpers and explicit recommended settings', async () => {
    const view = open(); view.parameters.value.width = 768; view.parameters.value.height = 448;
    view.parameters.value.steps = 50; view.parameters.value.guidance = 10;
    mocks.select({ family: 'z-image', turbo: true }); await nextTick();
    expect(view.parameters.value).toMatchObject({ width: 768, height: 448, steps: 8, guidance: 1 });
    view.parameters.value.steps = 60; view.applyRecommendedSettings(); await nextTick();
    expect(view.parameters.value).toMatchObject({ width: 768, height: 448, steps: 8, guidance: 1 });
  });
  it('resolves a browser-random seed once for the accepted request and saved snapshot', async () => {
    const view = open(); expect(view.seedMode.value).toBe('random');
    view.parameters.value.seed = '-1'; await view.generate();
    const seed = mocks.generate.mock.calls[0]?.[0].request.parameters.seed;
    expect(seed).toMatch(/^[1-9][0-9]*$/); expect(Number(seed)).toBeLessThanOrEqual(4294967295);
    expect(view.parameters.value.seed).toBe(seed);
    expect(mocks.save.mock.calls[0]?.[0].record.request.parameters.seed).toBe(seed);
  });
  it('respects fixed seeds, leaves invalid requests unchanged and rerolls only the next draft while busy', async () => {
    const view = open(); view.seedMode.value = 'fixed'; view.parameters.value.seed = '9223372036854775807';
    await view.generate();
    expect(mocks.generate.mock.calls[0]?.[0].request.parameters.seed).toBe('9223372036854775807');
    view.seedMode.value = 'random'; view.parameters.value.width = -1;
    await view.generate(); expect(view.parameters.value.seed).toBe('9223372036854775807');
    expect(mocks.generate).toHaveBeenCalledOnce();
    view.parameters.value.width = 256; view.randomizeSeed(); expect(view.seedMode.value).toBe('fixed');
    const seed = view.parameters.value.seed;
    const pending = Promise.withResolvers<ReturnType<typeof result>>(); mocks.generate.mockReturnValueOnce(pending.promise);
    const generation = view.generate(); view.seedMode.value = 'random'; view.randomizeSeed();
    expect(view.seedMode.value).toBe('fixed');
    expect(view.parameters.value.seed).toMatch(/^[1-9][0-9]*$/);
    expect(mocks.generate.mock.calls[1]![0].request.parameters.seed).toBe(seed);
    pending.resolve(result()); await generation;
    view.historyActions.busy.value = true;
    const draft = view.parameters.value.seed; view.randomizeSeed();
    expect(view.draftDisabled.value).toBe(true); expect(view.parameters.value.seed).toBe(draft);
  });
});

it('clears only preference-restoration missing files when a usable base model is explicitly selected', async () => {
  preferenceSettings.value.experimental = { browserImageGeneration: { modelSelection: {
    primary: { slot: 'model', location: { kind: 'opfs', path: 'models/missing.gguf' } }, components: [], loras: [],
  } } };
  preferencesInitialized.value = true;
  const view = open(); await flushPromises();
  expect(view.historyActions.missingFiles.value).toEqual(['missing.gguf']);
  await view.generate(); expect(mocks.generate).not.toHaveBeenCalled();
  view.library.chooseMain({ id: 'available-model' }); await flushPromises();
  expect(view.historyActions.missingFiles.value).toEqual([]);
  await view.generate(); expect(mocks.generate).toHaveBeenCalledOnce();
});

describe('Image Generation submission and draft integration', () => {
  function submission({ count }: { count: number }) {
    return { count, accepted: vi.fn<import('./generation-submission').ImageGenerationSubmission['accepted']>().mockResolvedValue(),
      output: vi.fn<import('./generation-submission').ImageGenerationSubmission['output']>().mockResolvedValue(),
      finished: vi.fn<import('./generation-submission').ImageGenerationSubmission['finished']>().mockResolvedValue() };
  }
  it('accepts one immutable plan, publishes consecutive actual seeds and releases the model only after the run', async () => {
    const view = open(), sink = submission({ count: 3 });
    view.seedMode.value = 'fixed'; view.parameters.value.seed = '9007199254740993'; view.retainModel.value = false;
    await nextTick(); mocks.release.mockClear();
    sink.output.mockImplementation(async () => {
      expect(mocks.release).not.toHaveBeenCalled();
      view.parameters.value = { ...view.parameters.value, prompt: 'next draft', width: 512 };
    });
    await view.generate({ submission: sink });
    expect(sink.accepted).toHaveBeenCalledOnce();
    expect(sink.accepted.mock.calls[0]?.[0].seeds).toEqual(['9007199254740993', '9007199254740994', '9007199254740995']);
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    expect(mocks.generate.mock.calls.map(call => call[0].request.parameters)).toEqual(['9007199254740993', '9007199254740994', '9007199254740995'].map(seed => ({ ...parametersFixture(), seed })));
    expect(sink.output.mock.calls.map(call => [call[0].index, call[0].record.request.parameters.seed])).toEqual([[0, '9007199254740993'], [1, '9007199254740994'], [2, '9007199254740995']]);
    expect(sink.finished).toHaveBeenCalledWith({ completion: { type: 'completed' } });
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledOnce();
    expect(view.parameters.value.prompt).toBe('next draft'); expect(view.busy.value).toBe(false);
  });
  it('shows each new image as running instead of retaining the previous completed preview', async () => {
    const view = open(), sink = submission({ count: 3 });
    const generate = mocks.generate.getMockImplementation(); if (!generate) throw new Error('Missing native fixture.');
    const phases: (string | undefined)[] = [];
    mocks.generate.mockImplementation(async (...args) => {
      phases.push(view.latestRun.value?.status);
      expect(view.livePreview.value).toBeUndefined();
      return generate(...args);
    });
    sink.output.mockImplementation(async () => {
      expect(view.latestRun.value?.status).toBe('succeeded');
    });
    await view.generate({ submission: sink });
    expect(phases).toEqual(['running', 'running', 'running']);
    expect(view.latestRun.value?.status).toBe('succeeded');
  });
  it('keeps earlier images but reports failure of a later image rather than leaving it running', async () => {
    const view = open(), sink = submission({ count: 3 });
    const generate = mocks.generate.getMockImplementation(); if (!generate) throw new Error('Missing native fixture.');
    mocks.generate.mockImplementationOnce(generate).mockRejectedValueOnce(new Error('second image failed'));
    await view.generate({ submission: sink });
    expect(view.results.value).toHaveLength(1);
    expect(view.latestRun.value).toMatchObject({ status: 'failed', failure: 'second image failed' });
    expect(view.busy.value).toBe(false);
    expect(sink.finished).toHaveBeenCalledWith({ completion: { type: 'failed', message: 'second image failed' } });
  });
  it('does not start inference when the accepted request cannot be persisted', async () => {
    const view = open(), sink = submission({ count: 4 });
    sink.accepted.mockRejectedValueOnce(new Error('storage full'));
    await view.generate({ submission: sink });
    expect(mocks.generate).not.toHaveBeenCalled(); expect(sink.output).not.toHaveBeenCalled();
    expect(sink.finished).toHaveBeenCalledWith({ completion: { type: 'failed', message: 'storage full' } });
    expect(view.failure.value).toBe('storage full'); expect(view.busy.value).toBe(false);
  });
  it('waits for each save and permits cancellation between native calls', async () => {
    const view = open(), sink = submission({ count: 4 }), saving = Promise.withResolvers<void>();
    sink.output.mockReturnValueOnce(saving.promise);
    const running = view.generate({ submission: sink }); await flushPromises();
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(view.busy.value).toBe(true);
    view.cancel(); saving.resolve(); await running;
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(sink.output).toHaveBeenCalledOnce();
    expect(sink.finished).toHaveBeenCalledWith({ completion: { type: 'cancelled' } });
    expect(view.cancelled.value).toBe(true);
  });
  it('does not automatically retry inference after an output-save failure', async () => {
    const view = open(), sink = submission({ count: 4 });
    sink.output.mockRejectedValueOnce(new Error('save failed'));
    await view.generate({ submission: sink });
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(sink.output).toHaveBeenCalledOnce();
    expect(view.results.value).toHaveLength(1);
    expect(sink.finished).toHaveBeenCalledWith({ completion: { type: 'failed', message: 'save failed' } });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects seed overflow before accepting a run or starting native execution', async () => {
    const view = open(), sink = submission({ count: 2 });
    view.seedMode.value = 'fixed'; view.parameters.value.seed = '9223372036854775807';
    await view.generate({ submission: sink });
    expect(mocks.generate).not.toHaveBeenCalled(); expect(sink.accepted).not.toHaveBeenCalled();
    expect(view.invalid.value).toBe(true);
  });
  it('rejects a second generate click while request persistence is pending', async () => {
    const view = open(), sink = submission({ count: 2 }), accepted = Promise.withResolvers<void>();
    sink.accepted.mockReturnValueOnce(accepted.promise);
    const running = view.generate({ submission: sink }); await flushPromises();
    await view.generate({ submission: sink }); expect(sink.accepted).toHaveBeenCalledOnce();
    accepted.resolve(); await running; expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
  it('restores an incomplete draft including an empty prompt, partial seed, layout and a disabled adapter strength', async () => {
    const view = open(); view.layout.value = 'components';
    view.parameters.value.prompt = ''; view.parameters.value.seed = '';
    view.parameters.value.width = 0; view.seedMode.value = 'fixed';
    const file = ggufFile();
    view.loras.value = [{ enabled: false, strength: 0.75, file, path: 'draft-adapter.gguf', sourceLabel: 'Draft adapter' }];
    const draft = view.captureDraft?.(); if (!draft) throw new Error('Expected hosted draft capture');
    view.parameters.value.prompt = 'unrelated'; view.parameters.value.seed = '42';
    view.loras.value = []; view.layout.value = 'checkpoint';
    await view.restoreDraft?.({ draft });
    expect(view.historyActions.error.value).toBe('');
    expect(view.parameters.value).toMatchObject({ prompt: '', seed: '', width: 0 });
    expect(view.layout.value).toBe('components'); expect(view.seedMode.value).toBe('fixed');
    expect(view.loras.value).toMatchObject([{ enabled: false, strength: 0.75, path: 'draft-adapter.gguf' }]);
    await view.generate(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('preserves draft input binary identities and the bytes without relying on the global history', async () => {
    const view = open(); view.imageInputs.value.initImage = new File(['original'], 'initial.png', { type: 'image/png' });
    const first = view.captureDraft?.(); if (!first) throw new Error('Expected draft');
    await view.restoreDraft?.({ draft: first });
    const second = view.captureDraft?.();
    expect(second?.request.imageInputs.initImage?.binaryObjectId).toBe(first.request.imageInputs.initImage?.binaryObjectId);
    expect(second?.files[0]?.blob.size).toBe(8); expect(mocks.getFile).not.toHaveBeenCalled();
  });
});
