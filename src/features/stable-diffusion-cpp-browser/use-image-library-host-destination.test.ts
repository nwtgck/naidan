// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes } from './model-recipes';
import type { ImageRecipeDownloadRequest } from './logic/catalog-download';
import { MemoryDirectory, MemoryFile } from './test-utils/storage';
import ImageModelCatalog from './components/ImageModelCatalog.vue';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn(), download: vi.fn(), inspect: vi.fn() }));
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: mocks.get, put: mocks.put, delete: mocks.delete } }));
vi.mock('./download-worker/client', () => ({ downloadImageRecipeInWorker: (...args: unknown[]) => mocks.download(...args) }));
vi.mock('./inventory-worker/client', () => ({ inspectImageInventory: (...args: unknown[]) => mocks.inspect(...args) }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings, updateExperimental: update }) }));

let settings: Ref<Settings>;
const update = vi.fn(async ({ updater }: { updater: ({ experimental }: { experimental: Settings['experimental'] }) => Settings['experimental'] }) => {
  settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
});
const handles = new Map<string, MemoryDirectory>();
const scopes: ReturnType<typeof effectScope>[] = [];
const recipeId = imageModelRecipes[0]!.id;
let wrapper: VueWrapper | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  settings = ref<Settings>({
    ...DEFAULT_SETTINGS,
    storageType: 'local',
    endpoint: { type: 'openai', url: '' },
    experimental: {
      hostModelDirectories: [
        { id: toHostModelDirectoryId({ raw: 'selected' }), name: 'models' },
        { id: toHostModelDirectoryId({ raw: 'other' }), name: 'other models' },
      ],
    },
  });
  handles.clear(); handles.set('selected', new MemoryDirectory('models')); handles.set('other', new MemoryDirectory('other models'));
  mocks.get.mockImplementation(async ({ id }: { id: string }) => handles.get(id));
  mocks.delete.mockImplementation(async ({ id }: { id: string }) => {
    handles.delete(id);
  });
  mocks.download.mockResolvedValue(undefined);
  mocks.inspect.mockResolvedValue({ candidates: [], issues: [] });
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, operation: () => Promise<void>) => operation() } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
  for (const scope of scopes.splice(0)) scope.stop();
  vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'showDirectoryPicker');
});

it('allows the catalog to download into a linked folder without OPFS', async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  const { library } = await harness();
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, downloadDisabled: false, view: library } });
  expect(wrapper.get<HTMLOptionElement>('option[value="opfs"]').element.disabled).toBe(true);
  expect(wrapper.get<HTMLOptionElement>('option[value="selected"]').element.disabled).toBe(false);
  const download = wrapper.get<HTMLButtonElement>('[data-testid="recipe-download-selected-z-image-turbo"]');
  expect(download.element.disabled).toBe(false);
  await download.trigger('click'); await flushPromises();
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(mocks.download.mock.calls[0]?.[0].destination).toEqual({ kind: 'host', directoryId: 'selected' });
});

async function harness() {
  const blocked = ref(false), scope = effectScope(); scopes.push(scope);
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => blocked.value, onSelection() {}, dependencies: undefined }))!;
  await library.refresh();
  library.hostDirectories.selectDestination({ id: 'selected' });
  return { library, blocked };
}

function waitForAbort({ signal }: ImageRecipeDownloadRequest): Promise<void> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    signal.throwIfAborted();
  });
}

it.each(['paused', 'failed'] as const)('requires a new explicit download after unlinking the %s destination', async state => {
  const { library } = await harness();
  const folder = handles.get('selected')!;
  const partial = new MemoryFile('partial.gguf'); partial.data = new Uint8Array([1, 2, 3]);
  folder.children.set(partial.name, partial);
  if (state === 'paused') mocks.download.mockImplementationOnce(waitForAbort);
  else mocks.download.mockRejectedValueOnce(new Error('Transfer failed'));
  const downloading = library.downloadRecipe({ recipeId, selections: {} });
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  if (state === 'paused') library.cancelDownload();
  await downloading;
  expect(library.downloadState.value).toBe(state);
  expect(mocks.download.mock.calls[0]?.[0].destination).toEqual({ kind: 'host', directoryId: 'selected' });
  await library.hostDirectories.remove({ id: 'selected' });
  expect(library.hostDirectories.destination.value).toBe('opfs');
  await library.resumeDownload();
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(library.downloadState.value).toBe('idle');
  expect(library.downloadRecipeId.value).toBe('');
  expect(library.downloadProgress.value).toBeUndefined();
  expect(folder.children.get(partial.name)).toBe(partial);
  expect(Array.from(partial.data)).toEqual([1, 2, 3]);
  await library.downloadRecipe({ recipeId, selections: {} });
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.download.mock.calls[1]?.[0].destination).toEqual({ kind: 'opfs' });
});

it('forgets the aborted intent when unlinking its destination during a transfer', async () => {
  const { library } = await harness();
  mocks.download.mockImplementationOnce(waitForAbort);
  const downloading = library.downloadRecipe({ recipeId, selections: {} });
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  await library.hostDirectories.remove({ id: 'selected' }); await downloading;
  expect(library.downloading.value).toBe(false);
  expect(library.hostDirectories.destination.value).toBe('opfs');
  await library.resumeDownload();
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(library.downloadState.value).toBe('idle');
});

