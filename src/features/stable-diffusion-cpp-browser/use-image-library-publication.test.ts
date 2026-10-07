// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes } from './model-recipes';
import { scanImageRepositories, type ModelInventory } from './logic/model-candidates';
import { ggufFixture, zImageTensors } from './test-utils/weights';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), download: vi.fn(), inspect: vi.fn(), change: vi.fn(), stopDownload: vi.fn() }));
vi.mock('./download-worker/client', () => ({ downloadImageRecipeInWorker: (...args: unknown[]) => mocks.download(...args) }));
vi.mock('./inventory-worker/client', () => ({ inspectImageInventory: (...args: unknown[]) => mocks.inspect(...args) }));
vi.mock('./composables/use-host-model-directories', async () => {
  const { createDisabledImageLibrary } = await import('./library-standalone');
  return {
    useHostModelDirectories({ changed, stopDownload }: { changed: () => Promise<void>, stopDownload: ({ id }: { id: string }) => Promise<void> }) {
      mocks.change.mockImplementation(changed);
      mocks.stopDownload.mockImplementation(stopDownload);
      const view = createDisabledImageLibrary().hostDirectories;
      view.destination.value = 'linked-models';
      return { view, registrations: () => [{ id: 'linked-models', name: 'weights' }], refresh: () => mocks.refresh(), downloadDestination: async () => ({ kind: 'host', directoryId: 'linked-models' }) };
    },
  };
});
const scopes: ReturnType<typeof effectScope>[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue(undefined);
  mocks.inspect.mockResolvedValue({ candidates: [], issues: [] });
});

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

function harness() {
  const blocked = ref(false), scope = effectScope(); scopes.push(scope);
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => blocked.value, onSelection() {}, dependencies: undefined }))!;
  return { blocked, scope, library };
}
async function inventory(): Promise<ModelInventory> {
  const file = ggufFixture({ name: 'z-image.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file;
  return scanImageRepositories({
    repositories: [{
      id: 'host/linked-models/org/repo',
      name: 'linked weights',
      hostSource: { directoryId: 'linked-models', directoryName: 'weights', repository: 'org/repo' },
      files: [{ path: file.name, file }],
    }],
    signal: undefined,
  });
}

it('releases cancellation while the final host permission refresh is pending and ignores its late failure', async () => {
  const { library } = harness();
  const pending = Promise.withResolvers<void>();
  mocks.refresh.mockReturnValueOnce(pending.promise);
  const downloading = library.downloadRecipe({ recipeId: imageModelRecipes[0]!.id, selections: {} });
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  library.cancelDownload(); await downloading;
  expect(library.downloading.value).toBe(false);
  expect(library.downloadState.value).toBe('paused');
  pending.reject(new Error('Late permission lookup failure'));
  await new Promise(resolve => setImmediate(resolve));
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(library.failure.value).toBe('');
});

it('settles the linked-folder stopDownload callback during inventory publication while the editor is busy', async () => {
  const { library, blocked } = harness();
  const pending = Promise.withResolvers<ModelInventory>();
  mocks.inspect.mockReturnValueOnce(pending.promise);
  mocks.download.mockImplementation(async () => {
    blocked.value = true;
  });
  const downloading = library.downloadRecipe({ recipeId: imageModelRecipes[0]!.id, selections: {} });
  await new Promise(resolve => setImmediate(resolve));
  expect(library.downloading.value).toBe(true);
  await mocks.stopDownload({ id: 'linked-models' }); await downloading;
  expect(library.downloading.value).toBe(false);
  expect(library.downloadState.value).toBe('paused');
  blocked.value = false; await new Promise(resolve => setImmediate(resolve));
  expect(mocks.inspect).toHaveBeenCalledOnce();
  pending.resolve({ candidates: [], issues: [] });
});

it.each(['before inspection', 'during inspection'] as const)('publishes a completed linked-folder change after saving ends %s', async timing => {
  const { library, blocked } = harness();
  const next = await inventory(), pending = Promise.withResolvers<ModelInventory>();
  mocks.inspect.mockResolvedValue(next);
  if (timing === 'during inspection') mocks.inspect.mockReturnValueOnce(pending.promise);
  else blocked.value = true;
  let settled = false;
  const changing = mocks.change().then(() => {
    settled = true;
  });
  if (timing === 'during inspection') {
    await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalledOnce());
    blocked.value = true; pending.resolve(next);
  }
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(library.models.value).toEqual([]);
  blocked.value = false; await changing;
  expect(library.models.value).toHaveLength(1);
  expect(settled).toBe(true);
});

it('disposes a deferred linked-folder publication without a later inventory update', async () => {
  const { library, blocked, scope } = harness();
  blocked.value = true;
  let settled = false;
  const changing = mocks.change().then(() => {
    settled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  scope.stop(); await changing;
  blocked.value = false; await new Promise(resolve => setImmediate(resolve));
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(library.models.value).toEqual([]);
});
