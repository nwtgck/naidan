import { downloadImageRecipe, type CatalogDownloadProgress } from './logic/catalog-download';
import { imageModelRecipes, selectedRecipeFiles, type ImageRecipeFile, type ImageRecipeSelection } from './model-recipes';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { listImageRepositories, importImageRepository } from './logic/repository-store';
import { scanImageRepositories, componentRequirements, componentMatch, defaultCompanion, type ModelInventory, type ModelCandidate } from './logic/model-candidates';
import { imageDirectoryFromFiles, imageDirectoriesFromDrop } from './logic/repository-input';
import type { ModelSlot, Request } from './types';
import type { ImageLibraryView, ImageModelChoice } from './library-view';

type Dependencies = { list: typeof listImageRepositories, scan: typeof scanImageRepositories, import: typeof importImageRepository, download: typeof downloadImageRecipe };
const defaultDependencies: Dependencies = { list: listImageRepositories, scan: scanImageRepositories, import: importImageRepository, download: downloadImageRecipe };

function primarySlot({ family }: { family: ModelCandidate['family'] }): ModelSlot | undefined {
  switch (family) {
  case 'sd-checkpoint': return 'model';
  case 'z-image': case 'qwen-image-2.1': case 'flux1': return 'diffusion';
  case 'unknown': return undefined;
  default: { const exhaustive: never = family; throw new Error(String(exhaustive)); }
  }
}
function automaticOrigin({ origin }: { origin: 'automatic' | 'manual' | 'files' }): boolean {
  switch (origin) {
  case 'automatic': return true;
  case 'manual': case 'files': return false;
  default: { const exhaustive: never = origin; throw new Error(String(exhaustive)); }
  }
}

function downloadCompleted({ state }: { state: ImageLibraryView['downloadState']['value'] }): boolean {
  switch (state) {
  case 'complete': return true;
  case 'idle': case 'downloading': case 'cancelled': case 'failed': return false;
  default: { const exhaustive: never = state; throw new Error(String(exhaustive)); }
  }
}

/** Application-owned local inventory and composition. File metadata is advisory:
 * a structural match is not a claim of identical training weights or quality. */
