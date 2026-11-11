// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes, selectedRecipeFiles, type ImageRecipeSelection } from './model-recipes';
import { scanImageRepositories } from './logic/model-candidates';
import type { ImageRecipeDownloader } from './logic/catalog-download';
import type { LocalImageRepository } from './logic/repository-store';
import { ggufFixture, safetensorsFixture, wanVaeTensors, qwenTextTensors } from './test-utils/weights.test-support';
import { minimaxH3ImageTensors, minimaxH3ImageVaeTensors, minimaxH3PrunedTextTensors, minimaxH3Int8DiffusionFixture } from './test-utils/minimax-h3-weights.test-support';

const recipe = imageModelRecipes.find(item => item.id === 'minimax-h3-image')!;

// Sparse structural fixtures test inventory identity without materializing
// the published weight payload or claiming that the fixtures can generate.
function repositories({ selections }: { selections: ImageRecipeSelection }): LocalImageRepository[] {
  return selectedRecipeFiles({ recipe, selections }).map(entry => {
    const file = entry.role === 'lm' || entry.path.endsWith('.gguf')
      ? ggufFixture({ name: entry.path, tensors: entry.role === 'lm' ? minimaxH3PrunedTextTensors : minimaxH3ImageTensors, metadata: {}, extraBytes: 0 }).file
      : safetensorsFixture({ name: entry.path, tensors: entry.role === 'vae' ? minimaxH3ImageVaeTensors : minimaxH3ImageTensors }).file;
    return {
      repositoryKey: `huggingface.co/${entry.repository}/resolve/main`,
      repositoryLabel: entry.repository,
      files: [{
        relativePath: entry.path,
        file,
        receipt: {
          version: 1,
          kind: 'naidan-model-file',
          size: file.size,
          lastModified: file.lastModified,
          source: { kind: 'hugging-face', repository: entry.repository, revision: entry.revision, path: entry.path, sha256: '0'.repeat(64) },
        },
      }],
    };
  });
}

it('blocks the selected INT8 option before queue, network, inspection, or selection changes', async () => {
  const list = vi.fn(async () => []), scan = vi.fn(scanImageRepositories), download = vi.fn(), imported = vi.fn(), onSelection = vi.fn();
  const scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  const library = scope.run(() => useImageLibrary({
    runtimeFeatures: { ggufOriginalShapes: true, bf16WeightRetention: false },
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection,
    dependencies: { list, scan, import: imported, download },
  }))!;
  library.chooseRecipe({ recipeId: recipe.id, selections: { diffusion: 'int8-convrot' } });
  await library.downloadRecipe({ recipeId: recipe.id, selections: { diffusion: 'int8-convrot' } });
  expect(list).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(onSelection).not.toHaveBeenCalled();
  expect(library.downloadQueue.value).toEqual([]);
  expect(library.downloadState.value).toBe('idle');
  expect(library.selectedCandidateKey.value).toBe('');
  expect(library.selectedModels()).toBeUndefined();
  expect(library.recipeAvailability({ recipeId: recipe.id, selections: { diffusion: 'int8-convrot' } })).toMatchObject({ available: 0, total: 3 });
});

it.each([undefined, { ggufOriginalShapes: false, bf16WeightRetention: false }])('blocks the Q4 recipe before side effects without original-shape support (%j)', async runtimeFeatures => {
  const list = vi.fn(async () => []), scan = vi.fn(scanImageRepositories), download = vi.fn(), imported = vi.fn(), onSelection = vi.fn();
  const scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  const library = scope.run(() => useImageLibrary({
    runtimeFeatures,
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection,
    dependencies: { list, scan, import: imported, download },
  }))!;
  library.chooseRecipe({ recipeId: recipe.id, selections: { diffusion: 'q4-k-m' } });
  await library.downloadRecipe({ recipeId: recipe.id, selections: { diffusion: 'q4-k-m' } });
  expect(library.runtimeFeatures.value).toEqual({ ggufOriginalShapes: false, bf16WeightRetention: false });
  expect(list).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(onSelection).not.toHaveBeenCalled();
  expect(library.downloadQueue.value).toEqual([]);
  expect(library.downloadState.value).toBe('idle');
  expect(library.selectedCandidateKey.value).toBe('');
});

it('selects pinned BF16 H3 files while an INT8 action preserves the existing selection', async () => {
  let entries = repositories({ selections: {} });
  const download = vi.fn(), scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: { list: async () => entries, scan: scanImageRepositories, import: vi.fn(), download },
  }))!;
  await library.refresh();
  expect(library.recipeAvailability({ recipeId: recipe.id, selections: {} })).toMatchObject({ available: 3, total: 3 });
  const original = library.selectedModels();
  expect(original?.map(model => model.slot)).toEqual(['diffusion', 'vae', 'lm']);
  for (const [index, model] of original!.entries()) {
    expect(model.file).toBe(entries[index]!.files[0]!.file);
    expect(model.relativePath).toBe(recipe.files[index]!.path);
  }
  library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(library.recipeAvailability({ recipeId: recipe.id, selections: {} }).selected).toBe(true);
  library.chooseRecipe({ recipeId: recipe.id, selections: { diffusion: 'int8-convrot' } });
  await library.downloadRecipe({ recipeId: recipe.id, selections: { diffusion: 'int8-convrot' } });
  expect(library.selectedModels()).toEqual(original);
  expect(download).not.toHaveBeenCalled();
  entries = entries.map((entry, index) => index !== 1 ? entry : {
    ...entry,
    files: entry.files.map(file => ({ ...file, receipt: { ...file.receipt!, source: { ...recipe.files[1]!, kind: 'hugging-face' as const, revision: '0'.repeat(40), sha256: '0'.repeat(64) } } })),
  });
  await library.refresh();
  expect(library.recipeAvailability({ recipeId: recipe.id, selections: {} })).toMatchObject({ available: 2, total: 3 });
});

