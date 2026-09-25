// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes, selectedRecipeFiles, type ImageRecipeFile } from './model-recipes';
import { scanImageRepositories } from './logic/model-candidates';
import type { downloadImageRecipe } from './logic/catalog-download';
import type { LocalImageRepository } from './logic/repository-store';
import { ggufFixture, safetensorsFixture, zImageTensors, fluxVaeTensors, qwenTextTensors } from './test-utils/weights';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});
const recipe = imageModelRecipes[0]!;
function repository({ file, user }: { file: ImageRecipeFile, user: boolean }): LocalImageRepository {
  const name = file.path.split('/').at(-1)!;
  const blob = file.role === 'vae'
    ? safetensorsFixture({ name, tensors: fluxVaeTensors }).file
    : ggufFixture({ name, tensors: file.role === 'diffusion' ? zImageTensors : qwenTextTensors({ width: 2560, layers: 36 }),
      metadata: file.role === 'lm' ? { 'general.architecture': 'qwen3' } : {}, extraBytes: 0 }).file;
  const id = user ? `user/${file.repository.split('/')[1]}` : `huggingface.co/${file.repository}/resolve/main`;
  return { id, name: id, files: [{ path: file.path, file: blob }] };
}
function harness({ download, initial }: { download: typeof downloadImageRecipe | undefined, initial: LocalImageRepository[] }) {
  let entries = initial; let blocked = false;
  const downloader = vi.fn(download ?? (async () => undefined));
  const list = vi.fn(async () => entries), onSelection = vi.fn();
  const scope = effectScope(); scopes.push(scope);
  const library = scope.run(() => useImageLibrary({ blocked: () => blocked, onSelection,
    dependencies: { list, scan: scanImageRepositories, import: vi.fn(), download: downloader } }))!;
  return { library, downloader, list, onSelection, scope,
    update({ repositories }: { repositories: LocalImageRepository[] }) {
      entries = repositories;
    },
    block() {
      blocked = true;
    },
  };
}
it('does not fetch on construction, refresh, or explicit selection from local files', async () => {
  const files = selectedRecipeFiles({ recipe, selections: {} });
  const h = harness({ initial: files.map(file => repository({ file, user: true })), download: undefined });
  expect(h.list).not.toHaveBeenCalled(); expect(h.downloader).not.toHaveBeenCalled();
  await h.library.refresh(); h.library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.map(model => model.path)).toEqual(files.map(file => file.path));
  expect(h.downloader).not.toHaveBeenCalled();
});
it('retains the explicitly requested quantization after downloads, even if a smaller default already exists', async () => {
  const defaults = selectedRecipeFiles({ recipe, selections: {} });
  const choices = { diffusion: 'q8-0' }; const wanted = selectedRecipeFiles({ recipe, selections: choices });
  const h = harness({ initial: defaults.map(file => repository({ file, user: true })), download: undefined });
  await h.library.refresh();
  h.downloader.mockImplementation(async ({ files }) => {
    expect(files.map(file => file.path)).toEqual(wanted.map(file => file.path));
    h.update({ repositories: [...defaults.map(file => repository({ file, user: true })), ...wanted.map(file => repository({ file, user: false }))] });
  });
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: choices });
  expect(h.library.downloadState.value).toBe('complete'); expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.[0]?.path).toBe('z_image_turbo-Q8_0.gguf');
  expect(h.library.main.value).toContain('huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main');
  await h.library.refresh(); expect(h.library.selectedModels()?.[0]?.path).toBe('z_image_turbo-Q8_0.gguf');
});
it('keeps the desired recipe while directories arrive in separate actions; no conversion or merged repo is needed', async () => {
  const files = selectedRecipeFiles({ recipe, selections: {} });
  const h = harness({ initial: [], download: undefined });
  h.library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  for (let count = 1; count <= files.length; count++) {
    h.update({ repositories: files.slice(0, count).map(file => repository({ file, user: true })) });
    await h.library.refresh(); expect(h.library.ready.value).toBe(count === files.length);
  }
  expect(h.library.selectedModels()).toHaveLength(3);
  expect(h.downloader).not.toHaveBeenCalled();
});
it('preserves a failure and still refreshes completed files instead of selecting an unintended complete recipe', async () => {
  const files = selectedRecipeFiles({ recipe, selections: {} });
  const h = harness({ initial: [], download: undefined });
  h.downloader.mockImplementation(async () => {
    h.update({ repositories: [repository({ file: files[0]!, user: false })] });
    throw new Error('Second repository denied');
  });
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.downloadState.value).toBe('failed'); expect(h.library.failure.value).toContain('Second repository denied');
  expect(h.library.models.value).toHaveLength(1); expect(h.library.ready.value).toBe(false);
});
it('blocks generation selections during download and cancels without publishing a completion', async () => {
  const h = harness({ initial: [], download: async ({ signal }) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true });
  }) });
  const running = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.downloading.value).toBe(true); expect(h.library.ready.value).toBe(false);
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: {} }); expect(h.downloader).toHaveBeenCalledTimes(1);
  h.library.cancelDownload(); await running;
  expect(h.library.downloadState.value).toBe('cancelled'); expect(h.library.downloading.value).toBe(false);
});
it('aborts a pending download on scope disposal and ignores late completion', async () => {
  let signal: AbortSignal | undefined;
  const h = harness({ initial: [], download: async args => {
    signal = args.signal;
  } });
  const running = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  h.scope.stop(); await running;
  expect(signal?.aborted).toBe(true); expect(h.list).not.toHaveBeenCalled();
});
