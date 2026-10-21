// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { imageModelRecipes, selectedRecipeFiles } from './model-recipes';
import { scanImageRepositories } from './logic/model-candidates';
import type { LocalImageRepository } from './logic/repository-store';
import { safetensorsFixture, sdCheckpointTensors, sdVaeTensors, fluxVaeTensors } from './test-utils/weights.test-support';

const scopes: ReturnType<typeof effectScope>[] = [];

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    scope.stop();
  }
});

const recipe = imageModelRecipes.find(recipe => recipe.id === 'sdxl-base-1.0')!;

// Synthetic headers exercise composition and original-file ownership, not real
// trained-weight compatibility or browser inference quality.
function repositories(): LocalImageRepository[] {
  return selectedRecipeFiles({ recipe, selections: {} }).map(entry => {
    const file = safetensorsFixture({ name: entry.path, tensors: entry.role === 'model' ? sdCheckpointTensors : sdVaeTensors }).file;
    return { repositoryKey: `huggingface.co/${entry.repository}/resolve/main`, repositoryLabel: entry.repository, files: [{ relativePath: entry.path, file }] };
  });
}

function harness({ initial }: { initial: LocalImageRepository[] }) {
  let entries = initial;
  const scope = effectScope();
  scopes.push(scope);
  const download = vi.fn(async (): Promise<void> => {});
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
  return {
    library,
    download,
    update({ repositories }: { repositories: LocalImageRepository[] }) {
      entries = repositories;
    },
  };
}

it('uses the checkpoint alone by default even when an external VAE is available', async () => {
  const entries = repositories();
  const h = harness({ initial: entries });
  await h.library.refresh();
  expect(h.library.ready.value).toBe(true);
  expect(h.library.components.value).toHaveLength(1);
  expect(h.library.components.value[0]).toMatchObject({ slot: 'vae', required: false, selectedCandidateKey: '' });
  expect(h.library.selectedModels()?.map(model => model.slot)).toEqual(['model']);
  expect(h.library.selectedModels()?.[0]?.file).toBe(entries[0]!.files[0]!.file);
  expect(h.library.benchmarkTargets({ selections: {} })[0]?.models?.map(model => model.slot)).toEqual(['model']);
  expect(h.library.recipeAvailability({ recipeId: recipe.id, selections: {} })).toMatchObject({ available: 2, total: 2, selected: false });
  expect(h.download).not.toHaveBeenCalled();
});

it('selects the recipe VAE explicitly and lets both main and diagnostics use the built-in VAE instead', async () => {
  const entries = repositories();
  const h = harness({ initial: entries });
  await h.library.refresh();
  h.library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.map(model => model.slot)).toEqual(['model', 'vae']);
  expect(h.library.selectedModels()?.[1]?.file).toBe(entries[1]!.files[0]!.file);
  expect(h.library.recipeAvailability({ recipeId: recipe.id, selections: {} }).selected).toBe(true);
  const mainId = h.library.selectedCandidateKey.value;
  const externalId = h.library.components.value[0]!.selectedCandidateKey;
  const diagnostics = h.library.benchmarkTargets({ selections: { [mainId]: { vae: '' } } })[0]!;
  expect(diagnostics.components[0]).toMatchObject({ selectedCandidateKey: '', required: false });
  expect(diagnostics.missing).toEqual([]);
  expect(diagnostics.models?.map(model => model.slot)).toEqual(['model']);
  expect(h.library.components.value[0]!.selectedCandidateKey).toBe(externalId);
  h.library.chooseComponent({ slot: 'vae', candidateKey: '' });
  await h.library.refresh();
  expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.map(model => model.slot)).toEqual(['model']);
  expect(h.library.recipeAvailability({ recipeId: recipe.id, selections: {} }).selected).toBe(false);
  const restored = h.library.benchmarkTargets({ selections: { [mainId]: { vae: externalId } } })[0]!;
  expect(restored.models?.map(model => model.slot)).toEqual(['model', 'vae']);
});

