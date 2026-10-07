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
import { type scanImageRepositories, componentRequirements, componentMatch, defaultCompanion, type ModelInventory, type ModelCandidate } from './logic/model-candidates';
import { imageDirectoryFromFiles, imageDirectoriesFromDrop } from './logic/repository-input';
import type { ModelSlot, Request } from './types';
import type { ImageBenchmarkTarget, ImageComponentChoice, ImageLibraryView, ImageModelChoice, ImageRecipeAvailability, SavedImageLoraChoice } from './library-view';
import { useHostModelDirectories } from './composables/use-host-model-directories';
import { createDisabledImageLibrary } from './library-standalone';
import { OPFS_MODELS_DIR } from '@/constants';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import type { ImageGenerationModelFile } from '@/01-models/image-generation-history';
import type { BrowserImageModelLocation, BrowserImageModelSelection } from '@/01-models/types';
import type { ImageLoraSelection } from './lora-form';

type Dependencies = { list: typeof listImageRepositories, scan: typeof scanImageRepositories, import: typeof importImageRepository, download: ImageRecipeDownloader };
type InventoryRefreshResult = 'scanned' | 'blocked' | 'failed';
const defaultDependencies: Pick<Dependencies, 'import' | 'download'> = { import: importImageRepository, download: downloadImageRecipeInWorker };

