// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes, selectedRecipeFiles, type ImageRecipeFile } from './model-recipes';
import { scanImageRepositories } from './logic/model-candidates';
import type { ImageRecipeDownloader } from './logic/catalog-download';
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
    : ggufFixture({
      name,
      tensors: file.role === 'diffusion' ? zImageTensors : qwenTextTensors({ width: 2560, layers: 36 }),
      metadata: file.role === 'lm' ? { 'general.architecture': 'qwen3' } : {},
      extraBytes: 0,
    }).file;
  const id = user ? `user/${file.repository.split('/')[1]}` : `huggingface.co/${file.repository}/resolve/main`;
  return { id, name: id, files: [{ path: file.path, file: blob }] };
}
function harness({ download, initial }: { download: ImageRecipeDownloader | undefined, initial: LocalImageRepository[] }) {
  let entries = initial; const blocked = ref(false);
  const downloader = vi.fn(download ?? (async () => undefined));
  const list = vi.fn(async (_options: { signal?: AbortSignal }) => entries), onSelection = vi.fn();
  const scope = effectScope(); scopes.push(scope);
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => blocked.value,
    onSelection,
    dependencies: { list, scan: scanImageRepositories, import: vi.fn(), download: downloader },
  }))!;
  return {
    library,
    downloader,
    list,
    onSelection,
    scope,
    update({ repositories }: { repositories: LocalImageRepository[] }) {
      entries = repositories;
    },
    block() {
      blocked.value = true;
    },
    unblock() {
      blocked.value = false;
    },
  };
}

it('publishes downloaded inventory during an independent save without changing the editor', async () => {
  const wanted = selectedRecipeFiles({ recipe, selections: {} }).map(file => repository({ file, user: false }));
  const h = harness({ initial: wanted, download: undefined });
  h.downloader.mockImplementation(async () => h.block());
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.list).toHaveBeenCalledOnce();
  expect(h.library.downloadState.value).toBe('complete');
  expect(h.library.models.value.length).toBeGreaterThan(0);
  expect(h.library.main.value).toBe('');
  h.unblock();
  expect(h.library.main.value).toBe('');
});

it('keeps an independent save that begins during final inspection from changing the editor', async () => {
  const wanted = selectedRecipeFiles({ recipe, selections: {} }).map(file => repository({ file, user: false }));
  const h = harness({ initial: wanted, download: undefined });
  const reading = Promise.withResolvers<LocalImageRepository[]>();
  h.list.mockReturnValueOnce(reading.promise);
  const operation = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
  h.block(); reading.resolve(wanted); await operation;
  expect(h.library.downloading.value).toBe(false);
  expect(h.library.main.value).toBe('');
  h.unblock();
  expect(h.list).toHaveBeenCalledOnce();
  expect(h.library.downloadState.value).toBe('complete');
});

it.each(['cancel', 'dispose'] as const)('settles pending publication on %s while an independent save is active', async action => {
  const h = harness({ initial: [], download: undefined });
  const reading = Promise.withResolvers<LocalImageRepository[]>();
  h.list.mockReturnValueOnce(reading.promise);
  h.downloader.mockImplementation(async () => h.block());
  const operation = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
  expect(h.library.downloading.value).toBe(true);
  if (action === 'cancel') h.library.cancelDownload(); else h.scope.stop();
  await operation;
  expect(h.library.downloading.value).toBe(false);
  if (action === 'cancel') expect(h.library.downloadState.value).toBe('paused');
  h.unblock(); reading.resolve([]); await new Promise(resolve => setImmediate(resolve));
  expect(h.list).toHaveBeenCalledOnce();
});

it('cancels an unresponsive final inspection and ignores its late result', async () => {
  const h = harness({ initial: [], download: undefined });
  const reading = Promise.withResolvers<LocalImageRepository[]>();
  h.list.mockReturnValueOnce(reading.promise);
  const operation = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
  h.library.cancelDownload();
  await operation;
  expect(h.library.downloadState.value).toBe('paused');
  expect(h.library.downloading.value).toBe(false);
  reading.reject(new Error('Late platform read failure'));
  await new Promise(resolve => setImmediate(resolve));
  expect(h.library.failure.value).toBe('');
});

