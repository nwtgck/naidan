// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes, selectedRecipeFiles } from './model-recipes';
import { listImageRepositories, importImageRepository } from './logic/repository-store';
import { scanImageRepositories } from './logic/model-candidates';
import { downloadImageRecipe } from './logic/catalog-download';
import { qwenRecipeFixtureBytes } from './test-utils/catalog-weights';
import { MemoryDirectory } from './test-utils/storage';
import { privacyFetchStream, type PrivacyFetchStreamResponse } from '@/features/privacy-fetch';
const calls = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: calls.fetch }));
const recipe = imageModelRecipes.find(recipe => recipe.id === 'qwen-image-2.1')!;
const files = selectedRecipeFiles({ recipe, selections: {} });
let root: MemoryDirectory;
const scopes: ReturnType<typeof effectScope>[] = [];
function library() {
  const scope = effectScope(); scopes.push(scope);
  return scope.run(() => useImageLibrary({ blocked: () => false, onSelection() {}, dependencies: {
    download: args => downloadImageRecipe({ ...args, fetch: privacyFetchStream }), list: listImageRepositories, scan: scanImageRepositories, import: importImageRepository,
  } }))!;
}
beforeEach(() => {
  root = new MemoryDirectory('root'); calls.fetch.mockReset();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, options: { signal?: AbortSignal }, run: () => Promise<void>) => {
    options.signal?.throwIfAborted(); return run();
  } } });
});
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals();
});
async function serve({ layers, failLast }: { layers: number, failLast: boolean }): Promise<void> {
  const payloads = await Promise.all(files.map(file => qwenRecipeFixtureBytes({ file, layers })));
  calls.fetch.mockImplementation(async ({ request }: { request: { url: string } }): Promise<PrivacyFetchStreamResponse> => {
    const index = files.findIndex(file => request.url.includes(file.repository + '/'));
    const file = files[index]!, payload = payloads[index]!;
    const meta = request.url.includes('/api/');
    const status = failLast && !meta && file.role === 'lm' ? 403 : 200;
    const bytes = meta ? new TextEncoder().encode(JSON.stringify([{ type: 'file', path: file.path, size: payload.length, lfs: { size: payload.length, oid: createHash('sha256').update(payload).digest('hex') } }])) : payload;
    return { url: request.url, status, statusText: '', ok: status === 200, redirected: false, responseType: 'basic', headers: new Headers(), policyName: 'huggingface_models',
      body: new ReadableStream({ start(controller) {
        controller.enqueue(bytes); controller.close();
      } }),
    };
  });
}
it('downloads -> verifies -> publishes -> inventories -> selects the actual three pinned Qwen recipe paths, including the 36-layer encoder', async () => {
  await serve({ layers: 36, failLast: false });
  const view = library();
  await view.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(view.downloadState.value).toBe('complete'); expect(view.ready.value).toBe(true);
  expect(view.selectedModels()?.map(model => [model.slot, model.path])).toEqual(files.map(file => [file.role, file.path]));
  expect(view.components.value.find(component => component.slot === 'lm')?.selected).toContain(files[2]!.path);
  const inventory = await listImageRepositories({ signal: undefined });
  expect(inventory.flatMap(repo => repo.files).every(file => file.receipt?.source.kind === 'hugging-face')).toBe(true);
  calls.fetch.mockClear();
  const reopened = library(); await reopened.refresh();
  reopened.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(reopened.ready.value).toBe(true); expect(calls.fetch).not.toHaveBeenCalled();
});
it('does not call a fully downloaded but structurally wrong encoder ready; a filename cannot bypass classification', async () => {
  await serve({ layers: 32, failLast: false });
  const view = library(); await view.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(view.downloadState.value).toBe('incomplete'); expect(view.ready.value).toBe(false);
  expect(view.components.value.find(component => component.slot === 'lm')?.selected).toBe('');
  expect(view.recipeAvailability({ recipeId: recipe.id, selections: {} }).available).toBe(2);
});
it('retains earlier complete files when the third download fails and reuses them on retry', async () => {
  await serve({ layers: 36, failLast: true });
  const view = library(); await view.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(view.downloadState.value).toBe('failed'); expect(view.ready.value).toBe(false);
  expect((await listImageRepositories({ signal: undefined })).flatMap(repo => repo.files)).toHaveLength(2);
  await serve({ layers: 36, failLast: false }); calls.fetch.mockClear();
  await view.resumeDownload();
  expect(view.downloadState.value).toBe('complete'); expect(view.ready.value).toBe(true);
  expect(calls.fetch.mock.calls.filter(([{ request }]) => !request.url.includes('/api/'))).toHaveLength(1);
});