it('keeps an explicitly requested recipe incomplete until the external VAE arrives or the user clears it', async () => {
  const entries = repositories();
  const h = harness({ initial: entries.slice(0, 1) });
  await h.library.refresh();
  h.library.chooseRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.ready.value).toBe(false);
  expect(h.library.selectedModels()).toBeUndefined();
  expect(h.library.benchmarkTargets({ selections: {} })[0]?.missing).toEqual(['vae']);
  h.update({ repositories: entries });
  await h.library.refresh();
  expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.map(model => model.slot)).toEqual(['model', 'vae']);
  h.update({ repositories: entries.slice(0, 1) });
  await h.library.refresh();
  expect(h.library.ready.value).toBe(false);
  h.library.chooseComponent({ slot: 'vae', candidateKey: '' });
  expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.map(model => model.slot)).toEqual(['model']);
});

it('does not silently replace a missing explicit override with the checkpoint VAE', async () => {
  const entries = repositories();
  const h = harness({ initial: entries });
  await h.library.refresh();
  const externalId = h.library.components.value[0]!.choices[0]!.candidateKey;
  h.library.chooseComponent({ slot: 'vae', candidateKey: externalId });
  h.update({ repositories: entries.slice(0, 1) });
  await h.library.refresh();
  expect(h.library.ready.value).toBe(false);
  expect(h.library.components.value[0]!.selectedCandidateKey).toBe(externalId);
  expect(h.library.benchmarkTargets({ selections: {} })[0]?.missing).toEqual(['vae']);
  h.library.chooseComponent({ slot: 'vae', candidateKey: '' });
  expect(h.library.ready.value).toBe(true);
});

it('refuses a known different latent format and does not assign it to an automatic diagnostics run', async () => {
  const entries = repositories();
  const file = safetensorsFixture({ name: 'wrong.safetensors', tensors: fluxVaeTensors }).file;
  const other = { repositoryKey: 'user/wrong-vae', repositoryLabel: 'wrong-vae', files: [{ relativePath: file.name, file }] };
  const h = harness({ initial: [...entries, other] });
  await h.library.refresh();
  const wrongId = JSON.stringify([other.repositoryKey, file.name]);
  h.library.chooseComponent({ slot: 'vae', candidateKey: wrongId });
  expect(h.library.components.value[0]!.selectedCandidateKey).toBe('');
  const diagnostics = h.library.benchmarkTargets({ selections: { [h.library.selectedCandidateKey.value]: { vae: wrongId } } })[0]!;
  expect(diagnostics.models).toBeUndefined();
  expect(diagnostics.missing).toEqual(['vae']);
});

it('does not offer a second complete checkpoint as an external VAE', async () => {
  const entries = repositories();
  const file = safetensorsFixture({ name: 'other.safetensors', tensors: sdCheckpointTensors }).file;
  const other = { repositoryKey: 'user/another-checkpoint', repositoryLabel: 'another-checkpoint', files: [{ relativePath: file.name, file }] };
  const h = harness({ initial: [...entries, other] });
  await h.library.refresh();
  const otherId = JSON.stringify([other.repositoryKey, file.name]);
  h.library.chooseMain({ candidateKey: JSON.stringify([entries[0]!.repositoryKey, entries[0]!.files[0]!.relativePath]) });
  expect(h.library.components.value[0]!.choices.some(choice => choice.candidateKey === otherId)).toBe(false);
  h.library.chooseComponent({ slot: 'vae', candidateKey: otherId });
  expect(h.library.components.value[0]!.selectedCandidateKey).toBe('');
  const target = h.library.benchmarkTargets({ selections: { [h.library.selectedCandidateKey.value]: { vae: otherId } } }).find(target => target.candidateKey === h.library.selectedCandidateKey.value)!;
  expect(target.models).toBeUndefined();
  expect(target.components[0]!.choices.find(choice => choice.candidateKey === otherId)?.status).toBe('incompatible');
});

it('publishes a downloaded checkpoint recipe only after both files are inspected and selected', async () => {
  const entries = repositories();
  const h = harness({ initial: [] });
  h.download.mockImplementation(async () => h.update({ repositories: entries }));
  await h.library.downloadRecipe({ recipeId: recipe.id, selections: {} });
  expect(h.library.downloadState.value).toBe('complete');
  expect(h.library.ready.value).toBe(true);
  expect(h.library.selectedModels()?.map(model => model.slot)).toEqual(['model', 'vae']);
  expect(h.download).toHaveBeenCalledOnce();
});