it('finds completed files on the next refresh after cancellation interrupts the final inspection', async () => {
  const wanted = selectedRecipeFiles({ recipe, selections: {} }).map(file => repository({ file, user: false }));
  const h = harness({ initial: wanted, download: undefined });
  const reading = Promise.withResolvers<LocalImageRepository[]>();
  h.list.mockReturnValueOnce(reading.promise);
  const operation = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
  h.library.cancelDownload(); await operation;
  await h.library.refresh();
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(h.downloader).toHaveBeenCalledOnce();
  expect(h.library.ready.value).toBe(true);
  reading.resolve([]); await new Promise(resolve => setImmediate(resolve));
  expect(h.library.ready.value).toBe(true);
});

it('does not retry a real inspection failure when the editor later becomes available', async () => {
  const h = harness({ initial: [], download: undefined });
  h.list.mockRejectedValueOnce(new DOMException('Repository unavailable', 'NotReadableError'));
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.downloadState.value).toBe('incomplete');
  expect(h.library.failure.value).toBe('Repository unavailable');
  h.block(); h.unblock(); await new Promise(resolve => setImmediate(resolve));
  expect(h.list).toHaveBeenCalledOnce();
});

it('does not fetch on construction, refresh, or explicit selection from local files', async () => {
  const files = selectedRecipeFiles({ recipe, selections: {} });
  const h = harness({ initial: files.map(file => repository({ file, user: true })), download: undefined });
  expect(h.list).not.toHaveBeenCalled(); expect(h.downloader).not.toHaveBeenCalled();
  await h.library.refresh(); h.library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.map(model => model.path)).toEqual(files.map(file => file.path));
  expect(h.downloader).not.toHaveBeenCalled();
});

it('keeps identical repository files in OPFS and two linked roots distinct and checks the selected destination', async () => {
  const files = selectedRecipeFiles({ recipe, selections: {} });
  const opfs = files.map(file => repository({ file, user: false }));
  function host({ rootId }: { rootId: string }): LocalImageRepository[] {
    return files.map(file => ({
      ...repository({ file, user: false }),
      id: `host/${rootId}/${file.repository}`,
      hostSource: { directoryId: rootId, directoryName: 'same-folder-name', repository: file.repository },
    }));
  }
  const h = harness({ initial: [...opfs, ...host({ rootId: 'first' }), ...host({ rootId: 'second' })], download: undefined });
  await h.library.refresh();
  expect(h.library.models.value).toHaveLength(3);
  expect(new Set(h.library.models.value.map(model => model.id)).size).toBe(3);
  expect(h.library.recipeAvailability({ recipeId: recipe.id, selections: {} }).available).toBe(3);
  h.library.hostDirectories.destination.value = 'second';
  h.library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.main.value).toContain('host/second/');
  expect(h.library.selectedModels()?.every(model => model.sourceId === undefined)).toBe(true);
  h.update({ repositories: [...opfs, ...host({ rootId: 'first' })] });
  await h.library.refresh();
  expect(h.library.recipeAvailability({ recipeId: recipe.id, selections: {} }).available).toBe(0);
  h.library.hostDirectories.destination.value = 'opfs';
  expect(h.library.recipeAvailability({ recipeId: recipe.id, selections: {} }).available).toBe(3);
});

it('downloads the requested quantization without replacing an existing model selection', async () => {
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
  expect(h.library.selectedModels()?.[0]?.path).toBe('z_image_turbo-Q4_K.gguf');
  h.library.chooseRecipe({ recipeId: recipe.id, selections: choices });
  expect(h.library.selectedModels()?.[0]?.path).toBe('z_image_turbo-Q8_0.gguf');
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

it('deduplicates active downloads and pauses without publishing a completion', async () => {
  const h = harness({
    initial: [],
    download: async ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true });
    }),
  });
  const running = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.downloading.value).toBe(true); expect(h.library.ready.value).toBe(false);
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: {} }); expect(h.downloader).toHaveBeenCalledTimes(1);
  h.library.cancelDownload(); await running;
  expect(h.library.downloadState.value).toBe('paused'); expect(h.library.downloading.value).toBe(false);
});

