import { validateLinkedModelRoot } from '@/logic/model-directory-input';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { temporaryImageRepositories, restoreTemporaryImageFiles } from './logic/temporary-repositories';
import { imageModelLocation, sameImageModelLocation } from './logic/model-location';
import { createDownloadManager, getDownloadManager, type DownloadExecution, type DownloadManager } from '@/logic/download-manager';
import { downloadFilesForDisplay } from '@/logic/hugging-face-download/presentation';
import { hostModelHandles } from '@/00-storage/service/host-model-handles';
import { awaitInspection } from './logic/inspection-abort';
import { inspectImageInventory } from './inventory-worker/client';
import type { InspectionProgress } from './inventory-worker/types';
import type { ImageRecipeDownloader, ImageDownloadDestination, CatalogDownloadProgress } from './logic/catalog-download';
import { downloadImageRecipeInWorker } from './download-worker/client';
import { imageModelRecipes, selectedRecipeFiles, type ImageRecipeFile, type ImageRecipeSelection } from './model-recipes';
import { imageCatalogLoras } from './lora-catalog';
import type { ImageDownloadSource } from './logic/catalog-source';
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { type listImageRepositories, importImageRepository } from './logic/repository-store';
import { type scanImageRepositories, componentRequirements, componentMatch, defaultCompanion, imageSelectionCandidates, type ModelInventory, type ModelCandidate } from './logic/model-candidates';
import { imageDirectoryFromFiles, imageDirectoriesFromDrop, imageDirectoryForFile } from './logic/repository-input';
import type { ModelSlot, Request } from './types';
import type { ImageBenchmarkTarget, ImageComponentChoice, ImageLibraryView, ImageModelChoice, ImageRecipeAvailability, SavedImageLoraChoice } from './library-view';
import { useHostModelDirectories } from './composables/use-host-model-directories';
import { createDisabledImageLibrary } from './library-standalone';
import { OPFS_MODELS_DIR } from '@/constants';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import type { ImageGenerationModelFile } from '@/01-models/image-generation-history';
import type { BrowserImageModelLocation, BrowserImageModelSelection } from '@/01-models/types';
import type { ImageLoraSelection } from './lora-form';
import { imagePrimarySlot as primarySlot, chooseInitialImagePrimary, reconcileImageComponents, type ImageComponentSlot, type ImageSlotIntent } from '@/features/image-generation/model-selection';

type Dependencies = { list: typeof listImageRepositories, scan: typeof scanImageRepositories, import: typeof importImageRepository, download: ImageRecipeDownloader, manager?: DownloadManager };
type InventoryRefreshResult = 'scanned' | 'blocked' | 'failed';
const defaultDependencies: Pick<Dependencies, 'import' | 'download'> = { import: importImageRepository, download: downloadImageRecipeInWorker };

function automaticOrigin({ origin }: { origin: 'automatic' | 'manual' | 'files' }): boolean {
  switch (origin) {
  case 'automatic': return true;
  case 'manual': case 'files': return false;
  default: {
    const exhaustive: never = origin;
    throw new Error(String(exhaustive));
  }
  }
}

/** Application-owned local inventory and composition. File metadata is advisory:
 * a structural match is not a claim of identical training weights or quality. */