it('invalidates the old destination even when an independent save starts during unlink', async () => {
  const { library, blocked } = await harness();
  mocks.download.mockRejectedValueOnce(new Error('Transfer failed'));
  await library.downloadRecipe({ recipeId, selections: {} });
  const pending = Promise.withResolvers<void>();
  update.mockImplementationOnce(async ({ updater }) => {
    await pending.promise;
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
  });
  const removing = library.hostDirectories.remove({ id: 'selected' });
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  blocked.value = true; pending.resolve();
  await vi.waitFor(() => expect(library.hostDirectories.destination.value).toBe('opfs'));
  expect(library.downloadRecipeId.value).toBe('');
  blocked.value = false; await removing;
  await library.resumeDownload();
  expect(mocks.download).toHaveBeenCalledOnce();
});

it('keeps the same destination resumable through refresh and removal of another root', async () => {
  const { library } = await harness();
  mocks.download.mockRejectedValueOnce(new Error('Transfer failed'));
  await library.downloadRecipe({ recipeId, selections: {} });
  await library.refresh();
  await library.hostDirectories.remove({ id: 'other' });
  expect(library.hostDirectories.destination.value).toBe('selected');
  expect(library.downloadRecipeId.value).toBe(recipeId);
  expect(library.downloadState.value).toBe('failed');
  await library.resumeDownload();
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.download.mock.calls[1]?.[0].destination).toEqual({ kind: 'host', directoryId: 'selected' });
});

it('invalidates the active intent when its final refresh discovers a removed registration', async () => {
  const { library } = await harness();
  mocks.download.mockImplementationOnce(async () => {
    settings.value.experimental = { ...settings.value.experimental, hostModelDirectories: [] };
  });
  await library.downloadRecipe({ recipeId, selections: {} });
  expect(library.hostDirectories.destination.value).toBe('opfs');
  expect(library.downloadState.value).toBe('idle');
  expect(library.downloadRecipeId.value).toBe('');
  await library.resumeDownload();
  expect(mocks.download).toHaveBeenCalledOnce();
});

it('keeps a failed transfer resumable when unlinking its registration fails', async () => {
  const { library } = await harness();
  mocks.download.mockRejectedValueOnce(new Error('Transfer failed'));
  await library.downloadRecipe({ recipeId, selections: {} });
  update.mockRejectedValueOnce(new Error('Settings could not be saved'));
  await library.hostDirectories.remove({ id: 'selected' });
  expect(library.hostDirectories.destination.value).toBe('selected');
  expect(library.downloadRecipeId.value).toBe(recipeId);
  await library.resumeDownload();
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.download.mock.calls[1]?.[0].destination).toEqual({ kind: 'host', directoryId: 'selected' });
});

it('keeps each queued destination fixed while the user selects another linked folder', async () => {
  const { library } = await harness();
  const pending = Promise.withResolvers<void>();
  mocks.download.mockReturnValueOnce(pending.promise);
  const first = library.downloadRecipe({ recipeId, selections: {} });
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  library.hostDirectories.selectDestination({ id: 'other' });
  const second = library.downloadRecipe({ recipeId, selections: {} });
  library.hostDirectories.selectDestination({ id: 'opfs' });
  expect(library.downloadQueue.value.map(job => job.destination)).toEqual(['models', 'other models']);
  pending.resolve(); await Promise.all([first, second]);
  expect(mocks.download.mock.calls.map(call => call[0].destination)).toEqual([
    { kind: 'host', directoryId: 'selected' }, { kind: 'host', directoryId: 'other' },
  ]);
});

it('drops only jobs for a successfully unlinked root and keeps other queued downloads', async () => {
  const { library } = await harness();
  mocks.download.mockImplementationOnce(waitForAbort);
  const first = library.downloadRecipe({ recipeId, selections: {} });
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  const sameRoot = library.downloadRecipe({ recipeId, selections: { diffusion: 'q8-0' } });
  library.hostDirectories.selectDestination({ id: 'other' });
  const otherRoot = library.downloadRecipe({ recipeId, selections: {} });
  await library.hostDirectories.remove({ id: 'selected' });
  await Promise.all([first, sameRoot, otherRoot]);
  expect(mocks.download.mock.calls.map(call => call[0].destination)).toEqual([
    { kind: 'host', directoryId: 'selected' }, { kind: 'host', directoryId: 'other' },
  ]);
});

it('keeps an unavailable restored root through scans and rejects downloads rather than writing to OPFS', async () => {
  const { library } = await harness();
  library.hostDirectories.destination.value = 'not-registered';
  await library.refresh();
  settings.value = { ...settings.value, experimental: { ...settings.value.experimental, locale: 'ja' } };
  await flushPromises();
  expect(library.hostDirectories.destination.value).toBe('not-registered');
  await library.downloadRecipe({ recipeId, selections: {} });
  expect(mocks.download).not.toHaveBeenCalled(); expect(library.downloadState.value).toBe('failed');
  expect(library.hostDirectories.destination.value).toBe('not-registered');
});