it('allows an explicit managed download of the original BF16 recipe and selects the exact files', async () => {
  const entries = repositories({ selections: {} });
  const download = vi.fn<ImageRecipeDownloader>(async () => undefined), list = vi.fn(async () => entries), scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: { list, scan: scanImageRepositories, import: vi.fn(), download },
  }))!;
  expect(download).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  await library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(download).toHaveBeenCalledOnce();
  expect(download.mock.calls[0]![0]).toMatchObject({ files: recipe.files });
  expect(library.downloadState.value).toBe('complete');
  expect(library.ready.value).toBe(true);
  expect(library.selectedModels()?.map(model => model.relativePath)).toEqual(recipe.files.map(file => file.path));
  expect(library.selectedModels()?.map(model => model.file)).toEqual(entries.map(entry => entry.files[0]!.file));
});

it.each([false, true])('keeps Q4 availability independent from runtime support and gates direct catalog actions (support=%j)', async ggufOriginalShapes => {
  const selections = { diffusion: 'q4-k-m' }, files = selectedRecipeFiles({ recipe, selections });
  const entries = repositories({ selections }), download = vi.fn<ImageRecipeDownloader>(async () => undefined), onSelection = vi.fn(), scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  const library = scope.run(() => useImageLibrary({
    runtimeFeatures: { ggufOriginalShapes, bf16WeightRetention: false },
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection,
    dependencies: { list: async () => entries, scan: scanImageRepositories, import: vi.fn(), download },
  }))!;
  await library.refresh();
  expect(library.recipeAvailability({ recipeId: recipe.id, selections })).toMatchObject({ available: 3, total: 3 });
  library.chooseMain({ candidateKey: '' });
  onSelection.mockClear();
  library.chooseRecipe({ recipeId: recipe.id, selections });
  if (ggufOriginalShapes) {
    expect(onSelection).toHaveBeenCalledOnce();
    expect(library.selectedModels()?.map(model => model.relativePath)).toEqual(files.map(file => file.path));
  } else {
    expect(onSelection).not.toHaveBeenCalled();
    expect(library.selectedModels()).toBeUndefined();
  }
  await library.downloadRecipe({ recipeId: recipe.id, selections });
  if (ggufOriginalShapes) {
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0]![0]).toMatchObject({ files });
    expect(library.downloadState.value).toBe('complete');
    expect(library.selectedModels()?.map(model => model.relativePath)).toEqual(files.map(file => file.path));
    for (const [index, model] of library.selectedModels()!.entries()) {
      expect(model.file).toBe(entries[index]!.files[0]!.file);
    }
  } else {
    expect(download).not.toHaveBeenCalled();
    expect(library.downloadState.value).toBe('idle');
    expect(library.selectedModels()).toBeUndefined();
  }
});

it('leaves a manual H3 model incomplete instead of substituting a video VAE or generic Qwen LM', async () => {
  const diffusion = repositories({ selections: {} })[0]!;
  const wrongVae = safetensorsFixture({ name: 'video-vae.safetensors', tensors: wanVaeTensors }).file;
  const wrongLm = ggufFixture({ name: 'ordinary-qwen.gguf', tensors: qwenTextTensors({ width: 5120, layers: 64 }), metadata: { 'general.architecture': 'qwen3' }, extraBytes: 0 }).file;
  const entries: LocalImageRepository[] = [diffusion, {
    repositoryKey: 'user/other-models',
    repositoryLabel: 'Other models',
    files: [{ relativePath: wrongVae.name, file: wrongVae }, { relativePath: wrongLm.name, file: wrongLm }],
  }];
  const scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: { list: async () => entries, scan: scanImageRepositories, import: vi.fn(), download: vi.fn() },
  }))!;
  await library.refresh();
  library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(library.selectedFacts.value?.family).toBe('minimax-h3-image');
  expect(library.ready.value).toBe(false);
  expect(library.selectedModels()).toBeUndefined();
  expect(library.components.value.map(component => [component.slot, component.selectedCandidateKey])).toEqual([['vae', ''], ['lm', '']]);
});

it('keeps the existing INT8 guard when all requested H3 component files are present', async () => {
  const selections = { diffusion: 'int8-convrot' };
  const entries = repositories({ selections });
  const diffusion = entries[0]!, original = diffusion.files[0]!;
  const { file, reads } = minimaxH3Int8DiffusionFixture({ name: original.relativePath });
  diffusion.files = [{ ...original, file, receipt: { ...original.receipt!, size: file.size, lastModified: file.lastModified } }];
  const download = vi.fn(), scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: { list: async () => entries, scan: scanImageRepositories, import: vi.fn(), download },
  }))!;
  await library.refresh();
  expect(library.recipeAvailability({ recipeId: recipe.id, selections })).toMatchObject({ available: 2, total: 3 });
  expect(library.ready.value).toBe(false);
  expect(library.selectedModels()).toBeUndefined();
  await library.downloadRecipe({ recipeId: recipe.id, selections });
  expect(download).not.toHaveBeenCalled();
  expect(reads.every(read => read.length < 16 * 1024 * 1024)).toBe(true);
});