export function useImageLibrary({ blocked, downloadsBlocked, onSelection, dependencies }: {
  blocked: () => boolean,
  downloadsBlocked: () => boolean,
  onSelection: ({ family, turbo }: { family: ModelCandidate['family'], turbo: boolean }) => void,
  dependencies: Dependencies | undefined,
}): ImageLibraryView {
  const deps = dependencies ?? defaultDependencies;
  const manager = dependencies?.manager ?? (dependencies ? createDownloadManager() : getDownloadManager());
  const inventory = shallowRef<ModelInventory>({ candidates: [], issues: [] });
  let inventoryReady = false;
  const inspectedMissingFiles = new Set<string>();
  const selectedCandidateKey = ref('');
  // Track only Files issued by the inspected local inventory. A later scan
  // creates fresh File objects without changing a selected adapter's origin.
  const knownLocations = new WeakMap<File, BrowserImageModelLocation>();
  const showAll = ref(false);
  const componentCandidateKeys = shallowRef<Partial<Record<ModelSlot, string>>>({});
  const overrides = new Set<ModelSlot>();
  const scanState = ref<'idle' | 'scanning'>('idle');
  const scanProgress = shallowRef<InspectionProgress>();
  const importProgress = shallowRef<{ completed: number, total: number }>();
  const failure = ref('');
  const activeImport = shallowRef<AbortController>();
  const activeDownload = shallowRef<AbortController>();
  let downloadCompletion: { directoryId: string | undefined, promise: Promise<void> } | undefined;
  const downloadProgress = shallowRef<CatalogDownloadProgress>();
  const downloadState = ref<'idle' | 'downloading' | 'complete' | 'paused' | 'failed' | 'incomplete'>('idle');
  type DownloadTarget = { kind: 'recipe', id: string, selections: ImageRecipeSelection } | { kind: 'lora', id: string };
  const downloadTarget = shallowRef<DownloadTarget>();
  type DownloadJob = {
    id: string, key: string, target: DownloadTarget, files: readonly ImageDownloadSource[],
    destinationId: string, destinationName: string, label: string,
    authorization: Promise<{ destination: ImageDownloadDestination | undefined, error: unknown, root: FileSystemDirectoryHandle | undefined }>,
    managedId: number | undefined, boundRoot: FileSystemDirectoryHandle | undefined,
    state: 'queued' | 'downloading' | 'paused' | 'failed' | 'incomplete' | 'complete', error: string,
    completion: ReturnType<typeof Promise.withResolvers<void>>, selectionVersion: number, selectWhenComplete: boolean,
  };
  const jobs = shallowRef<DownloadJob[]>([]);
  const downloadQueue = computed(() => jobs.value.flatMap(job => {
    switch (job.state) {
    case 'complete': return [];
    case 'queued': case 'downloading': case 'paused': case 'failed': case 'incomplete':
      return [{ id: job.id, label: job.label, destination: job.destinationName, state: job.state, error: job.error }];
    default: {
      const exhaustive: never = job.state;
      throw new Error(String(exhaustive));
    }
    }
  }));
  let currentJob: DownloadJob | undefined, jobSequence = 0, selectionVersion = 0;
  function publishJobs(): void {
    jobs.value = [...jobs.value];
  }
  // An independent editor operation must not have its settings replaced when
  // a previously requested download finishes later.
  watch(blocked, value => {
    if (value) {
      selectionVersion++;
    }
  }, { flush: 'sync' });
  const downloadPresentation = computed(() => {
    const target = downloadTarget.value;
    switch (target?.kind) {
    case 'recipe': return { recipeId: target.id, loraId: '', selections: target.selections };
    case 'lora': return { recipeId: '', loraId: target.id, selections: {} };
    case undefined: return { recipeId: '', loraId: '', selections: {} };
    default: {
      const exhaustive: never = target;
      throw new Error(String(exhaustive));
    }
    }
  });
  const downloadRecipeId = computed(() => downloadPresentation.value.recipeId);
  const downloadLoraId = computed(() => downloadPresentation.value.loraId);
  const downloadSelections = computed<ImageRecipeSelection>(() => downloadPresentation.value.selections);
  let recipeIntent: { family: 'z-image' | 'qwen-image-2.1' | 'sd-checkpoint' | 'flux2-klein-4b' | 'anima' | 'krea2' | 'ernie-image', files: ImageRecipeFile[], destinationId: string } | undefined;
  const downloading = computed(() => activeDownload.value !== undefined || jobs.value.some(job => job.state === 'queued' || job.state === 'downloading'));
  let hostPublication: AbortController | undefined;
  const host = dependencies ? undefined : useHostModelDirectories({
    blocked: () => blocked() || importing.value,
    added: undefined,
    validateDirectory: validateLinkedModelRoot,
    async stopDownload({ id }) {
      await manager.stopDirectory({ directoryId: id });
    },
    async changed() {
      hostPublication?.abort();
      cancelScan();
      const controller = new AbortController();
      hostPublication = controller;
      try {
        await refreshAfterMutation({ signal: controller.signal, completingImport: undefined, repositoryKeys: undefined });
      } finally {
        if (hostPublication === controller) {
          hostPublication = undefined;
        }
      }
    },
    failed({ error }) {
      failure.value = error instanceof Error ? error.message : String(error);
    },
  });
  const hostView = host?.view ?? createDisabledImageLibrary().hostDirectories;
  const hostDirectories: ImageLibraryView['hostDirectories'] = {
    ...hostView,
    async add() {
      if (!downloading.value) {
        await hostView.add();
      }
    },
    async reconnect({ id }) {
      if (!downloading.value) {
        await hostView.reconnect({ id });
      }
    },
    selectDestination({ id }) {
      if (importing.value || downloadsBlocked()) {
        return;
      }
      hostView.selectDestination({ id });
    },
  };
  let activeScan: { controller: AbortController, promise: Promise<InventoryRefreshResult> } | undefined;
  let preparingHistoryFiles = false;
  let origin: 'automatic' | 'manual' | 'files' = 'automatic';
  let disposed = false;
  const importing = computed(() => activeImport.value !== undefined);
  const downloadsDisabled = computed(() => downloadsBlocked());
  if (host) {
    watch(() => hostDirectories.entries.value.map(entry => entry.id), (ids, previousIds) => {
      if (hostView.destination.value !== 'opfs' && previousIds.includes(hostView.destination.value) && !ids.includes(hostView.destination.value)) {
        hostView.destination.value = 'opfs';
      }
      // Only a committed unlink removes queued work. Failed settings writes keep
      // the original root and its paused/retryable transfer intact.
      for (const job of [...jobs.value]) {
        if (job.destinationId !== 'opfs' && previousIds.includes(job.destinationId) && !ids.includes(job.destinationId)) {
          removeQueuedDownload({ id: job.id });
        }
      }
    }, { flush: 'sync' });
  }
  watch([hostDirectories.busy, downloadsDisabled, importing], () => {
    void processDownloads();
  });
  const selected = computed(() => inventory.value.candidates.find(item => item.candidateKey === selectedCandidateKey.value));
  const selectedFacts = computed(() => selected.value && !selected.value.issue ? { family: selected.value.family, variant: selected.value.variant, evidence: selected.value.evidence } : undefined);
  const requirements = computed(() => componentRequirements({ family: selected.value?.family ?? 'unknown' }));
  function describe({ candidate, status }: { candidate: ModelCandidate, status: ImageModelChoice['status'] }): ImageModelChoice {
    return {
      candidateKey: candidate.candidateKey,
      label: candidate.primaryRelativePath.split('/').at(-1) ?? candidate.primaryRelativePath,
      detail: `${candidate.hostSource ? `${candidate.hostSource.directoryName}/${candidate.hostSource.repository}` : candidate.repositoryKey}/${candidate.primaryRelativePath} · ${candidate.format} · ${(candidate.size / 1024 ** 3).toFixed(2)} GiB`,
      evidence: candidate.evidence,
      status: candidate.issue ? 'incompatible' : status,
      issue: candidate.issue,
    };
  }
  const models = computed(() => inventory.value.candidates.filter(candidate => {
    if (candidate.classes.includes('lora')) {
      return false;
    }
    if (candidate.candidateKey === selectedCandidateKey.value || showAll.value) {
      return true;
    }
    return candidate.family !== 'unknown' && candidate.roles.some(role => role === 'model' || role === 'diffusion');
  }).map(candidate => describe({ candidate, status: primarySlot({ family: candidate.family }) !== undefined ? 'matching' : candidate.roles.length ? 'incompatible' : 'unverified' })));
  const savedLoras = computed<SavedImageLoraChoice[]>(() => inventory.value.candidates.flatMap(candidate => {
    const entry = candidate.files[0];
    // Native LoRA requests mount one original file, not a shard/index bundle.
    if (candidate.issue || !candidate.classes.includes('lora') || candidate.files.length !== 1 || !entry || !/\.(gguf|safetensors)$/i.test(entry.relativePath)) {
      return [];
    }
    const source = candidate.hostSource;
    const location = modelLocation({ candidate });
    const detail = (() => {
      switch (location.kind) {
      case 'temp': return `Temporary: ${location.path}`;
      case 'opfs': return `OPFS: ${candidate.repositoryKey}/${entry.relativePath}`;
      case 'host': return `Host: ${source!.directoryName}/${source!.repository}/${entry.relativePath}`;
      default: {
        const exhaustive: never = location;
        throw new Error(String(exhaustive));
      }
      }
    })();
    return [{
      candidateKey: candidate.candidateKey,
      label: entry.file.name,
      relativePath: entry.relativePath,
      file: entry.file,
      detail,
    }];
  }).sort((a, b) => a.detail.localeCompare(b.detail) || a.candidateKey.localeCompare(b.candidateKey)));
  const components = computed(() => requirements.value.map(requirement => ({
    slot: requirement.slot,
    selectedCandidateKey: componentCandidateKeys.value[requirement.slot] ?? '',
    required: requirement.required,
    choices: inventory.value.candidates.filter(candidate => candidate.candidateKey !== selectedCandidateKey.value && !candidate.classes.includes('lora')).map(candidate => describe({ candidate, status: componentMatch({ candidate, requirement }) }))
      .filter(choice => showAll.value || choice.status === 'matching' || choice.candidateKey === componentCandidateKeys.value[requirement.slot])
      .sort((a, b) => Number(b.status === 'matching') - Number(a.status === 'matching') || a.detail.localeCompare(b.detail)),
  })));
  const issues = computed(() => inventory.value.issues.map(issue => `${issue.repositoryKey}/${issue.relativePath}: ${issue.message}`));
  const ready = computed(() => {
    if (!selected.value || selected.value.issue || scanState.value === 'scanning' || importing.value || origin === 'files') {
      return false;
    }
    // Unknown model families remain inspectable in Advanced. Their execution is
    // deliberate via the manual component controls, not a guessed checkpoint.
    if (primarySlot({ family: selected.value.family }) === undefined) {
      return false;
    }
    return requirements.value.every(requirement => {
      const id = componentCandidateKeys.value[requirement.slot];
      if (!requirement.required && !id) {
        return overrides.has(requirement.slot) || !recipeIntent?.files.some(file => file.role === requirement.slot);
      }
      const candidate = inventory.value.candidates.find(item => item.candidateKey === id);
      return candidate !== undefined && componentMatch({ candidate, requirement }) !== 'incompatible';
    });
  });
  function resolve(): void {
    if (!selected.value) {
      componentCandidateKeys.value = {};
      return;
    }
    const choices: Partial<Record<ImageComponentSlot, ImageSlotIntent>> = {};
    const recipe: Partial<Record<ImageComponentSlot, string>> | undefined = recipeIntent ? {} : undefined;
    for (const requirement of requirements.value) {
      if (overrides.has(requirement.slot)) {
        const id = componentCandidateKeys.value[requirement.slot];
        const exists = inventory.value.candidates.some(candidate => candidate.candidateKey === id);
        // Preserve the existing local behavior for unavailable required files;
        // optional overrides retain their key rather than using an embedded VAE.
        choices[requirement.slot] = id && (!requirement.required || exists) ? { kind: 'file', key: id } : { kind: 'none' };
      }
      const requested = recipeIntent?.files.find(file => file.role === requirement.slot);
      if (recipe && requested) {
        recipe[requirement.slot] = findRecipeFile({ file: requested, destinationId: recipeIntent!.destinationId, match: ({ candidate }) => componentMatch({ candidate, requirement }) === 'matching' })?.candidateKey ?? '';
      }
    }
    const resolved = reconcileImageComponents({
      primaryKey: selected.value.candidateKey,
      candidates: imageSelectionCandidates({ candidates: inventory.value.candidates }),
      choices,
      previous: componentCandidateKeys.value,
      recipe,
    });
    componentCandidateKeys.value = { ...componentCandidateKeys.value, ...Object.fromEntries(resolved.components.map(component => [component.slot, component.key ?? ''])) };
  }

  function chooseMain({ candidateKey }: { candidateKey: string }): void {
    if (blocked() || importing.value || scanState.value === 'scanning' || disposed) {
      return;
    }
    const candidate = inventory.value.candidates.find(item => item.candidateKey === candidateKey);
    if (candidateKey && !candidate || candidate?.issue || candidate && candidate.family === 'unknown' && candidate.roles.length) {
      return;
    }
    selectionVersion++;
    unavailableLoras = [];
    recipeIntent = undefined;
    if (candidateKey === selectedCandidateKey.value) {
      return;
    }
    selectedCandidateKey.value = candidateKey;
    origin = 'manual';
    overrides.clear();
    componentCandidateKeys.value = {};
    resolve();
    if (candidate) {
      onSelection({ family: candidate.family, turbo: candidate.turboHint });
    }
  }
  function chooseComponent({ slot, candidateKey }: { slot: ModelSlot, candidateKey: string }): void {
    if (blocked() || importing.value || scanState.value === 'scanning' || disposed) {
      return;
    }
    const requirement = requirements.value.find(item => item.slot === slot);
    const candidate = inventory.value.candidates.find(item => item.candidateKey === candidateKey);
    if (!requirement || candidate && componentMatch({ candidate, requirement }) === 'incompatible' || candidateKey && !candidate) {
      return;
    }
    selectionVersion++;
    overrides.add(slot);
    componentCandidateKeys.value = { ...componentCandidateKeys.value, [slot]: candidateKey };
  }
  function findRecipeFile({ file, match, destinationId }: { file: ImageRecipeFile, destinationId: string, match: ({ candidate }: { candidate: ModelCandidate }) => boolean }): ModelCandidate | undefined {
    const target = `huggingface.co/${file.repository}/resolve/main`;
    const matches = inventory.value.candidates.filter(candidate => {
      if (candidate.issue || candidate.primaryRelativePath !== file.path || !match({ candidate })) {
        return false;
      }
      // Catalog availability belongs to the explicitly selected destination.
      // A copy in another root must not suppress Download for this root.
      if (destinationId === 'opfs' ? modelLocation({ candidate }).kind !== 'opfs'
        : candidate.hostSource?.directoryId !== destinationId) {
        return false;
      }
      if (candidate.hostSource) {
        if (candidate.hostSource.repository !== file.repository) {
          return false;
        }
      } else if (!candidate.repositoryKey.startsWith('user/') && candidate.repositoryKey !== target && candidate.repositoryKey !== `huggingface.co/${file.repository}/resolve/${file.revision}`) {
        return false;
      }
      const receipt = candidate.files.find(entry => entry.relativePath === file.path)?.receipt;
      if (receipt?.source.kind === 'hugging-face' && receipt.source.revision !== file.revision) {
        return false;
      }
      return true;
    });
    const preferred = ({ candidate }: { candidate: ModelCandidate }) => destinationId === 'opfs'
      ? candidate.repositoryKey === target : candidate.hostSource?.directoryId === destinationId;
    matches.sort((a, b) => Number(preferred({ candidate: b })) - Number(preferred({ candidate: a })) || a.candidateKey.localeCompare(b.candidateKey));
    return matches[0];
  }
  function recipeAvailability({ recipeId, selections }: { recipeId: string, selections: ImageRecipeSelection }): ImageRecipeAvailability {
    return recipeAvailabilityAt({ recipeId, selections, destinationId: hostDirectories.destination.value });
  }
  function recipeAvailabilityAt({ recipeId, selections: requested, destinationId }: { recipeId: string, selections: ImageRecipeSelection, destinationId: string }): ImageRecipeAvailability {
    const recipe = imageModelRecipes.find(item => item.id === recipeId);
    if (!recipe) {
      return { available: 0, total: 0, selected: false, bytes: 0 };
    }
    const family = (() => {
      switch (recipe.id) {
      case 'z-image-turbo': case 'z-image-base': return 'z-image' as const;
      case 'qwen-image-2.1': case 'qwen-image-2.1-turbo': return 'qwen-image-2.1' as const;
      case 'sdxl-base-1.0': return 'sd-checkpoint' as const;
      case 'flux2-klein-4b': return 'flux2-klein-4b' as const;
      case 'anima-turbo-1.1': return 'anima' as const;
      case 'krea2-turbo': return 'krea2' as const;
      case 'ernie-image-turbo': return 'ernie-image' as const;
      default: {
        const exhaustive: never = recipe.id;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const requirements = componentRequirements({ family });
    const files = selectedRecipeFiles({ recipe, selections: requested });
    const candidates = files.map(file => findRecipeFile({
      file,
      destinationId,
      match: ({ candidate }) => {
        switch (file.role) {
        case 'model': case 'diffusion': return candidate.family === family;
        case 'vae': case 'lm': {
          const requirement = requirements.find(item => item.slot === file.role);
          return requirement !== undefined && componentMatch({ candidate, requirement }) === 'matching';
        }
        default: {
          const exhaustive: never = file.role;
          throw new Error(String(exhaustive));
        }
        }
      },
    }));
    return {
      available: candidates.filter(candidate => candidate !== undefined).length,
      total: files.length,
      selected: candidates.every((candidate, index) => {
        if (!candidate) {
          return false;
        }
        const role = files[index]!.role;
        switch (role) {
        case 'model': case 'diffusion': return candidate.candidateKey === selectedCandidateKey.value;
        case 'vae': case 'lm': return candidate.candidateKey === componentCandidateKeys.value[role];
        default: {
          const exhaustive: never = role;
          throw new Error(String(exhaustive));
        }
        }
      }),
      bytes: candidates.reduce((sum, candidate) => sum + (candidate?.size ?? 0), 0),
    };
  }
  function resolveRecipe(): void {
    if (!recipeIntent) {
      return;
    }
    const file = recipeIntent.files.find(file => file.role === 'model' || file.role === 'diffusion');
    const candidate = file && findRecipeFile({ file, destinationId: recipeIntent.destinationId, match: ({ candidate: item }) => item.family === recipeIntent?.family });
    if (candidate && candidate.candidateKey !== selectedCandidateKey.value) {
      selectedCandidateKey.value = candidate.candidateKey;
      onSelection({ family: candidate.family, turbo: candidate.turboHint });
    }
  }
  function loraAvailable({ id }: { id: string }): boolean {
    return loraAvailableAt({ id, destinationId: hostDirectories.destination.value });
  }
  function loraAvailableAt({ id, destinationId }: { id: string, destinationId: string }): boolean {
    const entry = imageCatalogLoras.find(item => item.id === id);
    if (!entry) {
      return false;
    }
    const expected = entry.source;
    return inventory.value.candidates.some(candidate => {
      if (candidate.issue || !candidate.classes.includes('lora') || candidate.files.length !== 1 || candidate.primaryRelativePath !== expected.path) {
        return false;
      }
      if (destinationId === 'opfs' ? modelLocation({ candidate }).kind !== 'opfs'
        : candidate.hostSource?.directoryId !== destinationId) {
        return false;
      }
      const receipt = candidate.files[0]?.receipt, source = receipt?.source;
      // A selectable, markerless host adapter is not proof this catalog artifact
      // was acquired. Completion requires the exact published source and bytes.
      return source?.kind === 'hugging-face' && source.repository === expected.repository && source.revision === expected.revision && source.path === expected.path
        && receipt?.size === expected.size && source.sha256 === expected.sha256;
    });
  }
  function chooseRecipe({ recipeId, selections: requested }: { recipeId: string, selections: ImageRecipeSelection }): void {
    if (blocked() || importing.value || scanState.value === 'scanning' || disposed) {
      return;
    }
    const recipe = imageModelRecipes.find(recipe => recipe.id === recipeId);
    if (!recipe) {
      return;
    }
    const files = selectedRecipeFiles({ recipe, selections: requested });
    const destinationId = hostDirectories.destination.value;
    selectionVersion++;
    unavailableLoras = [];
    switch (recipe.id) {
    case 'z-image-turbo': case 'z-image-base': recipeIntent = { family: 'z-image', files, destinationId };
      break;
    case 'qwen-image-2.1': case 'qwen-image-2.1-turbo': recipeIntent = { family: 'qwen-image-2.1', files, destinationId };
      break;
    case 'sdxl-base-1.0': recipeIntent = { family: 'sd-checkpoint', files, destinationId };
      break;
    case 'flux2-klein-4b': recipeIntent = { family: 'flux2-klein-4b', files, destinationId };
      break;
    case 'anima-turbo-1.1': recipeIntent = { family: 'anima', files, destinationId };
      break;
    case 'krea2-turbo': recipeIntent = { family: 'krea2', files, destinationId };
      break;
    case 'ernie-image-turbo': recipeIntent = { family: 'ernie-image', files, destinationId };
      break;
    default: {
      const exhaustive: never = recipe.id;
      throw new Error(String(exhaustive));
    }
    }
    origin = 'manual';
    selectedCandidateKey.value = '';
    componentCandidateKeys.value = {};
    overrides.clear();
    resolveRecipe();
    resolve();
  }
  async function downloadRecipe({ recipeId, selections: requested }: { recipeId: string, selections: ImageRecipeSelection }): Promise<void> {
    if (downloadsBlocked() || importing.value || disposed) {
      return;
    }
    const recipe = imageModelRecipes.find(recipe => recipe.id === recipeId);
    if (!recipe) {
      return;
    }
    const choices = { ...requested }, files = selectedRecipeFiles({ recipe, selections: choices });
    await enqueueDownload({ target: { kind: 'recipe', id: recipeId, selections: choices }, files, label: recipe.title });
  }
  async function downloadLora({ id }: { id: string }): Promise<void> {
    if (downloadsBlocked() || importing.value || disposed) {
      return;
    }
    const entry = imageCatalogLoras.find(entry => entry.id === id);
    if (!entry) {
      return;
    }
    await enqueueDownload({ target: { kind: 'lora', id }, files: [entry.source], label: entry.title });
  }
  function authorizeDownload({ destinationId }: { destinationId: string }): DownloadJob['authorization'] {
    // Capture physical identity at the explicit action, before waiting in the queue.
    const root = host && destinationId !== 'opfs'
      ? hostModelHandles.get({ id: toHostModelDirectoryId({ raw: destinationId }) }).then(handle => ({ handle }), error => ({ error }))
      : Promise.resolve(undefined);
    const permission = host ? host.downloadDestination({ id: destinationId }) : Promise.resolve<ImageDownloadDestination>({ kind: 'opfs' });
    return permission.then(async destination => {
      const captured = await root;
      if (captured && 'error' in captured) {
        throw captured.error;
      }
      return { destination, error: undefined, root: captured?.handle };
    }).catch(error => ({ destination: undefined, error, root: undefined }));
  }
  async function enqueueDownload({ target, files, label }: { target: DownloadTarget, files: readonly ImageDownloadSource[], label: string }): Promise<void> {
    const destinationId = hostDirectories.destination.value;
    const key = JSON.stringify([destinationId, files.map(file => [file.repository, file.revision, file.path]).sort()]);
    if (jobs.value.some(job => job.key === key)) {
      return;
    }
    const job: DownloadJob = {
      id: String(++jobSequence),
      key,
      target,
      files: files.map(file => ({ ...file })),
      destinationId,
      destinationName: destinationId === 'opfs' ? 'OPFS' : hostDirectories.entries.value.find(entry => entry.id === destinationId)?.name ?? destinationId,
      label,
      authorization: authorizeDownload({ destinationId }),
      managedId: undefined,
      boundRoot: undefined,
      state: 'queued',
      error: '',
      completion: Promise.withResolvers<void>(),
      selectionVersion,
      selectWhenComplete: !selectedCandidateKey.value && origin !== 'files',
    };
    jobs.value = [...jobs.value, job];
    void processDownloads();
    await job.completion.promise;
  }
  async function processDownloads(): Promise<void> {
    // File imports and host directory mutations must finish publication before
    // queued downloads are submitted to the shared execution manager.
    if (importing.value || hostDirectories.busy.value || disposed) {
      return;
    }
    for (const job of jobs.value) {
      if (job.state !== 'queued' || job.managedId !== undefined) {
        continue;
      }
      const destination: ImageDownloadDestination = job.destinationId === 'opfs' ? { kind: 'opfs' } : { kind: 'host', directoryId: job.destinationId };
      const managed = manager.enqueue({
        key: `image:${job.key}`,
        title: job.label,
        category: 'image-model',
        destination,
        files: downloadFilesForDisplay({ files: job.files, destination, rootName: job.destinationName }),
        onResume: () => {
          job.authorization = authorizeDownload({ destinationId: job.destinationId });
        },
        run: async ({ execution }) => {
          currentJob = job;
          await downloadFiles({ job, execution });
        },
      });
      job.managedId = managed.id;
      const previous = manager.snapshot().find(entry => entry.id === managed.id);
      const done = previous?.status === 'paused' || previous?.status === 'failed' ? manager.resume({ id: managed.id }) ?? managed.done : managed.done;
      void done.then(() => {
        const removed = !jobs.value.includes(job);
        job.completion.resolve();
        switch (job.state) {
        case 'complete': jobs.value = jobs.value.filter(entry => entry !== job);
          break;
        case 'queued': case 'downloading': case 'paused': case 'failed': case 'incomplete': break;
        default: {
          const exhaustive: never = job.state;
          throw new Error(String(exhaustive));
        }
        }
        if (removed && currentJob === job) {
          currentJob = undefined;
          clearDownloadIntent();
        }
      });
    }
  }
  const completedSeen = new Set(manager.snapshot().filter(job => job.status === 'complete').map(job => job.id));
  const unsubscribeDownloads = manager.subscribe({
    listener: () => {
      if (disposed) {
        return;
      }
      const snapshot = manager.snapshot();
      const present = new Set(snapshot.map(entry => entry.id));
      // Removal is published only after the manager has drained the writer. A
      // panel cancellation must disappear from an already-open library as well.
      jobs.value = jobs.value.filter(job => {
        if (job.managedId === undefined || present.has(job.managedId)) {
          return true;
        }
        job.completion.resolve();
        if (currentJob === job) {
          currentJob = undefined;
          clearDownloadIntent();
        }
        return false;
      });
      for (const managed of snapshot) {
        const job = jobs.value.find(entry => entry.managedId === managed.id);
        if (job) {
          switch (managed.status) {
          case 'queued': job.state = 'queued';
            break;
          case 'resolving': case 'downloading': case 'pausing': case 'cancelling': job.state = 'downloading';
            break;
          case 'paused': case 'failed': job.state = managed.status;
            break;
          case 'complete':
            switch (job.state) {
            case 'incomplete': break;
            case 'complete': case 'queued': case 'downloading': case 'paused': case 'failed': job.state = 'complete';
              break;
            default: {
              const exhaustive: never = job.state;
              throw new Error(String(exhaustive));
            }
            }
            break;
          case 'cancelled': break;
          default: {
            const exhaustive: never = managed.status;
            throw new Error(String(exhaustive));
          }
          }
        }
        if (managed.category === 'image-model' && managed.status === 'complete' && !completedSeen.has(managed.id)) {
          completedSeen.add(managed.id);
          // A reopened view can observe a download owned by an older, closed view.
          if (currentJob?.managedId !== managed.id) {
            void refresh().catch(error => {
              failure.value = error instanceof Error ? error.message : String(error);
            });
          }
        }
      }
      publishJobs();
    },
  });
  function completeDownload({ job }: { job: DownloadJob }): boolean {
    const { target, destinationId } = job;
    switch (target.kind) {
    case 'recipe': {
      const availability = recipeAvailabilityAt({ recipeId: target.id, selections: target.selections, destinationId });
      const available = availability.available === availability.total;
      if (job.selectWhenComplete && job.selectionVersion === selectionVersion && !blocked() && destinationId === hostDirectories.destination.value) {
        chooseRecipe({ recipeId: target.id, selections: target.selections });
      }
      return available;
    }
    case 'lora': return loraAvailableAt({ id: target.id, destinationId });
    default: {
      const exhaustive: never = target;
      throw new Error(String(exhaustive));
    }
    }
  }
  async function downloadFiles({ job, execution }: { job: DownloadJob, execution: DownloadExecution }): Promise<void> {
    const { target, files, destinationId } = job;
    const controller = new AbortController();
    const abort = () => controller.abort();
    execution.signal.addEventListener('abort', abort, { once: true });
    if (execution.signal.aborted) {
      abort();
    }
    activeDownload.value = controller;
    const completion = Promise.withResolvers<void>();
    downloadCompletion = { promise: completion.promise, directoryId: destinationId === 'opfs' ? undefined : destinationId };
    if (!preparingHistoryFiles) {
      cancelScan();
    }
    failure.value = '';
    downloadState.value = 'downloading';
    downloadTarget.value = target;
    downloadProgress.value = undefined;
    job.state = 'downloading';
    job.error = '';
    publishJobs();
    let transferred = false;
    let transferFailure: { error: unknown } | undefined;
    try {
      const authorization = await awaitInspection({ task: job.authorization, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!authorization.destination) {
        throw authorization.error;
      }
      if (host && destinationId !== 'opfs' && !host.registrations().some(entry => entry.id === destinationId)) {
        throw new Error('Linked model directory is unavailable');
      }
      if (job.boundRoot && authorization.root && !await job.boundRoot.isSameEntry(authorization.root)) {
        throw new Error('Linked model folder changed after this download was queued');
      }
      job.boundRoot ??= authorization.root;
      execution.setFiles({ files: downloadFilesForDisplay({ files, destination: authorization.destination, rootName: job.boundRoot?.name }) });
      await deps.download({
        files,
        expectedRoot: job.boundRoot,
        destination: authorization.destination,
        signal: controller.signal,
        onProgress: ({ progress }) => {
          execution.reportFile({ index: progress.index, patch: { size: progress.fileTotal || undefined, completed: progress.fileCompleted, state: progress.phase } });
          if (!disposed && !controller.signal.aborted) {
            downloadProgress.value = progress;
          }
        },
      });
      transferred = true;
    } catch (error) {
      transferFailure = { error };
      if (!disposed) {
        downloadState.value = controller.signal.aborted ? 'paused' : 'failed';
        job.state = downloadState.value;
        if (!controller.signal.aborted) {
          job.error = failure.value = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      if (!disposed && !controller.signal.aborted && preparingHistoryFiles && activeScan) {
        // A history restore owns this existing read. Do not cancel it or mistake
        // its older listing for publication of the just-completed download.
        await awaitInspection({ task: activeScan.promise, signal: controller.signal }).catch(() => undefined);
      }
      if (!disposed && !controller.signal.aborted) {
        // Publish only inventory while generation or editing proceeds. Existing
        // selections, request snapshots and user parameters retain their owners.
        const abort = () => cancelScan();
        controller.signal.addEventListener('abort', abort, { once: true });
        let scanned: InventoryRefreshResult;
        try {
          // OPFS catalog downloads publish under resolve/main. A failed or
          // host transfer still uses a full scan; completed unrelated OPFS
          // publications need not replace every retained File snapshot.
          const repositoryKeys = transferred && inventoryReady && destinationId === 'opfs'
            ? [...new Set(files.map(file => `huggingface.co/${file.repository}/resolve/main`))] : undefined;
          scanned = await refreshInventory({ completingImport: undefined, preserveSelection: true, repositoryKeys });
        } finally {
          controller.signal.removeEventListener('abort', abort);
        }
        if (transferred) {
          const available = scanned === 'scanned' && completeDownload({ job });
          job.state = available ? 'complete' : 'incomplete';
          downloadState.value = job.state;
        }
        if (!job.error) {
          job.error = failure.value;
        } else {
          failure.value = job.error;
        }
      }
      if (transferred && (controller.signal.aborted || disposed)) {
        job.state = downloadState.value = 'complete';
      } else if (controller.signal.aborted && jobs.value.includes(job)) {
        job.state = downloadState.value = 'paused';
      }
      if (activeDownload.value === controller) {
        activeDownload.value = undefined;
      }
      publishJobs();
      completion.resolve();
      if (downloadCompletion?.promise === completion.promise) {
        downloadCompletion = undefined;
      }
      execution.signal.removeEventListener('abort', abort);
    }
    if (transferFailure) {
      throw transferFailure.error;
    }
  }
  function resetDownloadIntent(): void {
    // Pending jobs own their selections independently of the catalog form.
    if (!downloading.value && (!currentJob || !jobs.value.includes(currentJob))) {
      clearDownloadIntent();
    }
  }
  function clearDownloadIntent(): void {
    downloadState.value = 'idle';
    downloadTarget.value = undefined;
    downloadProgress.value = undefined;
  }
  async function retryQueuedDownload({ id }: { id: string }): Promise<void> {
    const job = jobs.value.find(job => job.id === id);
    if (!job || downloadsBlocked() || disposed || importing.value || job.state === 'queued' || job.state === 'downloading') {
      return;
    }
    job.state = 'queued';
    job.error = '';
    job.completion = Promise.withResolvers<void>();
    publishJobs();
    if (job.managedId !== undefined) {
      const retry = manager.resume({ id: job.managedId });
      if (retry) {
        await retry;
        job.completion.resolve();
      } else {
        // The files may be complete while the model composition is incomplete.
        // An explicit retry is a new transfer request, not revived completion.
        job.managedId = undefined;
        job.authorization = authorizeDownload({ destinationId: job.destinationId });
        void processDownloads();
      }
    } else {
      void processDownloads();
    }
    await job.completion.promise;
  }
  async function resumeDownload(): Promise<void> {
    const resumable = currentJob && ['paused', 'failed', 'incomplete'].includes(currentJob.state) ? currentJob : jobs.value.find(job => ['paused', 'failed', 'incomplete'].includes(job.state));
    if (resumable) {
      await retryQueuedDownload({ id: resumable.id });
    }
  }
  function removeQueuedDownload({ id }: { id: string }): void {
    const job = jobs.value.find(job => job.id === id);
    if (!job) {
      return;
    }
    jobs.value = jobs.value.filter(entry => entry !== job);
    if (currentJob !== job || !activeDownload.value) {
      job.completion.resolve();
    }
    if (job.managedId !== undefined) {
      void manager.remove({ id: job.managedId });
    }
    if (currentJob === job) {
      if (activeDownload.value) {
        activeDownload.value.abort();
      } else {
        currentJob = undefined;
        clearDownloadIntent();
      }
    }
    void processDownloads();
  }
  function cancelDownload(): void {
    const job = activeDownload.value ? currentJob : jobs.value.find(entry => entry.state === 'queued');
    if (job?.managedId !== undefined) {
      manager.pause({ id: job.managedId });
    }
  }
  async function waitForEditor({ signal }: { signal: AbortSignal }): Promise<void> {
    if (!blocked() || signal.aborted || disposed) {
      return;
    }
    await new Promise<void>(resolve => {
      const finish = () => {
        stop();
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const stop = watch(blocked, value => {
        if (!value) {
          finish();
        }
      }, { flush: 'sync' });
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted || disposed || !blocked()) {
        finish();
      }
    });
  }
  async function refreshAfterMutation({ signal, completingImport, repositoryKeys }: { signal: AbortSignal, completingImport: AbortController | undefined, repositoryKeys: string[] | undefined }): Promise<boolean> {
    const selectedRepositories = inventoryReady ? repositoryKeys : undefined;
    inventoryReady = false;
    inspectedMissingFiles.clear();
    const abort = () => cancelScan();
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Saving existing images may temporarily own the editor. That is not an
      // incomplete model: keep this preparation active until it can publish safely.
      // Cancellation must also release host unlink/disposal waiters. Completed
      // files stay on disk and the next refresh/resume can inspect them.
      while (!disposed && !signal.aborted) {
        await waitForEditor({ signal });
        if (disposed || signal.aborted) {
          return false;
        }
        const result = await refreshInventory({ completingImport, preserveSelection: false, repositoryKeys: selectedRepositories });
        switch (result) {
        case 'scanned': return true;
        case 'failed': return false;
        case 'blocked': break;
        default: {
          const exhaustive: never = result;
          throw new Error(String(exhaustive));
        }
        }
      }
      return false;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async function refresh(): Promise<void> {
    if (downloading.value) {
      return;
    }
    await refreshInventory({ completingImport: undefined, preserveSelection: false });
  }
  async function refreshAccess(): Promise<void> {
    // Focus only updates permission/availability; it is not a model mutation.
    if (disposed || importing.value || hostDirectories.busy.value) {
      return;
    }
    try {
      await host?.refresh();
    } catch (error) {
      if (!disposed) {
        failure.value = error instanceof Error ? error.message : String(error);
      }
    }
  }
  async function prepareHistoryFiles({ requiredFiles }: { requiredFiles: readonly ImageGenerationModelFile[] }): Promise<void> {
    if (disposed || importing.value || preparingHistoryFiles) {
      throw new Error('Local model files are busy');
    }
    const missing = requiredFiles.filter(location => location.type !== 'file' && !findHistoryFile({ location }));
    const missingKey = JSON.stringify(missing);
    if (inventoryReady && !activeScan && (!missing.length || inspectedMissingFiles.has(missingKey))) {
      return;
    }
    // Explicit history reuse owns this read while the editor is disabled. Share
    // an initial scan already in flight, without selecting a different model or
    // applying its presets before the saved request has been resolved.
    preparingHistoryFiles = true;
    try {
      const result = await refreshInventory({ completingImport: undefined, preserveSelection: false });
      switch (result) {
      case 'scanned': inspectedMissingFiles.add(missingKey);
        break;
      case 'blocked': case 'failed': throw new Error(failure.value || 'Local model files could not be inspected');
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
    } finally {
      preparingHistoryFiles = false;
    }
  }
  function cancelScan(): void {
    const previous = activeScan;
    activeScan = undefined;
    previous?.controller.abort();
    scanState.value = 'idle';
    scanProgress.value = undefined;
  }
  function refreshInventory({ completingImport, preserveSelection, repositoryKeys }: { completingImport: AbortController | undefined, preserveSelection: boolean, repositoryKeys?: string[] }): Promise<InventoryRefreshResult> {
    if (disposed || activeImport.value !== completingImport) {
      return Promise.resolve('failed');
    }
    if (blocked() && !preparingHistoryFiles && !preserveSelection) {
      return Promise.resolve('blocked');
    }
    // Repeated window focus/refresh must not cancel and restart a large scan.
    if (activeScan) {
      return activeScan.promise;
    }
    const scan = new AbortController();
    const operation: { controller: AbortController, promise: Promise<InventoryRefreshResult> } = { controller: scan, promise: Promise.resolve('failed') };
    activeScan = operation;
    scanState.value = 'scanning';
    failure.value = '';
    scanProgress.value = { phase: 'listing', completed: 0, total: 0, entryPath: '' };
    const temporaryRoots = temporaryModelFiles.list();
    operation.promise = (async () => {
      try {
        if (host) {
          await awaitInspection({ task: host.refresh(), signal: scan.signal });
        }
        const onProgress = ({ progress }: { progress: InspectionProgress }) => {
          if (activeScan === operation && !scan.signal.aborted) {
            scanProgress.value = progress;
          }
        };
        // Dependency injection remains read-only and abort-raced for regression tests.
        const inspected = await awaitInspection({
          signal: scan.signal,
          task: dependencies ? (async () => {
            const storedIds = repositoryKeys?.filter(id => !id.startsWith('temp/'));
            const stored = storedIds?.length === 0 ? []
              : await awaitInspection({ task: dependencies.list({ signal: scan.signal, onProgress, repositoryKeys: storedIds }), signal: scan.signal });
            const repositories = [...stored, ...temporaryImageRepositories({ roots: temporaryRoots })];
            scan.signal.throwIfAborted();
            return dependencies.scan({ repositories: repositoryKeys ? repositories.filter(repository => repositoryKeys.includes(repository.repositoryKey)) : repositories, signal: scan.signal, onProgress });
          })() : inspectImageInventory({ signal: scan.signal, onProgress, hostDirectories: host?.registrations().map(({ id, name }) => ({ directoryId: id, directoryName: name })), repositoryKeys, temporaryRepositories: temporaryImageRepositories({ roots: temporaryRoots }) }),
        });
        if (disposed || scan.signal.aborted || activeScan !== operation || activeImport.value !== completingImport
          || temporaryRoots.some(root => temporaryModelFiles.get({ rootPath: root.rootPath }) !== root)) {
          return 'failed';
        }
        if (blocked() && !preparingHistoryFiles && !preserveSelection) {
          return 'blocked';
        }
        const next = restoreTemporaryImageFiles({ inventory: inspected, roots: temporaryRoots });
        // A targeted scan is not evidence that other repositories disappeared.
        // Preserve their exact original File objects, not metadata lookalikes.
        const published = repositoryKeys ? {
          candidates: [...inventory.value.candidates.filter(candidate => !repositoryKeys.includes(candidate.repositoryKey)), ...next.candidates],
          issues: [...inventory.value.issues.filter(issue => !repositoryKeys.includes(issue.repositoryKey)), ...next.issues],
        } : next;
        inventory.value = published;
        inventoryReady = true;
        inspectedMissingFiles.clear();
        for (const candidate of published.candidates) {
          const file = candidate.files.find(entry => entry.relativePath === candidate.primaryRelativePath)?.file;
          if (file && !candidate.issue) {
            knownLocations.set(file, modelLocation({ candidate }));
          }
        }
        if (preparingHistoryFiles) {
          return 'scanned';
        }
        if (preserveSelection) {
          // Complete missing companions for an already chosen model, without
          // choosing a new primary or applying its generation presets.
          if (!blocked()) {
            resolve();
          }
          return 'scanned';
        }
        if (!published.candidates.some(candidate => candidate.candidateKey === selectedCandidateKey.value)) {
          selectedCandidateKey.value = '';
          componentCandidateKeys.value = {};
          overrides.clear();
          if (automaticOrigin({ origin })) {
            const key = chooseInitialImagePrimary({ candidates: imageSelectionCandidates({ candidates: published.candidates }) });
            const first = published.candidates.find(candidate => candidate.candidateKey === key);
            if (first) {
              selectedCandidateKey.value = first.candidateKey;
              onSelection({ family: first.family, turbo: first.turboHint });
            }
          }
        }
        resolveRecipe();
        resolve();
        return 'scanned';
      } catch (error) {
        if (!disposed && activeScan === operation && !scan.signal.aborted) {
          failure.value = error instanceof Error ? error.message : String(error);
        }
        return 'failed';
      } finally {
        if (activeScan === operation) {
          activeScan = undefined;
          scanState.value = 'idle';
          scanProgress.value = undefined;
        }
      }
    })();
    return operation.promise;
  }
  async function importInputs({ collect, storage }: { storage: 'opfs' | 'temp' | undefined, collect: ({ signal }: { signal: AbortSignal }) => Promise<Parameters<typeof importImageRepository>[0]['input'][]> }): Promise<void> {
    if (blocked() || importing.value || activeDownload.value !== undefined || disposed) {
      return;
    }
    const controller = new AbortController();
    activeImport.value = controller;
    cancelScan();
    failure.value = '';
    importProgress.value = { completed: 0, total: 0 };
    const publishedRepositories: string[] = [];
    try {
      // collect is invoked during drop dispatch, before awaiting entry traversal.
      const directories = await collect({ signal: controller.signal });
      controller.signal.throwIfAborted();
      for (const input of directories) {
        controller.signal.throwIfAborted();
        let repositoryKey: string;
        switch (storage) {
        case 'temp':
          repositoryKey = temporaryModelFiles.register({ directory: input, signal: controller.signal }).rootPath;
          break;
        case 'opfs': case undefined:
          repositoryKey = await deps.import({
            input,
            signal: controller.signal,
            onProgress: ({ progress }) => {
              if (!disposed) {
                importProgress.value = progress;
              }
            },
          });
          break;
        default: {
          const exhaustive: never = storage;
          throw new Error(String(exhaustive));
        }
        }
        publishedRepositories.push(repositoryKey);
      }
    } catch (error) {
      if (!disposed && !controller.signal.aborted) {
        failure.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      try {
        if (!disposed && publishedRepositories.length) {
          // Keep this import's ownership through publication; waiting for another
          // save must not admit a second import or lose the completed files.
          const importFailure = failure.value;
          await refreshAfterMutation({ signal: controller.signal, completingImport: controller, repositoryKeys: publishedRepositories.every(id => typeof id === 'string' && id.length > 0) ? publishedRepositories : undefined });
          if (!disposed && activeImport.value === controller && importFailure) {
            failure.value = [importFailure, failure.value].filter(Boolean).join('\n');
          }
        }
      } finally {
        if (activeImport.value === controller) {
          activeImport.value = undefined;
          importProgress.value = undefined;
        }
      }
    }
  }
  async function importDirectory({ event, storage }: { event: Event, storage?: 'opfs' | 'temp' }): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) {
      return;
    }
    await importInputs({ collect: async () => [imageDirectoryFromFiles({ files })], storage });
  }
  async function dropDirectory({ event, storage }: { event: DragEvent, storage?: 'opfs' | 'temp' }): Promise<void> {
    const transfer = event.dataTransfer;
    if (!transfer) {
      return;
    }
    await importInputs({ collect: ({ signal }) => imageDirectoriesFromDrop({ transfer, signal }), storage });
  }
  async function importFiles({ event, storage }: { event: Event, storage: 'opfs' | 'temp' }): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) {
      return;
    }
    await importInputs({ collect: async () => files.map(file => imageDirectoryForFile({ file })), storage });
  }
  function selectedModels(): Request['models'] | undefined {
    if (!ready.value || !selected.value) {
      return undefined;
    }
    const slot = primarySlot({ family: selected.value.family });
    if (!slot) {
      return undefined;
    }
    const selectionsToUse = [{ slot, candidate: selected.value }, ...requirements.value.flatMap(({ slot }) => {
      const candidate = inventory.value.candidates.find(item => item.candidateKey === componentCandidateKeys.value[slot]);
      return candidate ? [{ slot, candidate }] : [];
    })];
    return selectionsToUse.map(({ slot, candidate }) => modelForCandidate({ slot, candidate }));
  }
  function historyFileLocation({ file }: { file: File }): ImageGenerationModelFile {
    const metadata = { name: file.name, size: file.size, lastModified: file.lastModified };
    for (const candidate of inventory.value.candidates) {
      const entry = candidate.files.find(entry => entry.file === file);
      if (!entry) {
        continue;
      }
      const location = imageModelLocation({ repositoryKey: candidate.repositoryKey, hostSource: candidate.hostSource, relativePath: entry.relativePath });
      switch (location.kind) {
      case 'opfs': case 'temp': return { ...metadata, type: location.kind, path: location.path };
      case 'host': return { ...metadata, type: 'host', directoryId: location.directoryId, path: location.path };
      default: {
        const exhaustive: never = location;
        throw new Error(String(exhaustive));
      }
      }
    }
    return { ...metadata, type: 'file' };
  }
  function findHistoryFile({ location }: { location: ImageGenerationModelFile }): File | undefined {
    // Only the inspected local inventory is consulted, never another source.
    // Stored/linked files retain their location-and-metadata checks. A temp/
    // locator intentionally resolves whatever is currently registered there,
    // including a different same-named file after unregister/re-registration.
    for (const candidate of inventory.value.candidates) {
      if (candidate.issue) {
        continue;
      }
      for (const entry of candidate.files) {
        const file = entry.file;
        if (location.type !== 'temp' && (file.name !== location.name || file.size !== location.size || file.lastModified !== location.lastModified)) {
          continue;
        }
        switch (location.type) {
        case 'file': return undefined;
        case 'temp':
          // temp/ is a current pathname, not a metadata/content identity promise.
          if (modelLocation({ candidate }).kind === 'temp' && `${candidate.repositoryKey}/${entry.relativePath}` === location.path) {
            return file;
          }
          break;
        case 'opfs':
          if (modelLocation({ candidate }).kind === 'opfs' && `${OPFS_MODELS_DIR}/${candidate.repositoryKey}/${entry.relativePath}` === location.path) {
            return file;
          }
          break;
        case 'host':
          if (candidate.hostSource?.directoryId === idToRaw({ id: location.directoryId }) && `${candidate.hostSource.repository}/${entry.relativePath}` === location.path) {
            return file;
          }
          break;
        default: {
          const exhaustive: never = location;
          throw new Error(String(exhaustive));
        }
        }
      }
    }
    return undefined;
  }
  function modelLocation({ candidate }: { candidate: ModelCandidate }): BrowserImageModelLocation {
    return imageModelLocation({ repositoryKey: candidate.repositoryKey, hostSource: candidate.hostSource, relativePath: candidate.primaryRelativePath });
  }
  function candidateAt({ location }: { location: BrowserImageModelLocation }): ModelCandidate | undefined {
    return inventory.value.candidates.find(candidate => !candidate.issue && sameImageModelLocation({ left: modelLocation({ candidate }), right: location }));
  }
  let unavailableLoras: { index: number, selection: BrowserImageModelSelection['loras'][number] }[] = [];
  function restoreModelSelection({ selection }: { selection: BrowserImageModelSelection }) {
    // Restoration only consults the inspected local inventory. It neither asks
    // for host permission nor substitutes a same-named file from another root.
    const { primary, components: savedComponents, loras, ...unhandled } = selection;
    unhandled satisfies Record<PropertyKey, never>;
    const candidate = candidateAt({ location: primary.location });
    const missing: string[] = [], missingInactive: string[] = [];
    origin = 'manual';
    recipeIntent = undefined;
    overrides.clear();
    componentCandidateKeys.value = {};
    selectedCandidateKey.value = candidate && primarySlot({ family: candidate.family }) === primary.slot ? candidate.candidateKey : `unavailable:${JSON.stringify(primary.location)}`;
    if (selectedCandidateKey.value !== candidate?.candidateKey) {
      missing.push(primary.location.path);
    }
    for (const { slot, choice } of savedComponents) {
      overrides.add(slot);
      const requirement = requirements.value.find(item => item.slot === slot);
      switch (choice.kind) {
      case 'none': componentCandidateKeys.value = { ...componentCandidateKeys.value, [slot]: '' };
        break;
      case 'file': {
        const component = candidateAt({ location: choice.location });
        const usable = component && requirement && componentMatch({ candidate: component, requirement }) !== 'incompatible';
        componentCandidateKeys.value = { ...componentCandidateKeys.value, [slot]: usable ? component.candidateKey : `unavailable:${JSON.stringify(choice.location)}` };
        if (!usable) {
          missing.push(choice.location.path);
        }
        break;
      }
      default: {
        const exhaustive: never = choice;
        throw new Error(String(exhaustive));
      }
      }
    }
    resolve();
    unavailableLoras = [];
    const restoredLoras: ImageLoraSelection[] = [];
    loras.forEach((selection, index) => {
      const { location, enabled, strength, ...unhandled } = selection;
      unhandled satisfies Record<PropertyKey, never>;
      const candidate = candidateAt({ location });
      const file = candidate?.files.find(entry => entry.relativePath === candidate.primaryRelativePath)?.file;
      if (!file) {
        unavailableLoras.push({ index, selection });
        switch (enabled) {
        case 'enabled': missing.push(location.path);
          break;
        case 'disabled': missingInactive.push(location.path);
          break;
        default: {
          const exhaustive: never = enabled;
          throw new Error(String(exhaustive));
        }
        }
      } else {
        restoredLoras.push({ file, relativePath: candidate!.primaryRelativePath, locationLabel: location.path, enabled: enabled === 'enabled', strength });
      }
    });
    return { loras: restoredLoras, missing, missingInactive };
  }
  function captureModelSelection({ loras }: { loras: readonly ImageLoraSelection[] }): BrowserImageModelSelection | undefined {
    if (origin === 'files' || !selected.value) {
      return undefined;
    }
    const slot = primarySlot({ family: selected.value.family });
    if (slot !== 'model' && slot !== 'diffusion') {
      return undefined;
    }
    const savedComponents: BrowserImageModelSelection['components'] = [];
    for (const requirement of requirements.value) {
      // Omitted components remain automatic. A catalog recipe explicitly names
      // its component files, just as an individual picker override does.
      if (!overrides.has(requirement.slot) && !recipeIntent?.files.some(file => file.role === requirement.slot)) {
        continue;
      }
      const id = componentCandidateKeys.value[requirement.slot];
      const candidate = inventory.value.candidates.find(item => item.candidateKey === id);
      if (!candidate && id) {
        return undefined;
      }
      const slot = requirement.slot;
      savedComponents.push({ slot, choice: candidate ? { kind: 'file', location: modelLocation({ candidate }) } : { kind: 'none' } });
    }
    const savedLoras: BrowserImageModelSelection['loras'] = [];
    for (const lora of loras) {
      const location = knownLocations.get(lora.file);
      // An unregistered loose File must not erase a previous restorable selection.
      // Files from a shared temporary folder do have a persistable temp/ location.
      if (!location || !Number.isFinite(lora.strength) || lora.strength < -10 || lora.strength > 10) {
        return undefined;
      }
      savedLoras.push({ location, enabled: lora.enabled ? 'enabled' : 'disabled', strength: lora.strength });
    }
    for (const pending of unavailableLoras) {
      savedLoras.splice(Math.min(pending.index, savedLoras.length), 0, pending.selection);
    }
    if (savedLoras.length > 16) {
      return undefined;
    }
    return { primary: { slot, location: modelLocation({ candidate: selected.value }) }, components: savedComponents, loras: savedLoras };
  }
  function modelForCandidate({ slot, candidate }: { slot: ModelSlot, candidate: ModelCandidate }): Request['models'][number] {
    const file = candidate.files.find(entry => entry.relativePath === candidate.primaryRelativePath);
    if (!file) {
      throw new Error('Selected model file disappeared from the inventory');
    }
    // Preserve publication identity and shard membership; never copy weight bytes.
    // Host files can change outside Naidan. Fresh File snapshots deliberately
    // invalidate retained-model identity, even when an old receipt still matches.
    const modelFilesReuseKey = modelLocation({ candidate }).kind === 'opfs' && candidate.files.every(entry => entry.receipt?.source.kind === 'hugging-face') ? JSON.stringify({
      repository: candidate.repositoryKey,
      path: candidate.primaryRelativePath,
      files: candidate.files.map(entry => ({ relativePath: entry.relativePath, size: entry.file.size, modified: entry.file.lastModified, receipt: entry.receipt ?? null })),
    }) : undefined;
    return { slot, ...(modelFilesReuseKey ? { modelFilesReuseKey } : {}), file: file.file, relativePath: candidate.primaryRelativePath, companions: candidate.files.filter(entry => entry.relativePath !== candidate.primaryRelativePath).map(({ relativePath, file }) => ({ relativePath, file })) };
  }
  function benchmarkTargets({ selections: benchmarkSelections }: { selections: Readonly<Record<string, Partial<Record<ModelSlot, string>>>> }): ImageBenchmarkTarget[] {
    return inventory.value.candidates.flatMap(candidate => {
      const slot = primarySlot({ family: candidate.family });
      if (!slot) {
        return [];
      }
      const useSelection = candidate.candidateKey === selectedCandidateKey.value && origin !== 'files';
      const missing: ModelSlot[] = [];
      const members: { slot: ModelSlot, candidate: ModelCandidate }[] = [{ slot, candidate }];
      const components: ImageComponentChoice[] = [];
      const benchmarkOverrides = benchmarkSelections[candidate.candidateKey];
      for (const requirement of componentRequirements({ family: candidate.family })) {
        // Benchmark overrides are independent per primary model. Empty selections
        // are intentional; never silently replace them with an automatic companion.
        const id = benchmarkOverrides?.[requirement.slot] ?? (useSelection ? componentCandidateKeys.value[requirement.slot] : requirement.required ? defaultCompanion({ main: candidate, candidates: inventory.value.candidates, requirement }) : undefined);
        components.push({
          slot: requirement.slot,
          selectedCandidateKey: id ?? '',
          required: requirement.required,
          choices: inventory.value.candidates.filter(item => item.candidateKey !== candidate.candidateKey && (item.roles.includes(requirement.slot) || item.candidateKey === id || componentMatch({ candidate: item, requirement }) !== 'incompatible'))
            .map(item => describe({ candidate: item, status: componentMatch({ candidate: item, requirement }) }))
            .sort((a, b) => a.detail.localeCompare(b.detail)),
        });
        const component = inventory.value.candidates.find(item => item.candidateKey === id);
        if (component && componentMatch({ candidate: component, requirement }) !== 'incompatible') {
          members.push({ slot: requirement.slot, candidate: component });
        } else if (requirement.required || id || useSelection && benchmarkOverrides?.[requirement.slot] === undefined
          && !overrides.has(requirement.slot) && recipeIntent?.files.some(file => file.role === requirement.slot)) {
          missing.push(requirement.slot);
        }
      }
      const issue = candidate.issue ?? (members.some(item => !item.candidate.files.some(file => file.relativePath === item.candidate.primaryRelativePath)) ? 'Missing local file' : undefined);
      return [{
        candidateKey: candidate.candidateKey,
        label: candidate.primaryRelativePath.split('/').at(-1) ?? candidate.primaryRelativePath,
        detail: `${candidate.repositoryKey}/${candidate.primaryRelativePath}`,
        facts: { family: candidate.family, variant: candidate.variant, evidence: [...candidate.evidence] },
        composition: useSelection || benchmarkOverrides ? 'selected' as const : 'automatic' as const,
        components,
        missing,
        issue,
        models: !issue && missing.length === 0 ? members.map(item => modelForCandidate(item)) : undefined,
      }];
    }).sort((a, b) => a.candidateKey < b.candidateKey ? -1 : a.candidateKey > b.candidateKey ? 1 : 0);
  }

  function cancelImport(): void {
    activeImport.value?.abort();
  }
  function useManualFiles(): void {
    selectionVersion++;
    unavailableLoras = [];
    recipeIntent = undefined;
    origin = 'files';
    selectedCandidateKey.value = '';
    componentCandidateKeys.value = {};
    overrides.clear();
  }
  const pendingTemporaryRoots = new Set<string>();
  let refreshingTemporary = false;
  async function refreshTemporaryRoots(): Promise<void> {
    if (disposed || activeImport.value || refreshingTemporary || pendingTemporaryRoots.size === 0) {
      return;
    }
    refreshingTemporary = true;
    try {
      while (!disposed && !activeImport.value && pendingTemporaryRoots.size) {
        const repositoryKeys = inventoryReady ? [...pendingTemporaryRoots] : undefined;
        pendingTemporaryRoots.clear();
        cancelScan();
        await refreshInventory({ completingImport: undefined, preserveSelection: true, repositoryKeys });
      }
    } finally {
      refreshingTemporary = false;
    }
  }
  const unsubscribeTemporary = temporaryModelFiles.subscribe({
    listener: ({ rootPath }) => {
      // A removed/replaced root must stop resolving immediately, not after a slow
      // Worker scan. Keep selection IDs untouched so re-registration can resolve them.
      inventory.value = {
        candidates: inventory.value.candidates.filter(candidate => candidate.repositoryKey !== rootPath),
        issues: inventory.value.issues.filter(issue => issue.repositoryKey !== rootPath),
      };
      inspectedMissingFiles.clear();
      pendingTemporaryRoots.add(rootPath);
      cancelScan();
      queueMicrotask(() => {
        void refreshTemporaryRoots();
      });
    },
  });
  watch(importing, value => {
    if (!value) {
      void refreshTemporaryRoots();
    }
  });
  onScopeDispose(() => {
    disposed = true;
    unsubscribeTemporary();
    unsubscribeDownloads();
    cancelScan();
    activeImport.value?.abort();
    hostPublication?.abort();
    // Download tasks belong to the shared manager, including queued work.
    // Closing this view cancels only its reads and rendering, never file writes.
  });
  return {
    captureModelSelection,
    restoreModelSelection,
    downloadsDisabled,
    downloadQueue,
    retryQueuedDownload,
    removeQueuedDownload,
    hostDirectories,
    benchmarkTargets,
    selectedFacts,
    models,
    savedLoras,
    selectedCandidateKey,
    components,
    scanState,
    scanProgress,
    cancelScan,
    showAll,
    importProgress,
    importing,
    failure,
    issues,
    ready,
    refresh,
    refreshAccess,
    downloading,
    downloadProgress,
    downloadState,
    downloadRecipeId,
    downloadLoraId,
    downloadLora,
    loraAvailable,
    downloadRecipe,
    chooseRecipe,
    cancelDownload,
    resumeDownload,
    resetDownloadIntent,
    downloadSelections,
    recipeAvailability,
    chooseMain,
    chooseComponent,
    importDirectory,
    importFiles,
    dropDirectory,
    cancelImport,
    useManualFiles,
    selectedModels,
    historyFileLocation,
    findHistoryFile,
    prepareHistoryFiles,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
