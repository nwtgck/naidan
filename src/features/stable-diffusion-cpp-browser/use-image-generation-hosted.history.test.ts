import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { Request } from './types';
import type { ImageGenerationView } from './use-image-generation-types';
import { artifactFixture, ggufFile, parametersFixture, requestFixture } from './test-fixtures';
import { snapshotImageGeneration, finishImageGenerationSnapshot } from './history/snapshot';
import { ensureAllStringsForTest } from '@/strings/test-utils';
const mocks = vi.hoisted(() => {
  const models: Request['models'] = [];
  let selection: ({ family, turbo }: { family: 'z-image', turbo: boolean }) => void = () => {};
  return { generate: vi.fn(), release: vi.fn(), dispose: vi.fn(), save: vi.fn(), getFile: vi.fn(), query: vi.fn(), prepareFiles: vi.fn(), downloadBlob: vi.fn(), download: vi.fn(), models,
    storageType: 'opfs', listeners: new Set<({ event }: { event: { type: 'migration', timestamp: number } }) => void>(),
    select(value: { family: 'z-image', turbo: boolean }) {
      selection(value);
    },
    selection(callback: typeof selection) {
      selection = callback;
    },
  };
});
vi.mock('@/00-storage/service', () => ({ storageService: {
  getCurrentType: () => mocks.storageType,
  subscribeToChanges: ({ listener }: { listener: ({ event }: { event: { type: 'migration', timestamp: number } }) => void }) => {
    mocks.listeners.add(listener); return () => {
      mocks.listeners.delete(listener);
    };
  },
  saveImageGeneration: (...args: unknown[]) => mocks.save(...args),
  getFile: (...args: unknown[]) => mocks.getFile(...args),
} }));
vi.mock('./history/worker/client-hosted', () => ({ createImageHistoryClient: () => ({ query: mocks.query, async dispose() {} }) }));
vi.mock('./capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify', supportsJspi: () => false, supportsMemory64: () => false }));
vi.mock('./inventory-worker/client', () => ({ inspectImageInventory: vi.fn() }));
vi.mock('./worker/client', () => ({ createImageClient: () => ({ generate: mocks.generate, release: mocks.release, dispose: mocks.dispose, cancel() {}, updatePreview() {} }) }));
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
    return { ...library, ready: computed(() => true), selectedModels: () => mocks.models,
      selectedFacts: computed(() => ({ family: 'z-image', variant: 'turbo', evidence: [] })),
      prepareHistoryFiles: () => mocks.prepareFiles(),
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
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.storageType = 'opfs'; mocks.models = [{ slot: 'model', file: ggufFile() }];
  mocks.query.mockResolvedValue({ items: [], total: 0, warnings: [], warningCount: 0 }); mocks.save.mockResolvedValue(undefined); mocks.generate.mockResolvedValue(result());
  mocks.prepareFiles.mockResolvedValue(undefined);
  mocks.downloadBlob.mockResolvedValue(new Blob(['download copy'], { type: 'image/png' }));
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('OffscreenCanvas', class {}); vi.stubGlobal('DecompressionStream', class {});
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:test'); static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; active = undefined; vi.unstubAllGlobals();
});

describe('hosted image history integration with a synthetic inference client', () => {
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
  it('respects fixed seeds and does not change settings for an invalid request or a busy reroll', async () => {
    const view = open(); view.seedMode.value = 'fixed'; view.parameters.value.seed = '9223372036854775807';
    await view.generate();
    expect(mocks.generate.mock.calls[0]?.[0].request.parameters.seed).toBe('9223372036854775807');
    view.seedMode.value = 'random'; view.parameters.value.width = -1;
    await view.generate(); expect(view.parameters.value.seed).toBe('9223372036854775807');
    expect(mocks.generate).toHaveBeenCalledOnce();
    view.parameters.value.width = 256; view.randomizeSeed(); expect(view.seedMode.value).toBe('fixed');
    const seed = view.parameters.value.seed;
    const pending = Promise.withResolvers<ReturnType<typeof result>>(); mocks.generate.mockReturnValueOnce(pending.promise);
    const generation = view.generate(); view.randomizeSeed(); expect(view.parameters.value.seed).toBe(seed);
    pending.resolve(result()); await generation;
  });
});