it('aborts a pending download on scope disposal and ignores late completion', async () => {
  let signal: AbortSignal | undefined;
  const h = harness({
    initial: [],
    download: async args => {
      signal = args.signal;
      await new Promise<void>(resolve => args.signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  const running = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await vi.waitFor(() => expect(signal).toBeDefined());
  h.scope.stop(); await running;
  expect(signal?.aborted).toBe(true); expect(h.list).not.toHaveBeenCalled();
});

it('keeps uninspected files unavailable until post-download inventory resolves', async () => {
  const wanted = selectedRecipeFiles({ recipe, selections: {} }).map(file => repository({ file, user: false }));
  const pending = Promise.withResolvers<LocalImageRepository[]>();
  const list = vi.fn(() => pending.promise);
  const scope = effectScope(); scopes.push(scope);
  const view = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: {
      list,
      scan: scanImageRepositories,
      import: vi.fn(),
      download: vi.fn(async () => undefined),
    },
  }))!;
  const operation = view.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(view.downloading.value).toBe(true);
  expect(view.downloadState.value).toBe('downloading');
  expect(view.ready.value).toBe(false);
  view.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(view.main.value).toBe('');
  pending.resolve(wanted); await operation;
  expect(view.downloading.value).toBe(false);
  expect(view.downloadState.value).toBe('complete');
  expect(view.ready.value).toBe(true);
});

it('queues explicit downloads in click order with immutable variants while the editor is busy', async () => {
  const gate = Promise.withResolvers<void>();
  const h = harness({ initial: [], download: undefined });
  h.downloader.mockImplementationOnce(() => gate.promise);
  const first = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  const choices = { diffusion: 'q8-0' };
  const second = h.library.downloadRecipe({ recipeId: recipe.id, selections: choices });
  choices.diffusion = 'q4-k';
  h.block();
  const thirdRecipe = imageModelRecipes.find(item => item.id === 'sdxl-base-1.0')!;
  const third = h.library.downloadRecipe({ recipeId: thirdRecipe.id, selections: {} });
  await vi.waitFor(() => expect(h.downloader).toHaveBeenCalledOnce());
  expect(h.library.downloadQueue.value.map(job => job.state)).toEqual(['downloading', 'queued', 'queued']);
  gate.resolve(); await Promise.all([first, second, third]);
  expect(h.downloader).toHaveBeenCalledTimes(3);
  expect(h.downloader.mock.calls[1]![0].files[0]!.path).toBe('z_image_turbo-Q8_0.gguf');
  expect(h.downloader.mock.calls[2]![0].files).toEqual(selectedRecipeFiles({ recipe: thirdRecipe, selections: {} }));
  expect(h.library.main.value).toBe('');
});

it('retains a failed entry and proceeds with other explicitly queued downloads without automatic retry', async () => {
  const gate = Promise.withResolvers<void>();
  const h = harness({ initial: [], download: undefined });
  h.downloader.mockImplementationOnce(() => gate.promise);
  const first = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  const next = h.library.downloadRecipe({ recipeId: recipe.id, selections: { diffusion: 'q8-0' } });
  gate.reject(new Error('Access denied'));
  await Promise.all([first, next]);
  expect(h.downloader).toHaveBeenCalledTimes(2);
  const failed = h.library.downloadQueue.value.find(job => job.state === 'failed')!;
  expect(failed.error).toBe('Access denied');
  expect(h.library.downloadQueue.value).toHaveLength(2);
  await h.library.retryQueuedDownload({ id: failed.id });
  expect(h.downloader).toHaveBeenCalledTimes(3);
  expect(h.downloader.mock.calls[2]![0].files).toEqual(h.downloader.mock.calls[0]![0].files);
});

it('pauses the entire queue and resumes the original job before the next variant', async () => {
  const h = harness({ initial: [], download: undefined });
  h.downloader.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const first = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  const second = h.library.downloadRecipe({ recipeId: recipe.id, selections: { diffusion: 'q8-0' } });
  await vi.waitFor(() => expect(h.downloader).toHaveBeenCalledOnce());
  h.library.cancelDownload(); await first;
  expect(h.library.downloadQueue.value.map(job => job.state)).toEqual(['paused', 'queued']);
  await h.library.resumeDownload(); await second;
  expect(h.downloader).toHaveBeenCalledTimes(3);
  expect(h.downloader.mock.calls[1]![0].files).toEqual(h.downloader.mock.calls[0]![0].files);
  expect(h.downloader.mock.calls[2]![0].files[0]!.path).toBe('z_image_turbo-Q8_0.gguf');
});

it('removes a queued item without fetching it or modifying its partial files', async () => {
  const gate = Promise.withResolvers<void>();
  const h = harness({ initial: [], download: undefined });
  h.downloader.mockImplementationOnce(() => gate.promise);
  const first = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  const second = h.library.downloadRecipe({ recipeId: recipe.id, selections: { diffusion: 'q8-0' } });
  const queued = h.library.downloadQueue.value.find(job => job.state === 'queued')!;
  h.library.removeQueuedDownload({ id: queued.id }); await second;
  gate.resolve(); await first;
  expect(h.downloader).toHaveBeenCalledOnce();
});

it('keeps saved models usable and preserves a manual selection made during another download', async () => {
  const defaults = selectedRecipeFiles({ recipe, selections: {} });
  const alternate = selectedRecipeFiles({ recipe, selections: { diffusion: 'q8-0' } });
  const h = harness({ initial: [...defaults, ...alternate].map(file => repository({ file, user: false })), download: undefined });
  await h.library.refresh();
  const gate = Promise.withResolvers<void>(); h.downloader.mockImplementationOnce(() => gate.promise);
  const downloading = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.ready.value).toBe(true);
  h.library.chooseRecipe({ recipeId: recipe.id, selections: { diffusion: 'q8-0' } });
  expect(h.library.selectedModels()?.[0]?.path).toBe('z_image_turbo-Q8_0.gguf');
  gate.resolve(); await downloading;
  expect(h.library.selectedModels()?.[0]?.path).toBe('z_image_turbo-Q8_0.gguf');
});