function primarySlot({ family }: { family: ModelCandidate['family'] }): ModelSlot | undefined {
  switch (family) {
  case 'sd-checkpoint': return 'model';
  case 'z-image': case 'qwen-image-2.1': case 'flux1': case 'flux2-klein-4b': case 'anima': case 'krea2': case 'ernie-image': return 'diffusion';
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

/** Application-owned local inventory and composition. File metadata is advisory:
 * a structural match is not a claim of identical training weights or quality. */
export function useImageLibrary({ blocked, downloadsBlocked, onSelection, dependencies }: {
  blocked: () => boolean,
  downloadsBlocked: () => boolean,
  onSelection: ({ family, turbo }: { family: ModelCandidate['family'], turbo: boolean }) => void,
  dependencies: Dependencies | undefined,
}): ImageLibraryView {
  const deps = dependencies ?? defaultDependencies;
  const inventory = shallowRef<ModelInventory>({ candidates: [], issues: [] });
  let inventoryReady = false;
  const inspectedMissingFiles = new Set<string>();
  const main = ref('');
  // Track only Files issued by the inspected local inventory. A later scan
  // creates fresh File objects without changing a selected adapter's origin.
  const knownLocations = new WeakMap<File, BrowserImageModelLocation>();
  const showAll = ref(false);
  const selections = shallowRef<Partial<Record<ModelSlot, string>>>({});
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
    authorization: Promise<{ destination: ImageDownloadDestination | undefined, error: unknown }>,
    state: 'queued' | 'downloading' | 'paused' | 'failed' | 'incomplete' | 'complete', error: string,
    completion: ReturnType<typeof Promise.withResolvers<void>>, selectionVersion: number, selectWhenComplete: boolean,
  };
  const jobs = shallowRef<DownloadJob[]>([]);
  const downloadQueue = computed(() => jobs.value.flatMap(job => {
    switch (job.state) {
    case 'complete': return [];
    case 'queued': case 'downloading': case 'paused': case 'failed': case 'incomplete':
      return [{ id: job.id, label: job.label, destination: job.destinationName, state: job.state, error: job.error }];
    default: { const exhaustive: never = job.state; throw new Error(String(exhaustive)); }
    }
  }));
  let currentJob: DownloadJob | undefined, processing = false, queuePaused = false, jobSequence = 0, selectionVersion = 0;
  function publishJobs(): void {
    jobs.value = [...jobs.value];
  }
  // An independent editor operation must not have its settings replaced when
  // a previously requested download finishes later.
  watch(blocked, value => {
    if (value) selectionVersion++;
  }, { flush: 'sync' });
  const downloadPresentation = computed(() => {
    const target = downloadTarget.value;
    switch (target?.kind) {
    case 'recipe': return { recipeId: target.id, loraId: '', selections: target.selections };
    case 'lora': return { recipeId: '', loraId: target.id, selections: {} };
    case undefined: return { recipeId: '', loraId: '', selections: {} };
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  });
  const downloadRecipeId = computed(() => downloadPresentation.value.recipeId);
  const downloadLoraId = computed(() => downloadPresentation.value.loraId);
  const downloadSelections = computed<ImageRecipeSelection>(() => downloadPresentation.value.selections);
  let recipeIntent: { family: 'z-image' | 'qwen-image-2.1' | 'sd-checkpoint' | 'flux2-klein-4b' | 'anima' | 'krea2' | 'ernie-image', files: ImageRecipeFile[], destinationId: string } | undefined;
  const downloading = computed(() => activeDownload.value !== undefined);
  let hostPublication: AbortController | undefined;
  const host = dependencies ? undefined : useHostModelDirectories({
    blocked: () => blocked() || importing.value,
    async stopDownload({ id }) {
      if (downloadCompletion?.directoryId !== id) return;
      const completed = downloadCompletion.promise;
      activeDownload.value?.abort();
      await completed;
    },
    async changed() {
      hostPublication?.abort(); cancelScan();
      const controller = new AbortController(); hostPublication = controller;
      try {
        await refreshAfterMutation({ signal: controller.signal, completingImport: undefined, repositoryIds: undefined });
      } finally {
        if (hostPublication === controller) hostPublication = undefined;
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
      if (!downloading.value) await hostView.add();
    },
    async reconnect({ id }) {
      if (!downloading.value) await hostView.reconnect({ id });
    },
    selectDestination({ id }) {
      if (importing.value || downloadsBlocked()) return;
      hostView.selectDestination({ id });
    },
  };
  let activeScan: { controller: AbortController, promise: Promise<InventoryRefreshResult> } | undefined;
  let preparingHistoryFiles = false;
  let origin: 'automatic' | 'manual' | 'files' = 'automatic';
  let disposed = false;
  const importing = computed(() => activeImport.value !== undefined);
  const downloadsDisabled = computed(() => downloadsBlocked());
  if (host) watch(() => hostDirectories.entries.value.map(entry => entry.id), (ids, previousIds) => {
    if (hostView.destination.value !== 'opfs' && previousIds.includes(hostView.destination.value) && !ids.includes(hostView.destination.value)) hostView.destination.value = 'opfs';
    // Only a committed unlink removes queued work. Failed settings writes keep
    // the original root and its paused/retryable transfer intact.
    for (const job of [...jobs.value]) if (job.destinationId !== 'opfs' && !ids.includes(job.destinationId)) removeQueuedDownload({ id: job.id });
  }, { flush: 'sync' });
  watch([hostDirectories.busy, downloadsDisabled, importing], () => {
    void processDownloads();
  });
  const selected = computed(() => inventory.value.candidates.find(item => item.id === main.value));
  const selectedFacts = computed(() => selected.value && !selected.value.issue ? { family: selected.value.family, variant: selected.value.variant, evidence: selected.value.evidence } : undefined);
  const requirements = computed(() => componentRequirements({ family: selected.value?.family ?? 'unknown' }));
  function describe({ candidate, status }: { candidate: ModelCandidate, status: ImageModelChoice['status'] }): ImageModelChoice {
    return {
      id: candidate.id,
      label: candidate.path.split('/').at(-1) ?? candidate.path,
      detail: `${candidate.hostSource ? `${candidate.hostSource.directoryName}/${candidate.hostSource.repository}` : candidate.repositoryId}/${candidate.path} · ${candidate.format} · ${(candidate.size / 1024 ** 3).toFixed(2)} GiB`,
      evidence: candidate.evidence,
      status: candidate.issue ? 'incompatible' : status,
      issue: candidate.issue,
    };
  }
  const models = computed(() => inventory.value.candidates.filter(candidate => {
    if (candidate.classes.includes('lora')) return false;
    if (candidate.id === main.value || showAll.value) return true;
    return candidate.family !== 'unknown' && candidate.roles.some(role => role === 'model' || role === 'diffusion');
  }).map(candidate => describe({ candidate, status: primarySlot({ family: candidate.family }) !== undefined ? 'matching' : candidate.roles.length ? 'incompatible' : 'unverified' })));
  const savedLoras = computed<SavedImageLoraChoice[]>(() => inventory.value.candidates.flatMap(candidate => {
    const entry = candidate.files[0];
    // Native LoRA requests mount one original file, not a shard/index bundle.
    if (candidate.issue || !candidate.classes.includes('lora') || candidate.files.length !== 1 || !entry || !/\.(gguf|safetensors)$/i.test(entry.path)) return [];
    const source = candidate.hostSource;
    return [{
      id: candidate.id,
      label: entry.file.name,
      path: entry.path,
      file: entry.file,
      detail: source ? `Host: ${source.directoryName}/${source.repository}/${entry.path}` : `OPFS: ${candidate.repositoryId}/${entry.path}`,
    }];
  }).sort((a, b) => a.detail.localeCompare(b.detail) || a.id.localeCompare(b.id)));
  const components = computed(() => requirements.value.map(requirement => ({
    slot: requirement.slot,
    selected: selections.value[requirement.slot] ?? '',
    required: requirement.required,
    choices: inventory.value.candidates.filter(candidate => candidate.id !== main.value && !candidate.classes.includes('lora')).map(candidate => describe({ candidate, status: componentMatch({ candidate, requirement }) }))
      .filter(choice => showAll.value || choice.status === 'matching' || choice.id === selections.value[requirement.slot])
      .sort((a, b) => Number(b.status === 'matching') - Number(a.status === 'matching') || a.detail.localeCompare(b.detail)),
  })));
  const issues = computed(() => inventory.value.issues.map(issue => `${issue.repositoryId}/${issue.path}: ${issue.message}`));
  const ready = computed(() => {
    if (!selected.value || selected.value.issue || scanState.value === 'scanning' || importing.value || origin === 'files') return false;
    // Unknown model families remain inspectable in Advanced. Their execution is
    // deliberate via the manual component controls, not a guessed checkpoint.
    if (primarySlot({ family: selected.value.family }) === undefined) return false;
    return requirements.value.every(requirement => {
      const id = selections.value[requirement.slot];
      if (!requirement.required && !id) return overrides.has(requirement.slot) || !recipeIntent?.files.some(file => file.role === requirement.slot);
      const candidate = inventory.value.candidates.find(item => item.id === id);
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
        // Losing an explicit optional override must not silently select the
        // checkpoint's built-in component. Retain the unavailable selection.
        if (!previous && requirement.required) next[requirement.slot] = '';
        continue;
      }
      if (!recipeIntent && previous && componentMatch({ candidate: previous, requirement }) === 'matching') continue;
      const requested = recipeIntent?.files.find(file => file.role === requirement.slot);
      // A complete checkpoint already contains its VAE. Use an external one only
      // when the user selects it or explicitly chooses a recipe that names it.
      next[requirement.slot] = requested ? findRecipeFile({ file: requested, destinationId: recipeIntent!.destinationId, match: ({ candidate }) => componentMatch({ candidate, requirement }) === 'matching' })?.id ?? ''
        : requirement.required ? defaultCompanion({ main: selected.value, candidates: inventory.value.candidates, requirement }) ?? '' : '';
    }
    selections.value = next;
  }
  function chooseMain({ id }: { id: string }): void {
    if (blocked() || importing.value || scanState.value === 'scanning' || disposed) return;
    const candidate = inventory.value.candidates.find(item => item.id === id);
    if (id && !candidate || candidate?.issue || candidate && candidate.family === 'unknown' && candidate.roles.length) return;
    selectionVersion++; unavailableLoras = []; recipeIntent = undefined;
    if (id === main.value) return;
    main.value = id; origin = 'manual'; overrides.clear(); selections.value = {}; resolve();
    if (candidate) onSelection({ family: candidate.family, turbo: candidate.turboHint });
  }
  function chooseComponent({ slot, id }: { slot: ModelSlot, id: string }): void {
    if (blocked() || importing.value || scanState.value === 'scanning' || disposed) return;
    const requirement = requirements.value.find(item => item.slot === slot);
    const candidate = inventory.value.candidates.find(item => item.id === id);
    if (!requirement || candidate && componentMatch({ candidate, requirement }) === 'incompatible' || id && !candidate) return;
    selectionVersion++; overrides.add(slot); selections.value = { ...selections.value, [slot]: id };
  }
  function findRecipeFile({ file, match, destinationId }: { file: ImageRecipeFile, destinationId: string, match: ({ candidate }: { candidate: ModelCandidate }) => boolean }): ModelCandidate | undefined {
    const target = `huggingface.co/${file.repository}/resolve/main`;
    const matches = inventory.value.candidates.filter(candidate => {
      if (candidate.issue || candidate.path !== file.path || !match({ candidate })) return false;
      // Catalog availability belongs to the explicitly selected destination.
      // A copy in another root must not suppress Download for this root.
      if (destinationId === 'opfs' ? candidate.hostSource !== undefined
        : candidate.hostSource?.directoryId !== destinationId) return false;
      if (candidate.hostSource) {
        if (candidate.hostSource.repository !== file.repository) return false;
      } else if (!candidate.repositoryId.startsWith('user/') && candidate.repositoryId !== target && candidate.repositoryId !== `huggingface.co/${file.repository}/resolve/${file.revision}`) return false;
      const receipt = candidate.files.find(entry => entry.path === file.path)?.receipt;
      if (receipt?.source.kind === 'hugging-face' && receipt.source.revision !== file.revision) return false;
      return true;
    });
    const preferred = ({ candidate }: { candidate: ModelCandidate }) => destinationId === 'opfs'
      ? candidate.repositoryId === target : candidate.hostSource?.directoryId === destinationId;
    matches.sort((a, b) => Number(preferred({ candidate: b })) - Number(preferred({ candidate: a })) || a.id.localeCompare(b.id));
    return matches[0];
  }
  function recipeAvailability({ recipeId, selections }: { recipeId: string, selections: ImageRecipeSelection }): ImageRecipeAvailability {
    return recipeAvailabilityAt({ recipeId, selections, destinationId: hostDirectories.destination.value });
  }
  function recipeAvailabilityAt({ recipeId, selections: requested, destinationId }: { recipeId: string, selections: ImageRecipeSelection, destinationId: string }): ImageRecipeAvailability {
    const recipe = imageModelRecipes.find(item => item.id === recipeId);
    if (!recipe) return { available: 0, total: 0, selected: false, bytes: 0 };
    const family = (() => {
      switch (recipe.id) {
      case 'z-image-turbo': case 'z-image-base': return 'z-image' as const;
      case 'qwen-image-2.1': return 'qwen-image-2.1' as const;
      case 'sdxl-base-1.0': return 'sd-checkpoint' as const;
      case 'flux2-klein-4b': return 'flux2-klein-4b' as const;
      case 'anima-turbo-1.1': return 'anima' as const;
      case 'krea2-turbo': return 'krea2' as const;
      case 'ernie-image-turbo': return 'ernie-image' as const;
      default: { const exhaustive: never = recipe.id; throw new Error(String(exhaustive)); }
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
        default: { const exhaustive: never = file.role; throw new Error(String(exhaustive)); }
        }
      },
    }));
    return {
      available: candidates.filter(candidate => candidate !== undefined).length,
      total: files.length,
      selected: candidates.every((candidate, index) => {
        if (!candidate) return false;
        const role = files[index]!.role;
        switch (role) {
        case 'model': case 'diffusion': return candidate.id === main.value;
        case 'vae': case 'lm': return candidate.id === selections.value[role];
        default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
        }
      }),
      bytes: candidates.reduce((sum, candidate) => sum + (candidate?.size ?? 0), 0),
    };
  }
  function resolveRecipe(): void {
    if (!recipeIntent) return;
    const file = recipeIntent.files.find(file => file.role === 'model' || file.role === 'diffusion');
    const candidate = file && findRecipeFile({ file, destinationId: recipeIntent.destinationId, match: ({ candidate: item }) => item.family === recipeIntent?.family });
    if (candidate && candidate.id !== main.value) {
      main.value = candidate.id; onSelection({ family: candidate.family, turbo: candidate.turboHint });
    }
  }
  function loraAvailable({ id }: { id: string }): boolean {
    return loraAvailableAt({ id, destinationId: hostDirectories.destination.value });
  }
  function loraAvailableAt({ id, destinationId }: { id: string, destinationId: string }): boolean {
    const entry = imageCatalogLoras.find(item => item.id === id);
    if (!entry) return false;
    const expected = entry.source;
    return inventory.value.candidates.some(candidate => {
      if (candidate.issue || !candidate.classes.includes('lora') || candidate.files.length !== 1 || candidate.path !== expected.path) return false;
      if (destinationId === 'opfs' ? candidate.hostSource !== undefined
        : candidate.hostSource?.directoryId !== destinationId) return false;
      const receipt = candidate.files[0]?.receipt, source = receipt?.source;
      // A selectable, markerless host adapter is not proof this catalog artifact
      // was acquired. Completion requires the exact published source and bytes.
      return source?.kind === 'hugging-face' && source.repository === expected.repository && source.revision === expected.revision && source.path === expected.path
        && receipt?.size === expected.size && source.sha256 === expected.sha256;
    });
  }
  function chooseRecipe({ recipeId, selections: requested }: { recipeId: string, selections: ImageRecipeSelection }): void {
    if (blocked() || importing.value || scanState.value === 'scanning' || disposed) return;
    const recipe = imageModelRecipes.find(recipe => recipe.id === recipeId); if (!recipe) return;
    const files = selectedRecipeFiles({ recipe, selections: requested });
    const destinationId = hostDirectories.destination.value; selectionVersion++; unavailableLoras = [];
    switch (recipe.id) {
    case 'z-image-turbo': case 'z-image-base': recipeIntent = { family: 'z-image', files, destinationId }; break;
    case 'qwen-image-2.1': recipeIntent = { family: 'qwen-image-2.1', files, destinationId }; break;
    case 'sdxl-base-1.0': recipeIntent = { family: 'sd-checkpoint', files, destinationId }; break;
    case 'flux2-klein-4b': recipeIntent = { family: 'flux2-klein-4b', files, destinationId }; break;
    case 'anima-turbo-1.1': recipeIntent = { family: 'anima', files, destinationId }; break;
    case 'krea2-turbo': recipeIntent = { family: 'krea2', files, destinationId }; break;
    case 'ernie-image-turbo': recipeIntent = { family: 'ernie-image', files, destinationId }; break;
    default: { const exhaustive: never = recipe.id; throw new Error(String(exhaustive)); }
    }
    origin = 'manual'; main.value = ''; selections.value = {}; overrides.clear();
    resolveRecipe(); resolve();
  }
  async function downloadRecipe({ recipeId, selections: requested }: { recipeId: string, selections: ImageRecipeSelection }): Promise<void> {
    if (downloadsBlocked() || importing.value || disposed) return;
    const recipe = imageModelRecipes.find(recipe => recipe.id === recipeId); if (!recipe) return;
    const choices = { ...requested }, files = selectedRecipeFiles({ recipe, selections: choices });
    await enqueueDownload({ target: { kind: 'recipe', id: recipeId, selections: choices }, files, label: recipe.title });
  }
  async function downloadLora({ id }: { id: string }): Promise<void> {
    if (downloadsBlocked() || importing.value || disposed) return;
    const entry = imageCatalogLoras.find(entry => entry.id === id); if (!entry) return;
    await enqueueDownload({ target: { kind: 'lora', id }, files: [entry.source], label: entry.title });
  }
  function authorizeDownload({ destinationId }: { destinationId: string }): DownloadJob['authorization'] {
    // Request host permission in the explicit click, not when the FIFO eventually
    // reaches this entry. The destination is immutable even if the select changes.
    const permission = host ? host.downloadDestination({ id: destinationId }) : Promise.resolve<ImageDownloadDestination>({ kind: 'opfs' });
    return permission.then(destination => ({ destination, error: undefined }), error => ({ destination: undefined, error }));
  }
  async function enqueueDownload({ target, files, label }: { target: DownloadTarget, files: readonly ImageDownloadSource[], label: string }): Promise<void> {
    const destinationId = hostDirectories.destination.value;
    const key = JSON.stringify([destinationId, files.map(file => [file.repository, file.revision, file.path]).sort()]);
    if (jobs.value.some(job => job.key === key)) return;
    const job: DownloadJob = {
      id: String(++jobSequence),
      key,
      target,
      files: files.map(file => ({ ...file })),
      destinationId,
      destinationName: destinationId === 'opfs' ? 'OPFS' : hostDirectories.entries.value.find(entry => entry.id === destinationId)?.name ?? destinationId,
      label,
      authorization: authorizeDownload({ destinationId }),
      state: 'queued',
      error: '',
      completion: Promise.withResolvers<void>(),
      selectionVersion,
      selectWhenComplete: !main.value && origin !== 'files',
    };
    jobs.value = [...jobs.value, job]; void processDownloads();
    await job.completion.promise;
  }
  async function processDownloads(): Promise<void> {
    if (processing || queuePaused || disposed || downloadsBlocked() || hostDirectories.busy.value || importing.value) return;
    processing = true;
    try {
      while (!queuePaused && !disposed && !downloadsBlocked() && !hostDirectories.busy.value && !importing.value) {
        const job = jobs.value.find(job => job.state === 'queued'); if (!job) break;
        currentJob = job;
        await downloadFiles({ job });
        job.completion.resolve();
        if (!jobs.value.includes(job)) {
          currentJob = undefined; clearDownloadIntent();
        }
        switch (job.state) {
        case 'complete': jobs.value = jobs.value.filter(entry => entry !== job); break;
        case 'queued': case 'downloading': case 'paused': case 'failed': case 'incomplete': break;
        default: { const exhaustive: never = job.state; throw new Error(String(exhaustive)); }
        }
      }
    } finally {
      processing = false;
    }
  }
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
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  }
  async function downloadFiles({ job }: { job: DownloadJob }): Promise<void> {
    const { target, files, destinationId } = job;
    const controller = new AbortController(); activeDownload.value = controller;
    const completion = Promise.withResolvers<void>();
    downloadCompletion = { promise: completion.promise, directoryId: destinationId === 'opfs' ? undefined : destinationId };
    if (!preparingHistoryFiles) cancelScan();
    failure.value = ''; downloadState.value = 'downloading'; downloadTarget.value = target;
    downloadProgress.value = undefined; job.state = 'downloading'; job.error = ''; publishJobs();
    let transferred = false;
    try {
      const authorization = await job.authorization;
      controller.signal.throwIfAborted();
      if (!authorization.destination) throw authorization.error;
      if (host && destinationId !== 'opfs' && !host.registrations().some(entry => entry.id === destinationId)) throw new Error('Linked model directory is unavailable');
      await deps.download({
        files,
        destination: authorization.destination,
        signal: controller.signal,
        onProgress: ({ progress }) => {
          if (!disposed && !controller.signal.aborted) downloadProgress.value = progress;
        },
      });
      controller.signal.throwIfAborted(); transferred = true;
    } catch (error) {
      if (!disposed) {
        downloadState.value = controller.signal.aborted ? 'paused' : 'failed';
        job.state = downloadState.value;
        if (!controller.signal.aborted) job.error = failure.value = error instanceof Error ? error.message : String(error);
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
          const repositoryIds = transferred && inventoryReady && destinationId === 'opfs'
            ? [...new Set(files.map(file => `huggingface.co/${file.repository}/resolve/main`))] : undefined;
          scanned = await refreshInventory({ completingImport: undefined, preserveSelection: true, repositoryIds });
        } finally {
          controller.signal.removeEventListener('abort', abort);
        }
        if (transferred) {
          const available = scanned === 'scanned' && completeDownload({ job });
          job.state = controller.signal.aborted ? 'paused' : available ? 'complete' : 'incomplete';
          downloadState.value = job.state;
        }
        if (!job.error) job.error = failure.value;
        else failure.value = job.error;
      }
      if (controller.signal.aborted && jobs.value.includes(job)) job.state = downloadState.value = 'paused';
      if (activeDownload.value === controller) activeDownload.value = undefined;
      publishJobs(); completion.resolve();
      if (downloadCompletion?.promise === completion.promise) downloadCompletion = undefined;
    }
  }
  function resetDownloadIntent(): void {
    // Pending jobs own their selections independently of the catalog form.
    if (!downloading.value && (!currentJob || !jobs.value.includes(currentJob))) clearDownloadIntent();
  }
  function clearDownloadIntent(): void {
    downloadState.value = 'idle'; downloadTarget.value = undefined; downloadProgress.value = undefined;
  }
  async function retryQueuedDownload({ id }: { id: string }): Promise<void> {
    const job = jobs.value.find(job => job.id === id);
    if (!job || downloadsBlocked() || disposed || importing.value || job.state === 'queued' || job.state === 'downloading') return;
    job.authorization = authorizeDownload({ destinationId: job.destinationId });
    job.state = 'queued'; job.error = ''; job.completion = Promise.withResolvers<void>();
    queuePaused = false; publishJobs(); void processDownloads();
    await job.completion.promise;
  }
  async function resumeDownload(): Promise<void> {
    if (currentJob) await retryQueuedDownload({ id: currentJob.id });
  }
  function removeQueuedDownload({ id }: { id: string }): void {
    const job = jobs.value.find(job => job.id === id); if (!job) return;
    jobs.value = jobs.value.filter(entry => entry !== job); job.completion.resolve();
    if (currentJob === job) {
      queuePaused = false;
      if (activeDownload.value) activeDownload.value.abort();
      else {
        currentJob = undefined; clearDownloadIntent();
      }
    }
    void processDownloads();
  }
  function cancelDownload(): void {
    queuePaused = true; activeDownload.value?.abort();
  }
  async function waitForEditor({ signal }: { signal: AbortSignal }): Promise<void> {
    if (!blocked() || signal.aborted || disposed) return;
    await new Promise<void>(resolve => {
      const finish = () => {
        stop(); signal.removeEventListener('abort', finish); resolve();
      };
      const stop = watch(blocked, value => {
        if (!value) finish();
      }, { flush: 'sync' });
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted || disposed || !blocked()) finish();
    });
  }
  async function refreshAfterMutation({ signal, completingImport, repositoryIds }: { signal: AbortSignal, completingImport: AbortController | undefined, repositoryIds: string[] | undefined }): Promise<boolean> {
    const selectedRepositories = inventoryReady ? repositoryIds : undefined;
    inventoryReady = false; inspectedMissingFiles.clear();
    const abort = () => cancelScan();
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Saving existing images may temporarily own the editor. That is not an
      // incomplete model: keep this preparation active until it can publish safely.
      // Cancellation must also release host unlink/disposal waiters. Completed
      // files stay on disk and the next refresh/resume can inspect them.
      while (!disposed && !signal.aborted) {
        await waitForEditor({ signal });
        if (disposed || signal.aborted) return false;
        const result = await refreshInventory({ completingImport, preserveSelection: false, repositoryIds: selectedRepositories });
        switch (result) {
        case 'scanned': return true;
        case 'failed': return false;
        case 'blocked': break;
        default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
        }
      }
      return false;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async function refresh(): Promise<void> {
    if (downloading.value) return;
    await refreshInventory({ completingImport: undefined, preserveSelection: false });
  }
  async function refreshAccess(): Promise<void> {
    // Focus only updates permission/availability; it is not a model mutation.
    if (disposed || importing.value || hostDirectories.busy.value) return;
    try {
      await host?.refresh();
    } catch (error) {
      if (!disposed) failure.value = error instanceof Error ? error.message : String(error);
    }
  }
  async function prepareHistoryFiles({ requiredFiles }: { requiredFiles: readonly ImageGenerationModelFile[] }): Promise<void> {
    if (disposed || importing.value || preparingHistoryFiles) throw new Error('Local model files are busy');
    const missing = requiredFiles.filter(location => location.type !== 'file' && !findHistoryFile({ location }));
    const missingKey = JSON.stringify(missing);
    if (inventoryReady && !activeScan && (!missing.length || inspectedMissingFiles.has(missingKey))) return;
    // Explicit history reuse owns this read while the editor is disabled. Share
    // an initial scan already in flight, without selecting a different model or
    // applying its presets before the saved request has been resolved.
    preparingHistoryFiles = true;
    try {
      const result = await refreshInventory({ completingImport: undefined, preserveSelection: false });
      switch (result) {
      case 'scanned': inspectedMissingFiles.add(missingKey); break;
      case 'blocked': case 'failed': throw new Error(failure.value || 'Local model files could not be inspected');
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
    } finally {
      preparingHistoryFiles = false;
    }
  }
  function cancelScan(): void {
    const previous = activeScan; activeScan = undefined;
    previous?.controller.abort(); scanState.value = 'idle'; scanProgress.value = undefined;
  }
  function refreshInventory({ completingImport, preserveSelection, repositoryIds }: { completingImport: AbortController | undefined, preserveSelection: boolean, repositoryIds?: string[] }): Promise<InventoryRefreshResult> {
    if (disposed || activeImport.value !== completingImport) return Promise.resolve('failed');
    if (blocked() && !preparingHistoryFiles && !preserveSelection) return Promise.resolve('blocked');
    // Repeated window focus/refresh must not cancel and restart a large scan.
    if (activeScan) return activeScan.promise;
    const scan = new AbortController();
    const operation: { controller: AbortController, promise: Promise<InventoryRefreshResult> } = { controller: scan, promise: Promise.resolve('failed') };
    activeScan = operation; scanState.value = 'scanning'; failure.value = '';
    scanProgress.value = { phase: 'listing', completed: 0, total: 0, path: '' };
    operation.promise = (async () => {
      try {
        if (host) await awaitInspection({ task: host.refresh(), signal: scan.signal });
        const onProgress = ({ progress }: { progress: InspectionProgress }) => {
          if (activeScan === operation && !scan.signal.aborted) scanProgress.value = progress;
        };
        // Dependency injection remains read-only and abort-raced for regression tests.
        const next = await awaitInspection({
          signal: scan.signal,
          task: dependencies ? (async () => {
            const repositories = await awaitInspection({ task: dependencies.list({ signal: scan.signal, onProgress, repositoryIds }), signal: scan.signal });
            scan.signal.throwIfAborted();
            return dependencies.scan({ repositories: repositoryIds ? repositories.filter(repository => repositoryIds.includes(repository.id)) : repositories, signal: scan.signal, onProgress });
          })() : inspectImageInventory({ signal: scan.signal, onProgress, hostDirectories: host?.registrations(), repositoryIds }),
        });
        if (disposed || scan.signal.aborted || activeScan !== operation || activeImport.value !== completingImport) return 'failed';
        if (blocked() && !preparingHistoryFiles && !preserveSelection) return 'blocked';
        // A targeted scan is not evidence that other repositories disappeared.
        // Preserve their exact original File objects, not metadata lookalikes.
        const published = repositoryIds ? {
          candidates: [...inventory.value.candidates.filter(candidate => !repositoryIds.includes(candidate.repositoryId)), ...next.candidates],
          issues: [...inventory.value.issues.filter(issue => !repositoryIds.includes(issue.repositoryId)), ...next.issues],
        } : next;
        inventory.value = published;
        inventoryReady = true; inspectedMissingFiles.clear();
        for (const candidate of published.candidates) {
          const file = candidate.files.find(entry => entry.path === candidate.path)?.file;
          if (file && !candidate.issue) knownLocations.set(file, modelLocation({ candidate }));
        }
        if (preparingHistoryFiles) return 'scanned';
        if (preserveSelection) {
          // Complete missing companions for an already chosen model, without
          // choosing a new primary or applying its generation presets.
          if (!blocked()) resolve();
          return 'scanned';
        }
        if (!published.candidates.some(candidate => candidate.id === main.value)) {
          main.value = ''; selections.value = {}; overrides.clear();
          if (automaticOrigin({ origin })) {
            const candidates = published.candidates.filter(candidate => candidate.family !== 'unknown' && !candidate.issue);
            candidates.sort((a, b) => a.size - b.size || a.id.localeCompare(b.id));
            const first = candidates[0];
            if (first) {
              main.value = first.id; onSelection({ family: first.family, turbo: first.turboHint });
            }
          }
        }
        resolveRecipe(); resolve(); return 'scanned';
      } catch (error) {
        if (!disposed && activeScan === operation && !scan.signal.aborted) failure.value = error instanceof Error ? error.message : String(error);
        return 'failed';
      } finally {
        if (activeScan === operation) {
          activeScan = undefined; scanState.value = 'idle'; scanProgress.value = undefined;
        }
      }
    })();
    return operation.promise;
  }
  async function importInputs({ collect }: { collect: ({ signal }: { signal: AbortSignal }) => Promise<Parameters<typeof importImageRepository>[0]['input'][]> }): Promise<void> {
    if (blocked() || importing.value || downloading.value || disposed) return;
    const controller = new AbortController(); activeImport.value = controller;
    cancelScan(); failure.value = ''; importProgress.value = { completed: 0, total: 0 };
    const publishedRepositories: string[] = [];
    try {
      // collect is invoked during drop dispatch, before awaiting entry traversal.
      const directories = await collect({ signal: controller.signal }); controller.signal.throwIfAborted();
      for (const input of directories) {
        controller.signal.throwIfAborted();
        const repositoryId = await deps.import({
          input,
          signal: controller.signal,
          onProgress: ({ progress }) => {
            if (!disposed) importProgress.value = progress;
          },
        });
        publishedRepositories.push(repositoryId);
      }
    } catch (error) {
      if (!disposed && !controller.signal.aborted) failure.value = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        if (!disposed && publishedRepositories.length) {
          // Keep this import's ownership through publication; waiting for another
          // save must not admit a second import or lose the completed files.
          const importFailure = failure.value;
          await refreshAfterMutation({ signal: controller.signal, completingImport: controller, repositoryIds: publishedRepositories.every(id => typeof id === 'string' && id.length > 0) ? publishedRepositories : undefined });
          if (!disposed && activeImport.value === controller && importFailure) failure.value = [importFailure, failure.value].filter(Boolean).join('\n');
        }
      } finally {
        if (activeImport.value === controller) {
          activeImport.value = undefined; importProgress.value = undefined;
        }
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
    const selectionsToUse = [{ slot, candidate: selected.value }, ...requirements.value.flatMap(({ slot }) => {
      const candidate = inventory.value.candidates.find(item => item.id === selections.value[slot]);
      return candidate ? [{ slot, candidate }] : [];
    })];
    return selectionsToUse.map(({ slot, candidate }) => modelForCandidate({ slot, candidate }));
  }
  function historyFileLocation({ file }: { file: File }): ImageGenerationModelFile {
    const metadata = { name: file.name, size: file.size, lastModified: file.lastModified };
    for (const candidate of inventory.value.candidates) {
      const entry = candidate.files.find(entry => entry.file === file);
      if (!entry) continue;
      if (candidate.hostSource) return { ...metadata, type: 'host', directoryId: toHostModelDirectoryId({ raw: candidate.hostSource.directoryId }), path: `${candidate.hostSource.repository}/${entry.path}` };
      return { ...metadata, type: 'opfs', path: `${OPFS_MODELS_DIR}/${candidate.repositoryId}/${entry.path}` };
    }
    return { ...metadata, type: 'file' };
  }
  function findHistoryFile({ location }: { location: ImageGenerationModelFile }): File | undefined {
    // Only the already inspected local inventory is consulted. A same-named
    // file or a remote repository is never substituted for a missing source.
    // This is a location/metadata check, not content identity: an external
    // replacement retaining the same size and modification time is undetectable.
    for (const candidate of inventory.value.candidates) {
      if (candidate.issue) continue;
      for (const entry of candidate.files) {
        const file = entry.file;
        if (file.name !== location.name || file.size !== location.size || file.lastModified !== location.lastModified) continue;
        switch (location.type) {
        case 'file': return undefined;
        case 'opfs':
          if (!candidate.hostSource && `${OPFS_MODELS_DIR}/${candidate.repositoryId}/${entry.path}` === location.path) return file;
          break;
        case 'host':
          if (candidate.hostSource?.directoryId === idToRaw({ id: location.directoryId }) && `${candidate.hostSource.repository}/${entry.path}` === location.path) return file;
          break;
        default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
        }
      }
    }
    return undefined;
  }
  function modelLocation({ candidate }: { candidate: ModelCandidate }): BrowserImageModelLocation {
    if (candidate.hostSource) return { kind: 'host', directoryId: toHostModelDirectoryId({ raw: candidate.hostSource.directoryId }), path: `${candidate.hostSource.repository}/${candidate.path}` };
    return { kind: 'opfs', path: `${OPFS_MODELS_DIR}/${candidate.repositoryId}/${candidate.path}` };
  }
  function candidateAt({ location }: { location: BrowserImageModelLocation }): ModelCandidate | undefined {
    return inventory.value.candidates.find(candidate => {
      if (candidate.issue) return false;
      const actual = modelLocation({ candidate });
      switch (location.kind) {
      case 'opfs': return actual.kind === 'opfs' && actual.path === location.path;
      case 'host': return actual.kind === 'host' && actual.directoryId === location.directoryId && actual.path === location.path;
      default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
      }
    });
  }
  let unavailableLoras: { index: number, selection: BrowserImageModelSelection['loras'][number] }[] = [];
  function restoreModelSelection({ selection }: { selection: BrowserImageModelSelection }) {
    // Restoration only consults the inspected local inventory. It neither asks
    // for host permission nor substitutes a same-named file from another root.
    const { primary, components: savedComponents, loras, ...unhandled } = selection;
    unhandled satisfies Record<PropertyKey, never>;
    const candidate = candidateAt({ location: primary.location });
    const missing: string[] = [], missingInactive: string[] = [];
    origin = 'manual'; recipeIntent = undefined; overrides.clear(); selections.value = {};
    main.value = candidate && primarySlot({ family: candidate.family }) === primary.slot ? candidate.id : `unavailable:${JSON.stringify(primary.location)}`;
    if (main.value !== candidate?.id) missing.push(primary.location.path);
    for (const { slot, choice } of savedComponents) {
      overrides.add(slot);
      const requirement = requirements.value.find(item => item.slot === slot);
      switch (choice.kind) {
      case 'none': selections.value = { ...selections.value, [slot]: '' }; break;
      case 'file': {
        const component = candidateAt({ location: choice.location });
        const usable = component && requirement && componentMatch({ candidate: component, requirement }) !== 'incompatible';
        selections.value = { ...selections.value, [slot]: usable ? component.id : `unavailable:${JSON.stringify(choice.location)}` };
        if (!usable) missing.push(choice.location.path);
        break;
      }
      default: { const exhaustive: never = choice; throw new Error(String(exhaustive)); }
      }
    }
    resolve();
    unavailableLoras = [];
    const restoredLoras: ImageLoraSelection[] = [];
    loras.forEach((selection, index) => {
      const { location, enabled, strength, ...unhandled } = selection;
      unhandled satisfies Record<PropertyKey, never>;
      const candidate = candidateAt({ location });
      const file = candidate?.files.find(entry => entry.path === candidate.path)?.file;
      if (!file) {
        unavailableLoras.push({ index, selection });
        switch (enabled) {
        case 'enabled': missing.push(location.path); break;
        case 'disabled': missingInactive.push(location.path); break;
        default: { const exhaustive: never = enabled; throw new Error(String(exhaustive)); }
        }
      } else restoredLoras.push({ file, path: candidate!.path, sourceLabel: location.path, enabled: enabled === 'enabled', strength });
    });
    return { loras: restoredLoras, missing, missingInactive };
  }
  function captureModelSelection({ loras }: { loras: readonly ImageLoraSelection[] }): BrowserImageModelSelection | undefined {
    if (origin === 'files' || !selected.value) return undefined;
    const slot = primarySlot({ family: selected.value.family });
    if (slot !== 'model' && slot !== 'diffusion') return undefined;
    const savedComponents: BrowserImageModelSelection['components'] = [];
    for (const requirement of requirements.value) {
      // Omitted components remain automatic. A catalog recipe explicitly names
      // its component files, just as an individual picker override does.
      if (!overrides.has(requirement.slot) && !recipeIntent?.files.some(file => file.role === requirement.slot)) continue;
      const id = selections.value[requirement.slot];
      const candidate = inventory.value.candidates.find(item => item.id === id);
      if (!candidate && id) return undefined;
      const slot = requirement.slot;
      if (slot === 'model' || slot === 'diffusion') continue;
      savedComponents.push({ slot, choice: candidate ? { kind: 'file', location: modelLocation({ candidate }) } : { kind: 'none' } });
    }
    const savedLoras: BrowserImageModelSelection['loras'] = [];
    for (const lora of loras) {
      const location = knownLocations.get(lora.file);
      // A temporary File must not erase a previous restorable model selection.
      if (!location || !Number.isFinite(lora.strength) || lora.strength < -10 || lora.strength > 10) return undefined;
      savedLoras.push({ location, enabled: lora.enabled ? 'enabled' : 'disabled', strength: lora.strength });
    }
    for (const pending of unavailableLoras) savedLoras.splice(Math.min(pending.index, savedLoras.length), 0, pending.selection);
    if (savedLoras.length > 16) return undefined;
    return { primary: { slot, location: modelLocation({ candidate: selected.value }) }, components: savedComponents, loras: savedLoras };
  }
  function modelForCandidate({ slot, candidate }: { slot: ModelSlot, candidate: ModelCandidate }): Request['models'][number] {
    const file = candidate.files.find(entry => entry.path === candidate.path);
    if (!file) throw new Error('Selected model file disappeared from the inventory');
    // Preserve publication identity and shard membership; never copy weight bytes.
    // Host files can change outside Naidan. Fresh File snapshots deliberately
    // invalidate retained-model identity, even when an old receipt still matches.
    const sourceId = !candidate.hostSource && candidate.files.every(entry => entry.receipt?.source.kind === 'hugging-face') ? JSON.stringify({
      repository: candidate.repositoryId,
      path: candidate.path,
      files: candidate.files.map(entry => ({ path: entry.path, size: entry.file.size, modified: entry.file.lastModified, receipt: entry.receipt ?? null })),
    }) : undefined;
    return { slot, ...(sourceId ? { sourceId } : {}), file: file.file, path: candidate.path, companions: candidate.files.filter(entry => entry.path !== candidate.path) };
  }
  function benchmarkTargets({ selections: benchmarkSelections }: { selections: Readonly<Record<string, Partial<Record<ModelSlot, string>>>> }): ImageBenchmarkTarget[] {
    return inventory.value.candidates.flatMap(candidate => {
      const slot = primarySlot({ family: candidate.family });
      if (!slot) return [];
      const useSelection = candidate.id === main.value && origin !== 'files';
      const missing: ModelSlot[] = [];
      const members = [{ slot, candidate }];
      const components: ImageComponentChoice[] = [];
      const benchmarkOverrides = benchmarkSelections[candidate.id];
      for (const requirement of componentRequirements({ family: candidate.family })) {
        // Benchmark overrides are independent per primary model. Empty selections
        // are intentional; never silently replace them with an automatic companion.
        const id = benchmarkOverrides?.[requirement.slot] ?? (useSelection ? selections.value[requirement.slot] : requirement.required ? defaultCompanion({ main: candidate, candidates: inventory.value.candidates, requirement }) : undefined);
        components.push({
          slot: requirement.slot,
          selected: id ?? '',
          required: requirement.required,
          choices: inventory.value.candidates.filter(item => item.id !== candidate.id && (item.roles.includes(requirement.slot) || item.id === id || componentMatch({ candidate: item, requirement }) !== 'incompatible'))
            .map(item => describe({ candidate: item, status: componentMatch({ candidate: item, requirement }) }))
            .sort((a, b) => a.detail.localeCompare(b.detail)),
        });
        const component = inventory.value.candidates.find(item => item.id === id);
        if (component && componentMatch({ candidate: component, requirement }) !== 'incompatible') members.push({ slot: requirement.slot, candidate: component });
        else if (requirement.required || id || useSelection && benchmarkOverrides?.[requirement.slot] === undefined
          && !overrides.has(requirement.slot) && recipeIntent?.files.some(file => file.role === requirement.slot)) missing.push(requirement.slot);
      }
      const issue = candidate.issue ?? (members.some(item => !item.candidate.files.some(file => file.path === item.candidate.path)) ? 'Missing local file' : undefined);
      return [{
        id: candidate.id,
        label: candidate.path.split('/').at(-1) ?? candidate.path,
        detail: `${candidate.repositoryId}/${candidate.path}`,
        facts: { family: candidate.family, variant: candidate.variant, evidence: [...candidate.evidence] },
        composition: useSelection || benchmarkOverrides ? 'selected' as const : 'automatic' as const,
        components,
        missing,
        issue,
        models: !issue && missing.length === 0 ? members.map(item => modelForCandidate(item)) : undefined,
      }];
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function cancelImport(): void {
    activeImport.value?.abort();
  }
  function useManualFiles(): void {
    selectionVersion++; unavailableLoras = []; recipeIntent = undefined; origin = 'files'; main.value = ''; selections.value = {}; overrides.clear();
  }
  onScopeDispose(() => {
    disposed = true; for (const job of jobs.value) if (job !== currentJob) job.completion.resolve(); jobs.value = []; cancelScan(); activeImport.value?.abort(); activeDownload.value?.abort(); hostPublication?.abort();
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
    main,
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
