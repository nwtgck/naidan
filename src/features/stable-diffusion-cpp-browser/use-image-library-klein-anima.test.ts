// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes } from './model-recipes';
import { scanImageRepositories } from './logic/model-candidates';
import type { LocalImageRepository, listImageRepositories } from './logic/repository-store';
import { ggufFixture, safetensorsFixture, flux2KleinTensors, flux2VaeTensors, animaTensors, wanVaeTensors, qwenTextTensors } from './test-utils/weights';
import { benchmarkParameters } from './benchmark/plan';
import { parametersFixture } from './test-fixtures';
import { recommendationForSelection } from './recommendations';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

// Synthetic sparse headers exercise composition, not native model compatibility.
function repositories({ id, storageRevision }: { id: 'flux2-klein-4b' | 'anima-turbo-1.1', storageRevision: 'main' | 'pinned' }): LocalImageRepository[] {
  const recipe = imageModelRecipes.find(recipe => recipe.id === id)!;
  const klein = id === 'flux2-klein-4b';
  return recipe.files.map(entry => {
    const tensors = entry.role === 'diffusion' ? klein ? flux2KleinTensors : animaTensors
      : entry.role === 'vae' ? klein ? flux2VaeTensors : wanVaeTensors
        : qwenTextTensors({ width: klein ? 2560 : 1024, layers: klein ? 36 : 28 });
    const file = entry.path.endsWith('.safetensors') ? safetensorsFixture({ name: entry.path, tensors }).file
      : ggufFixture({ name: entry.path, tensors, metadata: entry.role === 'lm' ? { 'general.architecture': 'qwen3' } : {}, extraBytes: 0 }).file;
    // The downloader stores under main; pinned directories remain valid for
    // already-present inventory. The receipt keeps the source commit in both.
    return {
      id: `huggingface.co/${entry.repository}/resolve/${storageRevision === 'main' ? 'main' : entry.revision}`,
      name: entry.repository,
      files: [{
        path: entry.path,
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

it.each(['flux2-klein-4b', 'anima-turbo-1.1'] as const)('keeps original %s files and explicit companions in main and diagnostics', async id => {
  const entries = repositories({ id, storageRevision: 'pinned' });
  const scope = effectScope(); scopes.push(scope);
  const download = vi.fn();
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: {
      list: async () => entries,
      scan: scanImageRepositories,
      import: vi.fn(),
      download,
    },
  }))!;
  await library.refresh(); library.chooseRecipe({ recipeId: id, selections: {} });
  expect(library.ready.value).toBe(true);
  expect(library.selectedFacts.value?.family).toBe(id === 'anima-turbo-1.1' ? 'anima' : id);
  expect(library.recipeAvailability({ recipeId: id, selections: {} })).toMatchObject({ available: 3, total: 3, selected: true });
  expect(library.selectedModels()?.map(model => model.slot)).toEqual(['diffusion', 'vae', 'lm']);
  for (const [index, model] of library.selectedModels()!.entries()) {
    expect(model.file).toBe(entries[index]!.files[0]!.file);
    expect(model.path).toBe(entries[index]!.files[0]!.path);
  }
  const target = library.benchmarkTargets({ selections: {} })[0]!;
  expect(target.missing).toEqual([]);
  expect(target.models).toEqual(library.selectedModels());
  expect(recommendationForSelection({ model: target.facts })?.id).toBe(id);
  const common = { ...parametersFixture(), width: 256, height: 256, steps: 7 };
  const effective = benchmarkParameters({ common, target, strategy: 'model-defaults', overrides: {} });
  expect(effective.preset).toBe(id);
  expect(effective.parameters).toMatchObject({ width: 256, height: 256, steps: 7, guidance: 1, sampler: 'euler' });
  expect(download).not.toHaveBeenCalled();
});

it.each(['flux2-klein-4b', 'anima-turbo-1.1'] as const)('keeps %s unavailable until every requested companion has been downloaded and inspected', async id => {
  const entries = repositories({ id, storageRevision: 'main' }); let available = entries.slice(0, 1);
  const scope = effectScope(); scopes.push(scope);
  const download = vi.fn(async () => {
    available = entries;
  });
  const list = vi.fn<typeof listImageRepositories>(async ({ repositoryIds }) => repositoryIds ? available.filter(entry => repositoryIds.includes(entry.id)) : available);
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: {
      list,
      scan: scanImageRepositories,
      import: vi.fn(),
      download,
    },
  }))!;
  await library.refresh(); library.chooseRecipe({ recipeId: id, selections: {} });
  expect(library.ready.value).toBe(false);
  expect(library.selectedModels()).toBeUndefined();
  expect(library.benchmarkTargets({ selections: {} })[0]?.missing).toEqual(['vae', 'lm']);
  await library.downloadRecipe({ recipeId: id, selections: {} });
  expect(download).toHaveBeenCalledOnce();
  expect(download).toHaveBeenCalledWith(expect.objectContaining({ files: imageModelRecipes.find(recipe => recipe.id === id)!.files }));
  expect(list).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryIds: [...new Set(entries.map(entry => entry.id))] }));
  expect(library.downloadState.value).toBe('complete');
  expect(library.ready.value).toBe(true);
  expect(library.selectedModels()?.map(model => model.slot)).toEqual(['diffusion', 'vae', 'lm']);
});

it('rejects cross-family companion overrides in main and diagnostics', async () => {
  const entries = [...repositories({ id: 'flux2-klein-4b', storageRevision: 'pinned' }), ...repositories({ id: 'anima-turbo-1.1', storageRevision: 'pinned' })];
  const scope = effectScope(); scopes.push(scope);
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection() {},
    dependencies: {
      list: async () => entries,
      scan: scanImageRepositories,
      import: vi.fn(),
      download: vi.fn(),
    },
  }))!;
  await library.refresh(); library.chooseRecipe({ recipeId: 'flux2-klein-4b', selections: {} });
  const original = library.selectedModels();
  const wrongVae = JSON.stringify([entries[4]!.id, entries[4]!.files[0]!.path]);
  library.chooseComponent({ slot: 'vae', id: wrongVae });
  expect(library.selectedModels()).toEqual(original);
  const targets = library.benchmarkTargets({ selections: { [library.main.value]: { vae: wrongVae } } });
  expect(targets.find(target => target.id === library.main.value)).toMatchObject({ models: undefined, missing: ['vae'] });
  expect(targets.find(target => target.facts.family === 'anima')?.missing).toEqual([]);
});