it('does not interrupt a history file read when another download is enqueued', async () => {
  const wanted = selectedRecipeFiles({ recipe, selections: {} }).map(file => repository({ file, user: false }));
  const h = harness({ initial: wanted, download: undefined });
  const reading = Promise.withResolvers<LocalImageRepository[]>(); h.list.mockReturnValueOnce(reading.promise);
  const restoring = h.library.prepareHistoryFiles({ requiredFiles: [] });
  await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
  const downloading = h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  await vi.waitFor(() => expect(h.downloader).toHaveBeenCalledOnce());
  expect(h.list.mock.calls[0]![0].signal?.aborted).toBe(false);
  reading.resolve(wanted); await restoring; await downloading;
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(h.library.downloadState.value).toBe('complete');
});

it('retains unrelated user Files after a completed catalog publication without relying on size or timestamp identity', async () => {
  const files = selectedRecipeFiles({ recipe, selections: {} });
  const initial = files.map(file => repository({ file, user: true }));
  const h = harness({ initial, download: undefined }); await h.library.refresh();
  const before = h.library.selectedModels()!;
  const snapshots = initial.map(entry => ({ ...entry, files: entry.files.map(file => ({ ...file, file: new File([file.file], file.file.name, { lastModified: file.file.lastModified }) })) }));
  h.downloader.mockImplementation(async () => {
    h.update({ repositories: [...snapshots, ...files.map(file => repository({ file, user: false }))] });
    h.block();
  });
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  h.unblock();
  expect(h.library.downloadState.value).toBe('complete');
  const after = h.library.selectedModels()!;
  expect(after).toHaveLength(before.length);
  after.forEach((model, index) => expect(model.file).toBe(before[index]!.file));
  await h.library.refresh();
  h.library.selectedModels()!.forEach((model, index) => expect(model.file).not.toBe(before[index]!.file));
});
