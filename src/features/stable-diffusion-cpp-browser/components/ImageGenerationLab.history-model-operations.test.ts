import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationLab.vue';
import ImageGenerationEditor from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationEditor.vue';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { snapshotImageGeneration, finishImageGenerationSnapshot } from '@/features/stable-diffusion-cpp-browser/history/snapshot';
import { imageModelRecipes, selectedRecipeFiles } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import { ggufFixture, safetensorsFixture, zImageTensors, fluxVaeTensors, qwenTextTensors } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';
import { scanImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';

const mocks = vi.hoisted(() => ({ download: vi.fn(), inspect: vi.fn(), query: vi.fn(), getFile: vi.fn(), save: vi.fn(), generate: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/download-worker/client', () => ({ downloadImageRecipeInWorker: (...args: unknown[]) => mocks.download(...args) }));
vi.mock('@/features/stable-diffusion-cpp-browser/inventory-worker/client', () => ({ inspectImageInventory: (...args: unknown[]) => mocks.inspect(...args) }));
vi.mock('@/features/stable-diffusion-cpp-browser/history/worker/client-hosted', () => ({ createImageHistoryClient: () => ({ query: mocks.query, async dispose() {} }) }));
vi.mock('@/features/stable-diffusion-cpp-browser/worker/client', () => ({ createImageClient: () => ({ generate: mocks.generate, release() {}, dispose() {}, cancel() {}, updatePreview() {} }) }));
vi.mock('@/features/stable-diffusion-cpp-browser/use-image-benchmark', () => import('@/features/stable-diffusion-cpp-browser/use-image-benchmark-standalone'));
vi.mock('@/features/stable-diffusion-cpp-browser/capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify', supportsJspi: () => false, supportsMemory64: () => false }));
vi.mock('@/composables/useSettings', async () => {
  const { ref } = await import('vue');
  return { useSettings: () => ({ settings: ref({ experimental: undefined }), updateExperimental: vi.fn() }) };
});
vi.mock('@/00-storage/service', () => ({ storageService: {
  saveImageGeneration: (...args: unknown[]) => mocks.save(...args),
  getCurrentType: () => 'opfs', subscribeToChanges: () => () => {}, getFile: (...args: unknown[]) => mocks.getFile(...args),
} }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', async () => {
  const { artifactFixture } = await import('@/features/stable-diffusion-cpp-browser/test-fixtures');
  return { default: { kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [artifactFixture()] } };
});

let wrapper: VueWrapper<InstanceType<typeof ImageGenerationLab>> | undefined;
function readyInventory() {
  return scanImageRepositories({ repositories: selectedRecipeFiles({ recipe: imageModelRecipes[0]!, selections: {} }).map(source => {
    const name = source.path.split('/').at(-1)!;
    const file = source.role === 'vae' ? safetensorsFixture({ name, tensors: fluxVaeTensors }).file
      : ggufFixture({ name, tensors: source.role === 'diffusion' ? zImageTensors : qwenTextTensors({ width: 2560, layers: 36 }), metadata: source.role === 'lm' ? { 'general.architecture': 'qwen3' } : { 'general.name': 'Z-Image-Turbo' }, extraBytes: 0 }).file;
    return { id: `huggingface.co/${source.repository}/resolve/main`, name: source.repository, files: [{ path: source.path, file }] };
  }), signal: undefined });
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue({ candidates: [], issues: [] });
  mocks.query.mockResolvedValue({ items: [], total: 0, warnings: [], warningCount: 0 });
  mocks.getFile.mockResolvedValue(undefined);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('DecompressionStream', class {});
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:probe');
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});

it('keeps manual model-file generation available when catalog OPFS downloads are unavailable', async () => {
  wrapper = mount(ImageGenerationLab);
  await flushPromises();
  const view = wrapper.getComponent(ImageGenerationEditor).props('view');
  expect(navigator.storage?.getDirectory).toBeUndefined();
  expect(view.supported.value).toBe(true);
  const file = requestFixture().models[0]!.file;
  const input = wrapper.get<HTMLInputElement>('[data-testid="image-file-model"]');
  expect(input.element.disabled).toBe(false);
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
  await input.trigger('change');
  view.parameters.value = requestFixture().parameters;
  view.historySaving.enabled.value = false;
  mocks.generate.mockResolvedValue({ png: new Blob(['png']), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false });
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-generate"]').element.disabled).toBe(false);
  await wrapper.get('[data-testid="image-generate"]').trigger('submit'); await flushPromises();
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(mocks.generate.mock.calls[0]?.[0].request.models).toEqual([{ slot: 'model', file }]);
  expect(mocks.download).not.toHaveBeenCalled();
});

it('locks history editor actions during model downloads and restores them after failure without blocking existing image actions', async () => {
  wrapper = mount(ImageGenerationLab);
  await flushPromises();
  const view = wrapper.getComponent(ImageGenerationEditor).props('view');
  const request = requestFixture();
  request.parameters.prompt = 'Saved request prompt';
  const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), locateFile: ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified }), createdAt: 1 });
  const record = finishImageGenerationSnapshot({ snapshot, result: { png: new Blob(['png']), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false }, previews: [], elapsedMs: 1 }).record;
  view.parameters.value.prompt = 'Previously entered prompt';
  const pending = Promise.withResolvers<void>();
  mocks.download.mockReturnValue(pending.promise);
  const downloading = view.library.downloadRecipe({ recipeId: imageModelRecipes[0]!.id, selections: {} });
  await flushPromises();
  expect(view.library.downloading.value).toBe(true);
  await wrapper.get('[data-testid="image-tab-history"]').trigger('click');
  view.history.selected.value = record;
  await flushPromises();
  for (const action of ['reuse', 'use-initial', 'use-reference']) {
    expect(wrapper.get(`[data-testid="image-history-${action}"]`).attributes('disabled')).toBeDefined();
  }
  for (const action of ['delete', 'delete-image', 'open-viewer']) {
    expect(wrapper.get(`[data-testid="image-history-${action}"]`).attributes('disabled')).toBeUndefined();
  }
  expect(wrapper.get('[data-testid="image-history-download"] button').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="image-tab-history"]').attributes('aria-selected')).toBe('true');
  expect(view.parameters.value.prompt).toBe('Previously entered prompt');
  expect(view.historyActions.error.value).toBe('');
  pending.reject(new Error('Finish test download'));
  await downloading;
  await flushPromises();
  expect(view.library.downloadState.value).toBe('failed');
  expect(wrapper.get('[data-testid="image-history-reuse"]').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="image-tab-generate"]').attributes('aria-selected')).toBe('true');
  expect(view.parameters.value.prompt).toBe(record.request.parameters.prompt);
});