export function useImageLibrary({ blocked, onSelection, dependencies }: {
  blocked: () => boolean,
  onSelection: ({ family, turbo }: { family: ModelCandidate['family'], turbo: boolean }) => void,
  dependencies: Dependencies | undefined,
}): ImageLibraryView {
  const deps = dependencies ?? defaultDependencies;
  const inventory = shallowRef<ModelInventory>({ candidates: [], issues: [] });
  const main = ref('');
  const showAll = ref(false);
  const selections = shallowRef<Partial<Record<ModelSlot, string>>>({});
  const overrides = new Set<ModelSlot>();
  const scanState = ref<'idle' | 'scanning'>('idle');
  const importProgress = shallowRef<{ completed: number, total: number }>();
  const failure = ref('');
  const activeImport = shallowRef<AbortController>();
  const activeDownload = shallowRef<AbortController>();
  const downloadProgress = shallowRef<CatalogDownloadProgress>();
  const downloadState = ref<'idle' | 'downloading' | 'complete' | 'cancelled' | 'failed'>('idle');
  const downloadRecipeId = ref('');
  let recipeIntent: { family: 'z-image' | 'qwen-image-2.1', files: ImageRecipeFile[] } | undefined;
  const downloading = computed(() => activeDownload.value !== undefined);
  let activeScan: AbortController | undefined;
  let origin: 'automatic' | 'manual' | 'files' = 'automatic';
  let disposed = false;
  const importing = computed(() => activeImport.value !== undefined);
  const selected = computed(() => inventory.value.candidates.find(item => item.id === main.value));
  const requirements = computed(() => componentRequirements({ family: selected.value?.family ?? 'unknown' }));
  function describe({ candidate, status }: { candidate: ModelCandidate, status: ImageModelChoice['status'] }): ImageModelChoice {
    return {
      id: candidate.id, label: candidate.path.split('/').at(-1) ?? candidate.path,
      detail: `${candidate.repositoryId}/${candidate.path} · ${candidate.format} · ${(candidate.size / 1024 ** 3).toFixed(2)} GiB`,
      evidence: candidate.evidence, status: candidate.issue ? 'incompatible' : status, issue: candidate.issue,
    };
  }
  const models = computed(() => inventory.value.candidates.filter(candidate => {
    if (candidate.id === main.value || showAll.value) return true;
    return candidate.family !== 'unknown' && candidate.roles.some(role => role === 'model' || role === 'diffusion');
  }).map(candidate => describe({ candidate, status: primarySlot({ family: candidate.family }) !== undefined ? 'matching' : candidate.roles.length ? 'incompatible' : 'unverified' })));
  const components = computed(() => requirements.value.map(requirement => ({
    slot: requirement.slot, selected: selections.value[requirement.slot] ?? '', required: true,
    choices: inventory.value.candidates.filter(candidate => candidate.id !== main.value).map(candidate => describe({ candidate, status: componentMatch({ candidate, requirement }) }))
      .filter(choice => showAll.value || choice.status === 'matching' || choice.id === selections.value[requirement.slot])
      .sort((a, b) => Number(b.status === 'matching') - Number(a.status === 'matching') || a.detail.localeCompare(b.detail)),
  })));
  const issues = computed(() => inventory.value.issues.map(issue => `${issue.repositoryId}/${issue.path}: ${issue.message}`));
  const ready = computed(() => {
    if (!selected.value || selected.value.issue || importing.value || downloading.value || origin === 'files') return false;
    // Unknown model families remain inspectable in Advanced. Their execution is
    // deliberate via the manual component controls, not a guessed checkpoint.
    if (primarySlot({ family: selected.value.family }) === undefined) return false;
    return requirements.value.every(requirement => {
      const candidate = inventory.value.candidates.find(item => item.id === selections.value[requirement.slot]);
      return candidate !== undefined && componentMatch({ candidate, requirement }) !== 'incompatible';
    });
  });
  function resolve(): void {
    if (!selected.value) {
      selections.value = {}; return;
    }
    const next = { ...selections.value };
    for (const requirement of requirements.value) {
      const previous = inventory.value.candidates.find(item => item.id === next[requirement.slot]);
      if (overrides.has(requirement.slot)) {
        if (!previous) next[requirement.slot] = '';
        continue;
      }
      if (!recipeIntent && previous && componentMatch({ candidate: previous, requirement }) === 'matching') continue;
      const requested = recipeIntent?.files.find(file => file.role === requirement.slot);
      next[requirement.slot] = requested ? findRecipeFile({ file: requested, match: ({ candidate }) => componentMatch({ candidate, requirement }) === 'matching' })?.id ?? ''
        : defaultCompanion({ main: selected.value, candidates: inventory.value.candidates, requirement }) ?? '';
    }
    selections.value = next;
  }
  function chooseMain({ id }: { id: string }): void {
    if (blocked() || importing.value || downloading.value || disposed) return;
    const candidate = inventory.value.candidates.find(item => item.id === id);
    if (id && !candidate || candidate?.issue || candidate && candidate.family === 'unknown' && candidate.roles.length) return;
    recipeIntent = undefined;
    if (id === main.value) return;
    main.value = id; origin = 'manual'; overrides.clear(); selections.value = {}; resolve();
    if (candidate) onSelection({ family: candidate.family, turbo: candidate.turboHint });
  }
  function chooseComponent({ slot, id }: { slot: ModelSlot, id: string }): void {
    if (blocked() || importing.value || downloading.value || disposed) return;
    const requirement = requirements.value.find(item => item.slot === slot);
    const candidate = inventory.value.candidates.find(item => item.id === id);
    if (!requirement || candidate && componentMatch({ candidate, requirement }) === 'incompatible' || id && !candidate) return;
    overrides.add(slot); selections.value = { ...selections.value, [slot]: id };
  }
  function findRecipeFile({ file, match }: { file: ImageRecipeFile, match: ({ candidate }: { candidate: ModelCandidate }) => boolean }): ModelCandidate | undefined {
    const target = `huggingface.co/${file.repository}/resolve/main`;
    const matches = inventory.value.candidates.filter(candidate => !candidate.issue && candidate.path === file.path && match({ candidate }));
    matches.sort((a, b) => Number(b.repositoryId === target) - Number(a.repositoryId === target) || a.id.localeCompare(b.id));
    return matches[0];
  }
  function resolveRecipe(): void {
    if (!recipeIntent) return;
    const file = recipeIntent.files.find(file => file.role === 'diffusion');
    const candidate = file && findRecipeFile({ file, match: ({ candidate: item }) => item.family === recipeIntent?.family });
    if (candidate && candidate.id !== main.value) {
      main.value = candidate.id; onSelection({ family: candidate.family, turbo: candidate.turboHint });
    }
  }
  function chooseRecipe({ recipeId, selections: requested }: { recipeId: string, selections: ImageRecipeSelection }): void {
    if (blocked() || importing.value || downloading.value || disposed) return;
    const recipe = imageModelRecipes.find(recipe => recipe.id === recipeId); if (!recipe) return;
    const files = selectedRecipeFiles({ recipe, selections: requested });
    switch (recipe.id) {
    case 'z-image-turbo': recipeIntent = { family: 'z-image', files }; break;
    case 'qwen-image-2.1': recipeIntent = { family: 'qwen-image-2.1', files }; break;
    default: { const exhaustive: never = recipe.id; throw new Error(String(exhaustive)); }
    }
    origin = 'manual'; main.value = ''; selections.value = {}; overrides.clear();
    resolveRecipe(); resolve();
  }
  async function downloadRecipe({ recipeId, selections: requested }: { recipeId: string, selections: ImageRecipeSelection }): Promise<void> {
    if (blocked() || importing.value || downloading.value || disposed) return;
    const recipe = imageModelRecipes.find(recipe => recipe.id === recipeId); if (!recipe) return;
    const choices = { ...requested }; const files = selectedRecipeFiles({ recipe, selections: choices });
    const controller = new AbortController(); activeDownload.value = controller;
    activeScan?.abort(); failure.value = ''; downloadState.value = 'downloading'; downloadRecipeId.value = recipeId;
    downloadProgress.value = undefined;
    try {
      await deps.download({ files, signal: controller.signal, onProgress: ({ progress }) => {
        if (!disposed && !controller.signal.aborted) downloadProgress.value = progress;
      } });
      controller.signal.throwIfAborted(); downloadState.value = 'complete';
    } catch (error) {
      if (!disposed) {
        downloadState.value = controller.signal.aborted ? 'cancelled' : 'failed';
        if (!controller.signal.aborted) failure.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (activeDownload.value === controller) activeDownload.value = undefined;
      if (!disposed) {
        const problem = failure.value;
        if (downloadCompleted({ state: downloadState.value })) chooseRecipe({ recipeId, selections: choices });
        await refresh();
        if (problem) failure.value = [problem, failure.value].filter(Boolean).join('\n');
      }
    }
  }
  function cancelDownload(): void {
    activeDownload.value?.abort();
  }
  async function refresh(): Promise<void> {
    if (disposed || importing.value || downloading.value || blocked()) return;
    activeScan?.abort(); const scan = new AbortController(); activeScan = scan;
    scanState.value = 'scanning'; failure.value = '';
    try {
      const repositories = await deps.list({ signal: scan.signal });
      const next = await deps.scan({ repositories, signal: scan.signal });
      if (disposed || blocked() || scan.signal.aborted || activeScan !== scan) return;
      inventory.value = next;
      if (!next.candidates.some(candidate => candidate.id === main.value)) {
        main.value = ''; selections.value = {}; overrides.clear();
        if (automaticOrigin({ origin })) {
          const candidates = next.candidates.filter(candidate => candidate.family !== 'unknown' && !candidate.issue);
          candidates.sort((a, b) => a.size - b.size || a.id.localeCompare(b.id));
          const first = candidates[0];
          if (first) {
            main.value = first.id; onSelection({ family: first.family, turbo: first.turboHint });
          }
        }
      }
      resolveRecipe(); resolve();
    } catch (error) {
      if (!disposed && !scan.signal.aborted) failure.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (activeScan === scan) {
        activeScan = undefined; scanState.value = 'idle';
      }
    }
  }
  async function importInputs({ collect }: { collect: ({ signal }: { signal: AbortSignal }) => Promise<Parameters<typeof importImageRepository>[0]['input'][]> }): Promise<void> {
    if (blocked() || importing.value || downloading.value || disposed) return;
    const controller = new AbortController(); activeImport.value = controller;
    activeScan?.abort(); failure.value = ''; importProgress.value = { completed: 0, total: 0 };
    let changed = false;
    try {
      // collect is invoked during drop dispatch, before awaiting entry traversal.
      const directories = await collect({ signal: controller.signal }); controller.signal.throwIfAborted();
      for (const input of directories) {
        controller.signal.throwIfAborted();
        await deps.import({ input, signal: controller.signal, onProgress: ({ progress }) => {
          if (!disposed) importProgress.value = progress;
        } });
        changed = true;
      }
    } catch (error) {
      if (!disposed && !controller.signal.aborted) failure.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (activeImport.value === controller) {
        activeImport.value = undefined; importProgress.value = undefined;
      }
      if (!disposed && changed) {
        // A later folder can fail after an earlier import committed. Refresh the
        // successful files without hiding the error (refresh clears failure).
        const importFailure = failure.value;
        await refresh();
        if (!disposed && importFailure) failure.value = [importFailure, failure.value].filter(Boolean).join('\n');
      }
    }
  }
  async function importDirectory({ event }: { event: Event }): Promise<void> {
    const input = event.target; if (!(input instanceof HTMLInputElement)) return;
    const files = Array.from(input.files ?? []); input.value = ''; if (!files.length) return;
    await importInputs({ collect: async () => [imageDirectoryFromFiles({ files })] });
  }
  async function dropDirectory({ event }: { event: DragEvent }): Promise<void> {
    const transfer = event.dataTransfer; if (!transfer) return;
    await importInputs({ collect: ({ signal }) => imageDirectoriesFromDrop({ transfer, signal }) });
  }
  function selectedModels(): Request['models'] | undefined {
    if (!ready.value || !selected.value) return undefined;
    const slot = primarySlot({ family: selected.value.family });
    if (!slot) return undefined;
    const selectionsToUse = [{ slot, candidate: selected.value }, ...requirements.value.map(({ slot }) => ({ slot, candidate: inventory.value.candidates.find(item => item.id === selections.value[slot])! }))];
    return selectionsToUse.map(({ slot, candidate }) => {
      const file = candidate.files.find(entry => entry.path === candidate.path);
      if (!file) throw new Error('Selected model file disappeared from the inventory');
      return { slot, file: file.file, path: candidate.path, companions: candidate.files.filter(entry => entry.path !== candidate.path) };
    });
  }
  function cancelImport(): void {
    activeImport.value?.abort();
  }
  function useManualFiles(): void {
    recipeIntent = undefined; origin = 'files'; main.value = ''; selections.value = {}; overrides.clear();
  }
  onScopeDispose(() => {
    disposed = true; activeScan?.abort(); activeImport.value?.abort(); activeDownload.value?.abort();
  });
  return { models, main, components, scanState, showAll, importProgress, importing, failure, issues, ready, refresh, downloading, downloadProgress, downloadState, downloadRecipeId, downloadRecipe, chooseRecipe, cancelDownload,
    chooseMain, chooseComponent, importDirectory, dropDirectory, cancelImport, useManualFiles, selectedModels,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}
export const TEST_ONLY = {
};
