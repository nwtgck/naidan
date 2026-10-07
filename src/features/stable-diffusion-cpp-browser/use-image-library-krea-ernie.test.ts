// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes } from './model-recipes';
import { scanImageRepositories } from './logic/model-candidates';
import type { listImageRepositories } from './logic/repository-store';
import { ggufFixture, safetensorsFixture, krea2Tensors, krea2GgufTensors, ernieImageTensors, wanVaeTensors, flux2VaeTensors, qwenTextTensors, ministralTextTensors } from './test-utils/weights';
import { benchmarkParameters } from './benchmark/plan';
import { parametersFixture } from './test-fixtures';

it.each([
  { id: 'krea2-turbo', flattened: false, destination: 'opfs' },
  { id: 'ernie-image-turbo', flattened: false, destination: 'opfs' },
  { id: 'krea2-turbo', flattened: true, destination: 'opfs' },
  { id: 'krea2-turbo', flattened: true, destination: 'linked-models' },
] as const)('downloads and selects original $id files (flattened=$flattened, $destination)', async ({ id, flattened, destination }) => {
  const recipe = imageModelRecipes.find(recipe => recipe.id === id)!;
  const krea = id === 'krea2-turbo';
  // Synthetic headers preserve file identity/path but do not prove real inference.
  const entries = recipe.files.map(entry => {
    const tensors = entry.role === 'diffusion' ? krea ? flattened ? krea2GgufTensors : krea2Tensors : ernieImageTensors
      : entry.role === 'vae' ? krea ? wanVaeTensors : flux2VaeTensors
        : krea ? qwenTextTensors({ width: 2560, layers: 36 }) : ministralTextTensors;
    const file = entry.role === 'vae' ? safetensorsFixture({ name: entry.path, tensors }).file
      : ggufFixture({ name: entry.path, tensors, metadata: entry.role === 'lm' ? { 'general.architecture': krea ? 'qwen3vl' : 'mistral3' } : flattened ? { 'general.architecture': 'krea2' } : {}, extraBytes: 0 }).file;
    // saveImageCatalogFile publishes OPFS bytes under main, while receipts
    // and network requests still identify the exact pinned source revision.
    return { id: destination === 'opfs' ? `huggingface.co/${entry.repository}/resolve/main` : `host/${destination}/${entry.repository}`, name: entry.repository,
      ...(destination === 'opfs' ? {} : { hostSource: { directoryId: destination, directoryName: 'Linked models', repository: entry.repository } }),
      files: [{ path: entry.path, file, receipt: { version: 1 as const, kind: 'naidan-model-file' as const, size: file.size, lastModified: file.lastModified,
        source: { kind: 'hugging-face' as const, repository: entry.repository, revision: entry.revision, path: entry.path, sha256: '0'.repeat(64) } } }] };
  });
  let available = entries.slice(0, 1);
  const scope = effectScope();
  try {
    const download = vi.fn(async () => {
      available = entries;
    });
    const list = vi.fn<typeof listImageRepositories>(async ({ repositoryIds }) => repositoryIds ? available.filter(entry => repositoryIds.includes(entry.id)) : available);
    const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => false, onSelection() {}, dependencies: {
      list, scan: scanImageRepositories, import: vi.fn(), download,
    } }))!;
    library.hostDirectories.destination.value = destination;
    await library.refresh(); library.chooseRecipe({ recipeId: id, selections: {} });
    expect(library.selectedFacts.value).toMatchObject({ family: krea ? 'krea2' : 'ernie-image', variant: 'turbo' });
    expect(library.ready.value).toBe(false); expect(library.selectedModels()).toBeUndefined();
    expect(library.benchmarkTargets({ selections: {} })[0]?.missing).toEqual(['vae', 'lm']);
    await library.downloadRecipe({ recipeId: id, selections: {} });
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ files: recipe.files }));
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryIds: destination === 'opfs' ? [...new Set(entries.map(entry => entry.id))] : undefined }));
    expect(library.ready.value).toBe(true); expect(library.downloadState.value).toBe('complete');
    expect(library.recipeAvailability({ recipeId: id, selections: {} })).toMatchObject({ total: 3, available: 3, selected: true });
    // A fresh inventory scan must also recognize already saved files.
    await library.refresh();
    expect(library.ready.value).toBe(true);
    expect(library.recipeAvailability({ recipeId: id, selections: {} }).available).toBe(3);
    const models = library.selectedModels()!;
    expect(models.map(model => model.slot)).toEqual(['diffusion', 'vae', 'lm']);
    for (const [index, model] of models.entries()) {
      expect(model.file).toBe(entries[index]!.files[0]!.file);
      expect(model.path).toBe(recipe.files[index]!.path);
    }
    const target = library.benchmarkTargets({ selections: {} })[0]!;
    expect(target.models).toEqual(models);
    const common = { ...parametersFixture(), steps: 3 };
    const resolved = benchmarkParameters({ common, target, strategy: 'model-defaults', overrides: {} });
    expect(resolved.preset).toBe(id);
    expect(resolved.parameters).toMatchObject({ steps: 3, guidance: 1 });
    const omitted = library.benchmarkTargets({ selections: { [target.id]: { lm: '' } } })[0]!;
    expect(omitted.models).toBeUndefined(); expect(omitted.missing).toEqual(['lm']);
    expect(library.ready.value).toBe(true);
  } finally {
    scope.stop();
  }
});