it('publishes a completed download before history images can edit the generation request', async () => {
  wrapper = mount(ImageGenerationLab);
  await flushPromises();
  const view = wrapper.getComponent(ImageGenerationEditor).props('view');
  const recipe = imageModelRecipes[0]!;
  const inventory = await readyInventory();
  const request = requestFixture();
  const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), locateFile: ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified }), createdAt: 1 });
  const record = finishImageGenerationSnapshot({ snapshot, result: { png: new Blob(['png']), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false }, previews: [], elapsedMs: 1 }).record;
  const pendingDownload = Promise.withResolvers<void>();
  mocks.download.mockReturnValue(pendingDownload.promise);
  const downloading = view.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await flushPromises();
  await wrapper.get('[data-testid="image-tab-history"]').trigger('click');
  view.history.selected.value = record;
  await flushPromises();
  const pendingImage = Promise.withResolvers<Blob>();
  mocks.getFile.mockReturnValueOnce(pendingImage.promise);
  const beforeRead = mocks.getFile.mock.calls.length;
  await wrapper.get('[data-testid="image-history-use-initial"]').trigger('click');
  await flushPromises();
  // The owner also rejects programmatic calls while its model files are busy.
  await view.useHistoryImage({ binaryObjectId: record.result.binaryObjectId, role: 'initial' });
  expect(mocks.getFile).toHaveBeenCalledTimes(beforeRead);
  expect(view.historyActions.busy.value).toBe(false);
  mocks.inspect.mockResolvedValue(inventory);
  const beforePublish = mocks.inspect.mock.calls.length;
  pendingDownload.resolve(); await downloading;
  expect(mocks.inspect).toHaveBeenCalledTimes(beforePublish + 1);
  expect(view.library.downloadState.value).toBe('complete');
  expect(view.library.ready.value).toBe(true);
  await flushPromises();
  expect(wrapper.get('[data-testid="image-history-use-initial"]').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-testid="image-history-use-initial"]').trigger('click');
  await flushPromises();
  expect(view.historyActions.busy.value).toBe(true);
  pendingImage.resolve(new Blob(['image'], { type: 'image/png' }));
  await flushPromises();
  expect(view.imageInputs.value.initImage).toBeDefined();
  expect(wrapper.get('[data-testid="image-tab-generate"]').attributes('aria-selected')).toBe('true');
  expect(view.library.recipeAvailability({ recipeId: recipe.id, selections: {} })).toMatchObject({ available: 3, total: 3 });
});

it('allows independent history save retries and publishes downloaded models after saving finishes', async () => {
  mocks.generate.mockResolvedValue({ png: new Blob(['png']), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false });
  mocks.save.mockRejectedValueOnce(new Error('History volume full'));
  wrapper = mount(ImageGenerationLab);
  await flushPromises();
  const view = wrapper.getComponent(ImageGenerationEditor).props('view');
  view.parameters.value = requestFixture().parameters;
  view.files.value = { model: requestFixture().models[0]!.file };
  await view.generate(); await flushPromises();
  expect(view.historySaving.pendingCount.value).toBe(1);
  const pendingDownload = Promise.withResolvers<void>();
  mocks.download.mockReturnValue(pendingDownload.promise);
  const downloading = view.library.downloadRecipe({ recipeId: imageModelRecipes[0]!.id, selections: {} });
  await flushPromises();
  const pendingSave = Promise.withResolvers<void>();
  mocks.save.mockReturnValueOnce(pendingSave.promise);
  expect(wrapper.get('[data-testid="image-history-retry-save"]').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-testid="image-history-retry-save"]').trigger('click');
  expect(view.historySaving.status.value).toBe('saving');
  const previousInspections = mocks.inspect.mock.calls.length;
  mocks.inspect.mockResolvedValue(await readyInventory());
  pendingDownload.resolve(); await flushPromises();
  expect(view.library.downloading.value).toBe(true);
  expect(view.library.downloadState.value).toBe('downloading');
  expect(mocks.inspect).toHaveBeenCalledTimes(previousInspections);
  pendingSave.resolve(); await downloading; await flushPromises();
  expect(view.historySaving.status.value).toBe('saved');
  expect(view.library.downloadState.value).toBe('complete');
  expect(view.library.ready.value).toBe(true);
  expect(view.results.value).toHaveLength(1);
  expect(mocks.inspect).toHaveBeenCalledTimes(previousInspections + 1);
});
