<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, GlobeIcon, HardDriveIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import type { ChatRepositoryModelSelection } from '@/composables/chat/chat-scoped/useChatLocalModel';
import { configuredRepositoryModelId, trySplitRepositoryModelId } from '@/01-models/llama-cpp-browser-model-id';
import { findLocalSuggestedModel } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { DownloadDestination } from '@/01-models/download';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { AuthorizeModelLaunchDestination } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { useModelSelectorHuggingFaceSearchState } from '@/composables/useModelSelectorHuggingFaceSearchState';
import { destinationKey } from '@/features/llama-cpp-browser/runtime/model-destination';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { modelSuggestions, preferredQuantizationHint, suggestedProjectors, suggestedQuantizationLabel, type ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { resolveModelFiles } from '@/features/llama-cpp-browser/runtime/model-file-selection';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { formatDownloadBytes, quantizationName } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { confirmModelLaunchConfiguration, initialRepositorySelection, modelLaunchChoices, sameLaunchTarget, targetForSelection } from '@/features/llama-cpp-browser/model-launch/target';
import ModelSelectorHuggingFaceSearch from '@/components/ModelSelectorHuggingFaceSearch.vue';
import ModelSelectorConfigurationSummary from '@/components/ModelSelectorConfigurationSummary.vue';
import ModelSelectorConfiguration from '@/components/ModelSelectorConfiguration.vue';
import ModelSelectorFileOptions from '@/components/ModelSelectorFileOptions.vue';
import ModelSelectorRepositorySource from '@/components/ModelSelectorRepositorySource.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { repositoryUrlPath } from '@/features/llama-cpp-browser/hugging-face/types';
import { downloadJobKey, findModelDownloadJob, getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { fileDownloadUrl, selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { hasActiveRepositoryDefaultDownload, repositoryDefaultDownloadKey, repositoryRowDownload, type RepositoryModelDownloadRequest } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { preferredProjector, projectorChoices } from '@/features/llama-cpp-browser/hugging-face/presentation';
import ModelSelectorVariantDownload from '@/components/ModelSelectorVariantDownload.vue';
import { bundledRepositoryDownloadKey, repositoryModelDownloadIdentity, resolveBundledRepositoryTarget } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import LlamaCppBrowserSuggestedModelRows from './LlamaCppBrowserSuggestedModelRows.vue';
import LlamaCppBrowserModelConfiguration from './LlamaCppBrowserModelConfiguration.vue';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';

const props = defineProps<{ disabled: boolean, layout?: 'inline-results' | 'candidate-results', popupTarget?: HTMLElement, selectionBlocked?: boolean, selectionPolicy?: 'first-use-download' | 'installed-only', selectedForFirstUse?: ChatRepositoryModelSelection, currentModelId?: string, refreshInventory?: () => Promise<void> }>();
const emit = defineEmits<{
  select: [request: { target: ModelLaunchTarget, destination: DownloadDestination, authorizeDestination: AuthorizeModelLaunchDestination }],
  'select-model': [model: LocalModel, presentation?: 'keep-open'],
  'select-for-first-use': [selection: ChatRepositoryModelSelection, presentation?: 'keep-open'],
  'view-change': [view: 'search' | 'configuration'],
  close: [],
}>();
const input = ref('');
const { query: inlineQuery } = useModelSelectorHuggingFaceSearchState();
type ExpandedRepository = { repository: string, source: 'result' | 'url' };
const search = ref<{ focusOrigin({ repository, source }: { repository: string, source: ExpandedRepository['source'] }): void }>();
const candidateMode = computed(() => props.layout === 'candidate-results');
const immediateSelection = computed(() => props.selectionPolicy !== undefined);
const sourceView = computed(() => candidateMode.value ? LlamaCppBrowserSuggestedModelRows : ModelSelectorHuggingFaceSearch);
const openedRepository = shallowRef<ExpandedRepository>();
const choosingResult = shallowRef<ExpandedRepository>();
const candidateHintId = ref<string>();
const editingConfiguration = ref(false);
const candidate = computed(() => candidateMode.value ? modelSuggestions.find(item => item.id === openedRepository.value?.repository) : undefined);
const candidateHint = computed(() => candidate.value?.quantizationHints.find(hint => hint.id === candidateHintId.value));
const selectedRepository = computed(() => {
  const source = props.selectedForFirstUse?.source;
  switch (source?.kind) {
  case 'bundled': return source.repository;
  case 'resolved': return source.target.selection.repository;
  case undefined: return props.currentModelId?.match(/^(?:hf\.co|host\/[^/]+)\/([^:]+):/)?.[1];
  default: throw new Error(String(source satisfies never));
  }
});
const candidateChoices = computed(() => candidate.value?.quantizationHints.map(hint => ({
  id: hint.id,
  label: suggestedQuantizationLabel({ quantization: hint }),
  filePath: hint.hfRepository,
  bytes: hint.approximateModelBytes,
})) ?? []);
const catalog = shallowRef<RepositoryCatalog>();
const standardRepositoryConfiguration = shallowRef<ReturnType<typeof initialRepositorySelection>>();
// Report the view before its DOM changes so the owning panel can retain the
// search position before the shorter configuration view clamps scrollTop.
watch(() => catalog.value === undefined ? 'search' : 'configuration', view => emit('view-change', view), { flush: 'sync' });
const active = shallowRef<AbortController>();
const error = ref(false);
const failureContext = ref<'metadata'>();
const mainPath = ref('');
const companionPath = ref('');
const multimodal = ref<'on' | 'off'>('off');
const includesMultimodal = computed(() => {
  switch (multimodal.value) {
  case 'on': return true;
  case 'off': return false;
  default: throw new Error(String(multimodal.value satisfies never));
  }
});
const choices = computed(() => {
  const options = catalog.value === undefined ? [] : modelLaunchChoices({ catalog: catalog.value });
  return options.map(option => ({ ...option, size: option.models.reduce((sum, model) => sum + model.size, 0), displayLabel: options.filter(other => other.label === option.label).length > 1 ? `${option.label} (${option.primaryRelativePath})` : option.label }));
});
const target = computed(() => {
  if (catalog.value === undefined || !mainPath.value) {
    return undefined;
  }
  try {
    const companionFilePath = (() => {
      switch (multimodal.value) {
      case 'off': return undefined;
      case 'on': return companionPath.value || undefined;
      default: {
        const exhaustive: never = multimodal.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    return confirmModelLaunchConfiguration({ catalog: catalog.value, mainFilePath: mainPath.value, companionFilePath, multimodal: multimodal.value });
  } catch {
    return undefined;
  }
});
const variants = computed(() => choices.value.map(choice => ({ id: choice.primaryRelativePath, label: choice.displayLabel, filePath: choice.primaryRelativePath, bytes: choice.size })));
const companionVariants = computed(() => projectorChoices({ files: catalog.value?.projectors ?? projectorsForHint({ hint: candidateHint.value }) })
  .map(({ label, file }) => ({ id: file.path, label, filePath: file.path, bytes: file.size })));
const selectedFiles = computed(() => {
  const selection = target.value?.selection;
  return selection?.files.map(file => ({ name: file.path, bytes: file.size, url: fileDownloadUrl({ repository: selection.repository, revision: selection.revision, file }) }));
});
const repositorySource = computed(() => {
  const repository = catalog.value?.repository ?? candidateHint.value?.hfRepository;
  return repository === undefined ? undefined : { repository, url: 'https://huggingface.co/' + repositoryUrlPath({ repository }), files: selectedFiles.value };
});
const bytes = computed(() => target.value?.selection.files.reduce((sum, file) => sum + file.size, 0));
const configurationBytes = computed(() => {
  const hint = candidateHint.value;
  if (catalog.value !== undefined) {
    return bytes.value;
  }
  if (hint === undefined) {
    return undefined;
  }
  const companion = includesMultimodal.value ? companionVariants.value.find(variant => variant.id === companionPath.value) : undefined;
  return hint.approximateModelBytes + (companion?.bytes ?? 0);
});
const currentMainChoice = computed(() => choices.value.find(choice => choice.primaryRelativePath === mainPath.value));
const configurationQuantization = computed(() => {
  const hint = candidateHint.value;
  if (catalog.value === undefined) {
    return hint === undefined ? undefined : suggestedQuantizationLabel({ quantization: hint });
  }
  const choice = currentMainChoice.value;
  if (choice !== undefined && hint?.checkpoint === 'qat' && choice.quantization === hint.preferredQuantization) {
    return suggestedQuantizationLabel({ quantization: hint });
  }
  return choice?.quantization ?? choice?.label;
});
const configurationMultimodal = computed<'included' | 'excluded' | undefined>(() => {
  if (!companionVariants.value.length) {
    return undefined;
  }
  return !includesMultimodal.value ? 'excluded' : companionVariants.value.some(variant => variant.id === companionPath.value) ? 'included' : undefined;
});
const defaultRepositoryConfiguration = computed(() => {
  const standard = standardRepositoryConfiguration.value;
  return !candidateMode.value && standard !== undefined && mainPath.value === standard.mainPath && multimodal.value === standard.multimodal
    && (!includesMultimodal.value || companionPath.value === standard.companionPath);
});
const configurationStatus = computed<'standard' | 'selected' | 'missing'>(() => {
  const suggestion = candidate.value;
  const hint = candidateHint.value;
  if (catalog.value !== undefined && target.value === undefined) {
    return 'missing';
  }
  if (suggestion === undefined || hint === undefined) {
    return defaultRepositoryConfiguration.value ? 'standard' : 'selected';
  }
  const suggested = preferredQuantizationHint({ suggestion });
  const projector = preferredProjector({ files: projectorsForHint({ hint }) });
  const hasCompanion = projectorsForHint({ hint }).length > 0;
  const chosenMain = catalog.value === undefined ? hint.preferredQuantization : currentMainChoice.value?.quantization;
  return hint.id === suggested.id && chosenMain === suggested.preferredQuantization
    && (hasCompanion ? multimodal.value === 'on' && companionPath.value === projector?.path : multimodal.value === 'off')
    ? 'standard' : 'selected';
});
const downloadDestination = useModelDownloadDestination({ blocked: () => props.disabled, changed: () => {} });
const { destination, revision: destinationRevision, unavailable: destinationUnavailable, failure: destinationFailure, persistence: destinationPersistence } = downloadDestination;
const destinationIdentity = computed(() => destinationKey({ destination: destination.value }));
const destinationBusy = downloadDestination.view.busy;
const downloadQueue = props.layout === undefined ? undefined : getDownloadQueue();
const selectedDownloadStatus = computed(() => {
  const selected = props.selectedForFirstUse;
  if (selected === undefined) {
    return undefined;
  }
  const { source, destination, defaultDownloadKey } = selected;
  const jobs = downloadQueue?.jobs.value ?? [];
  const job = findModelDownloadJob({ jobs, destination, ...repositoryModelDownloadIdentity({ source }) });
  const defaultJob = defaultDownloadKey === undefined ? undefined : findModelDownloadJob({ jobs, key: defaultDownloadKey, destination, selection: undefined });
  if (job?.status === 'complete' || jobIsBusy({ job }) || jobIsBusy({ job: defaultJob })) {
    return undefined;
  }
  return lazyStrings.ModelSelector__downloads_automatically();
});
const bundledSource = computed(() => {
  const hint = candidateHint.value;
  if (catalog.value !== undefined || hint === undefined || (multimodal.value === 'on' && !companionPath.value)) {
    return undefined;
  }
  return {
    kind: 'bundled' as const,
    repository: hint.hfRepository,
    variant: hint.preferredQuantization,
    companionPath: includesMultimodal.value ? companionPath.value : undefined,
  };
});
const selectionTarget = computed(() => {
  if (target.value !== undefined || bundledSource.value === undefined) {
    return target.value;
  }
  const key = downloadJobKey({ key: bundledRepositoryDownloadKey(bundledSource.value), destination: destination.value });
  const selection = downloadQueue?.jobs.value.find(job => job.key === key && job.status === 'complete')?.selection;
  return selection === undefined ? undefined : targetForSelection({ selection });
});
const saved = shallowRef<{ status: 'checking' | 'missing' | 'unavailable' } | { status: 'saved', model: LocalModel }>({ status: 'checking' });
let installedCheck: Promise<void> | undefined;
watch([selectionTarget, bundledSource, () => downloadQueue?.changed.value, destinationIdentity, destinationRevision, destinationUnavailable, destinationPersistence, destinationBusy, () => props.disabled], ([value, bundled, _downloads, _destination, _revision, unavailable, persistence, busy, disabled], _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  installedCheck = undefined;
  saved.value = { status: 'checking' };
  // Retained tabs do not inspect saved files until a configuration opens.
  if ((value === undefined && bundled === undefined) || disabled || busy || persistence !== 'saved') {
    return;
  }
  if (unavailable) {
    saved.value = { status: 'unavailable' };
    return;
  }
  const requestedDestination = destination.value;
  const hint = candidateHint.value;
  async function checkSaved(): Promise<LocalModel | undefined> {
    if (value !== undefined) {
      return installedSelection({ selection: value.selection, destination: requestedDestination, ...(immediateSelection.value ? { exactConfiguration: true } : {}) });
    }
    if (hint !== undefined && bundled !== undefined) {
      const { listModelInventory } = await import('@/features/llama-cpp-browser/composables/model-inventory');
      const { llamaCppBrowserModelFiles } = await import('@/features/llama-cpp-browser/model-files');
      const inventory = await listModelInventory({ signal: controller.signal });
      const matching = findLocalSuggestedModel({ quantization: hint, models: inventory, destination: requestedDestination });
      if (matching !== undefined) {
        const modelId = configuredRepositoryModelId({ modelId: matching.modelId, configuration: { projectorPath: bundled.companionPath } });
        try {
          return await llamaCppBrowserModelFiles.getModelEntry({ modelId, signal: controller.signal });
        } catch {
          controller.signal.throwIfAborted();
        }
      }
    }
    return undefined;
  }
  installedCheck = checkSaved().then(model => {
    if (!controller.signal.aborted) {
      saved.value = model === undefined ? { status: 'missing' } : { status: 'saved', model };
    }
  }).catch(() => {
    if (!controller.signal.aborted) {
      saved.value = { status: 'unavailable' };
    }
  });
}, { immediate: true, flush: 'sync' });

const firstUseSelection = computed<ChatRepositoryModelSelection | undefined>(() => {
  const policy = props.selectionPolicy;
  switch (policy) {
  case 'first-use-download': break;
  case 'installed-only': case undefined: return undefined;
  default: throw new Error(String(policy satisfies never));
  }
  const selected = selectionTarget.value;
  if (selected !== undefined) {
    const state = saved.value;
    switch (state.status) {
    case 'missing': return {
      modelId: selected.modelId,
      source: { kind: 'resolved', target: selected },
      destination: destination.value,
      authorizeDestination: downloadDestination.authorize,
      ...(defaultRepositoryConfiguration.value ? { defaultDownloadKey: repositoryDefaultDownloadKey({ repository: selected.selection.repository, usage: 'chat' }) } : {}),
    };
    case 'checking': case 'saved': case 'unavailable': return undefined;
    default: throw new Error(String(state satisfies never));
    }
  }
  const source = bundledSource.value;
  if (source === undefined || saved.value.status === 'saved' || saved.value.status === 'unavailable') {
    return undefined;
  }
  return {
    modelId: `hf.co/${source.repository}:${source.variant}`,
    source,
    destination: destination.value,
    authorizeDestination: downloadDestination.authorize,
  };
});
const inlineSelectionReady = computed(() => firstUseSelection.value !== undefined || saved.value.status === 'saved' || selectionTarget.value !== undefined && !immediateSelection.value && saved.value.status === 'missing');

const configurationSelected = computed(() => {
  if ('model' in saved.value) {
    if (saved.value.model.modelId === props.currentModelId) {
      return true;
    }
    const selected = props.selectedForFirstUse;
    if (selected === undefined || destinationKey({ destination: selected.destination }) !== destinationKey({ destination: destination.value })) {
      return false;
    }
    const source = bundledSource.value;
    if (source !== undefined && selected.source.kind === 'bundled') {
      return bundledRepositoryDownloadKey(source) === bundledRepositoryDownloadKey(selected.source);
    }
    return selected.source.kind === 'resolved' && selectionTarget.value !== undefined
      && sameLaunchTarget({ left: selected.source.target, right: selectionTarget.value });
  }
  const current = firstUseSelection.value;
  const selected = props.selectedForFirstUse;
  if (current === undefined || selected === undefined || current.modelId !== selected.modelId || destinationKey({ destination: current.destination }) !== destinationKey({ destination: selected.destination })) {
    return false;
  }
  const { source } = current;
  const selectedSource = selected.source;
  if (source.kind === 'resolved' && selectedSource.kind === 'resolved') {
    return sameLaunchTarget({ left: source.target, right: selectedSource.target });
  }
  return source.kind === 'bundled' && selectedSource.kind === 'bundled' && source.companionPath === selectedSource.companionPath;
});
const inlineSelectionDisabled = computed(() => props.disabled || active.value !== undefined || props.selectionBlocked || destinationBusy.value || destinationUnavailable.value || !inlineSelectionReady.value);

function variantDownload({ id }: { id: string }): RepositoryModelDownloadRequest | undefined {
  if (catalog.value !== undefined) {
    if (mainPath.value === id && saved.value.status === 'saved') {
      return undefined;
    }
    let chosen: ModelLaunchTarget;
    try {
      chosen = confirmModelLaunchConfiguration({ catalog: catalog.value, mainFilePath: id, companionFilePath: includesMultimodal.value ? companionPath.value || undefined : undefined, multimodal: multimodal.value });
    } catch {
      return undefined;
    }
    const selection = chosen.selection;
    return { key: selectionKey({ selection }), repository: selection.repository, source: 'repository', destination: destination.value, prepared: selection, prepare: async () => selection };
  }
  const hint = candidate.value?.quantizationHints.find(entry => entry.id === id);
  if (hint === undefined) {
    return undefined;
  }
  const files = projectorsForHint({ hint });
  const projector = includesMultimodal.value
    ? files.find(file => file.path === companionPath.value) ?? preferredProjector({ files })
    : undefined;
  if (multimodal.value === 'on' && projector === undefined) {
    return undefined;
  }
  return bundledDownload({ source: { repository: hint.hfRepository, variant: hint.preferredQuantization, companionPath: projector?.path }, targetDestination: destination.value });
}

function bundledDownload({ source, targetDestination }: { source: { repository: string, variant: string, companionPath: string | undefined }, targetDestination: DownloadDestination }): RepositoryModelDownloadRequest {
  return {
    key: bundledRepositoryDownloadKey(source),
    repository: source.repository,
    source: 'suggestion',
    destination: targetDestination,
    prepare: async ({ signal }) => (await resolveBundledRepositoryTarget({ ...source, signal })).selection,
  };
}

function isSelectedCandidate({ candidate }: { candidate: ModelSuggestion }): boolean {
  const repository = selectedRepository.value?.toLowerCase();
  return candidate.quantizationHints.some(hint => hint.hfRepository.toLowerCase() === repository);
}

function searchResultDownload({ repository }: { repository: string }): RepositoryModelDownloadRequest | undefined {
  const current = props.selectedForFirstUse;
  const selected = current?.source.kind === 'resolved' && current.source.target.selection.repository.toLowerCase() === repository.toLowerCase()
    ? { target: current.source.target, destination: current.destination } : undefined;
  const targetDestination = selected?.destination ?? destination.value;
  const activeDefault = hasActiveRepositoryDefaultDownload({ repository, usage: 'chat', destination: targetDestination });
  if (!activeDefault) {
    if (selected === undefined && current === undefined && selectedRepository.value?.toLowerCase() === repository.toLowerCase()) {
      return undefined;
    }
    if (selected === undefined && catalog.value?.repository.toLowerCase() === repository.toLowerCase()) {
      return variantDownload({ id: mainPath.value });
    }
  }
  return repositoryRowDownload({
    repository,
    destination: targetDestination,
    usage: 'chat',
    selection: activeDefault ? undefined : selected?.target.selection,
    defaultSelection: ({ catalog }) => {
      const initial = initialRepositorySelection({ catalog, requestedVariant: undefined });
      return confirmModelLaunchConfiguration({ catalog, mainFilePath: initial.mainPath, companionFilePath: initial.companionPath || undefined, multimodal: initial.multimodal }).selection;
    },
  });
}

function describeCandidate({ candidate }: { candidate: ModelSuggestion }) {
  const standard = preferredQuantizationHint({ suggestion: candidate });
  const selected = isSelectedCandidate({ candidate });
  const pending = selected ? props.selectedForFirstUse : undefined;
  const source = pending?.source;
  const variant = (() => {
    switch (source?.kind) {
    case 'resolved': return quantizationName({ path: source.target.mainFilePath });
    case 'bundled': return source.variant;
    case undefined: return selected && props.currentModelId ? quantizationName({ path: trySplitRepositoryModelId({ modelId: props.currentModelId })?.baseId.split(':').at(-1) ?? '' }) : undefined;
    default: throw new Error(String(source satisfies never));
    }
  })();
  const hint = selected && variant !== undefined
    ? candidate.quantizationHints.find(hint => hint.hfRepository.toLowerCase() === selectedRepository.value?.toLowerCase() && hint.preferredQuantization === variant) ?? standard
    : standard;
  const quantization = variant !== undefined && variant !== hint.preferredQuantization ? variant : suggestedQuantizationLabel({ quantization: hint });
  if (source?.kind === 'resolved' && pending !== undefined) {
    const selection = source.target.selection;
    return {
      quantization,
      selected,
      bytes: selection.files.reduce((total, file) => total + file.size, 0),
      status: selectedDownloadStatus.value,
      download: { key: selectionKey({ selection }), repository: selection.repository, source: 'repository', destination: pending.destination, prepared: selection, prepare: async () => selection } satisfies RepositoryModelDownloadRequest,
    };
  }
  const projector = preferredProjector({ files: projectorsForHint({ hint }) });
  const download = pending !== undefined && source?.kind === 'bundled'
    ? bundledDownload({ source, targetDestination: pending.destination })
    : selected ? undefined : bundledDownload({ source: { repository: hint.hfRepository, variant: hint.preferredQuantization, companionPath: projector?.path }, targetDestination: destination.value });
  const selectedProjector = (() => {
    switch (source?.kind) {
    case 'bundled': return projectorsForHint({ hint }).find(file => file.path === source.companionPath);
    case 'resolved': return projector;
    case undefined: {
      const current = selected ? currentRepositoryConfiguration({ repository: hint.hfRepository }) : undefined;
      return current === undefined ? projector : projectorsForHint({ hint }).find(file => file.path === current.projectorPath);
    }
    default: throw new Error(String(source satisfies never));
    }
  })();
  return { quantization, selected, bytes: hint.approximateModelBytes + (selectedProjector?.size ?? 0), status: selected ? selectedDownloadStatus.value : undefined, download };
}

const selectionIdentity = computed(() => {
  const bundled = bundledSource.value;
  if (bundled !== undefined) {
    return downloadJobKey({ key: bundledRepositoryDownloadKey(bundled), destination: destination.value });
  }
  const current = selectionTarget.value;
  return current === undefined ? undefined : downloadJobKey({ key: selectionKey({ selection: current.selection }), destination: destination.value });
});

async function select({ presentation }: { presentation: 'close' | 'keep-open' }): Promise<void> {
  if (props.disabled || active.value !== undefined || props.selectionBlocked || destinationBusy.value || destinationUnavailable.value) {
    return;
  }
  const requested = selectionIdentity.value;
  for (let check = installedCheck; saved.value.status === 'checking' && check !== undefined; check = installedCheck) {
    await check;
    if (selectionIdentity.value !== requested || props.disabled || props.selectionBlocked || destinationBusy.value || destinationUnavailable.value) {
      return;
    }
    if (installedCheck === check) {
      break;
    }
  }
  const keepOpen = (() => {
    switch (presentation) {
    case 'keep-open': return true;
    case 'close': return false;
    default: throw new Error(String(presentation satisfies never));
    }
  })();
  const deferred = firstUseSelection.value;
  if (deferred !== undefined) {
    if (keepOpen) {
      emit('select-for-first-use', deferred, 'keep-open');
    } else {
      emit('select-for-first-use', deferred);
    }
    return;
  }
  const current = selectionTarget.value;
  const local = saved.value;
  switch (local.status) {
  case 'saved':
    // Reading an installed host model does not require write permission.
    if (keepOpen) {
      emit('select-model', local.model, 'keep-open');
    } else {
      emit('select-model', local.model);
    }
    break;
  case 'missing':
    if (current !== undefined && props.selectionPolicy !== 'installed-only') {
      emit('select', { target: current, destination: destination.value, authorizeDestination: downloadDestination.authorize });
    }
    break;
  case 'checking': case 'unavailable': break;
  default: {
    const exhaustive: never = local;
    throw new Error(String(exhaustive));
  }
  }
}

function clearInlineRepository(): void {
  choosingResult.value = undefined;
  openedRepository.value = undefined;
  candidateHintId.value = undefined;
  editingConfiguration.value = false;
  multimodal.value = 'off';
  companionPath.value = '';
  reset();
}

function closeInlineRepository(): void {
  const opened = openedRepository.value;
  clearInlineRepository();
  if (opened !== undefined) {
    void nextTick(() => search.value?.focusOrigin(opened));
  }
}

function currentRepositoryConfiguration({ repository }: { repository: string }): { variant: string, mainPath?: string, projectorPath: string | undefined } | undefined {
  if (selectedRepository.value?.toLowerCase() !== repository.toLowerCase()) {
    return undefined;
  }
  const pending = props.selectedForFirstUse?.source;
  switch (pending?.kind) {
  case 'resolved': {
    const { selection, mainFilePath } = pending.target;
    const { projectorRelativePath } = resolveModelFiles({ files: selection.files.map(file => ({ relativePath: file.path })) });
    return { variant: pending.target.modelId.slice(pending.target.modelId.indexOf(':') + 1), mainPath: mainFilePath, projectorPath: projectorRelativePath };
  }
  case 'bundled': return { variant: pending.variant, projectorPath: pending.companionPath };
  case undefined: break;
  default: throw new Error(String(pending satisfies never));
  }
  const modelId = props.currentModelId;
  const parsed = modelId === undefined ? undefined : trySplitRepositoryModelId({ modelId });
  if (parsed?.configuration === undefined) {
    return undefined;
  }
  return { variant: parsed.baseId.slice(parsed.baseId.indexOf(':') + 1), projectorPath: parsed.configuration.projectorPath };
}

function openInlineRepository({ repository, source }: { repository: string, source: 'result' | 'url' }): void {
  if (source === 'result' && openedRepository.value?.source === source && openedRepository.value.repository === repository) {
    closeInlineRepository();
    return;
  }
  clearInlineRepository();
  openedRepository.value = { repository, source };
  if (candidate.value !== undefined) {
    const pending = props.selectedForFirstUse?.source;
    const existing = pending !== undefined && 'variant' in pending ? pending : undefined;
    const selected = selectedRepository.value;
    const current = selected === undefined ? undefined : currentRepositoryConfiguration({ repository: selected });
    const chosenVariant = existing?.variant ?? (current === undefined ? undefined : quantizationName({ path: current.variant }));
    const hint = candidate.value.quantizationHints.find(hint => hint.hfRepository.toLowerCase() === selected?.toLowerCase() && hint.preferredQuantization === chosenVariant);
    chooseCandidateHint({ id: (hint ?? preferredQuantizationHint({ suggestion: candidate.value })).id });
    const configured = existing !== undefined ? { projectorPath: existing.companionPath } : current;
    if (hint !== undefined && configured !== undefined) {
      multimodal.value = configured.projectorPath === undefined ? 'off' : 'on';
      companionPath.value = configured.projectorPath ?? '';
    }
    return;
  }
  void checkRepository({ value: repository, requestedVariant: undefined, freshness: 'reuse' });
}

async function chooseBundledModel({ id }: { id: string }): Promise<void> {
  const suggestion = modelSuggestions.find(suggestion => suggestion.id === id);
  if (suggestion === undefined) {
    return;
  }
  if (isSelectedCandidate({ candidate: suggestion })) {
    emit('close');
    return;
  }
  const alreadyOpen = openedRepository.value?.repository === id;
  if (!alreadyOpen) {
    openInlineRepository({ repository: id, source: 'result' });
  }
  const opened = openedRepository.value;
  await select({ presentation: 'close' });
  if (!alreadyOpen && openedRepository.value === opened && (props.selectionPolicy !== 'installed-only' || saved.value.status === 'saved')) {
    clearInlineRepository();
  }
}

async function chooseSearchResult({ repository }: { repository: string }): Promise<void> {
  if (props.disabled || props.selectionBlocked || choosingResult.value?.repository === repository) {
    return;
  }
  if (selectedRepository.value?.toLowerCase() === repository.toLowerCase()) {
    emit('close');
    return;
  }
  if (catalog.value?.repository.toLowerCase() === repository.toLowerCase()) {
    await select({ presentation: 'close' });
    return;
  }
  clearInlineRepository();
  const result: ExpandedRepository = { repository, source: 'result' };
  choosingResult.value = result;
  openedRepository.value = result;
  await checkRepository({ value: repository, requestedVariant: undefined, freshness: 'reuse' });
  if (choosingResult.value === result && catalog.value !== undefined && !error.value) {
    await select({ presentation: 'close' });
  }
  if (choosingResult.value === result) {
    choosingResult.value = undefined;
  }
}

function chooseInlineModel({ id }: { id: string }): void {
  if (candidateMode.value) {
    void chooseBundledModel({ id });
  } else {
    void chooseSearchResult({ repository: id });
  }
}

function applyEditedConfiguration(): void {
  if (immediateSelection.value) {
    void select({ presentation: 'keep-open' });
  }
}

function projectorsForHint({ hint }: { hint: typeof candidateHint.value }) {
  return hint === undefined ? [] : [...suggestedProjectors({ repository: hint.hfRepository })];
}

function chooseCandidateHint({ id }: { id: string }): void {
  const previousFiles = projectorsForHint({ hint: candidateHint.value });
  candidateHintId.value = id;
  const files = projectorsForHint({ hint: candidateHint.value });
  if (files.length > 0 && previousFiles.length === 0) {
    multimodal.value = 'on';
  }
  if (!files.some(file => file.path === companionPath.value)) {
    companionPath.value = preferredProjector({ files })?.path ?? '';
  }
}

function inspectCandidate(): void {
  const hint = candidateHint.value;
  if (hint !== undefined) {
    void checkRepository({ value: hint.hfRepository, requestedVariant: hint.preferredQuantization, freshness: 'refresh' });
  }
}

function returnToCandidate(): void {
  reset();
  const hint = candidateHint.value;
  if (hint !== undefined) {
    chooseCandidateHint({ id: hint.id });
  }
}

function handleInlineEscape({ event }: { event: KeyboardEvent }): void {
  if (openedRepository.value !== undefined && !event.isComposing) {
    event.stopPropagation();
    event.preventDefault();
    closeInlineRepository();
  }
}

function reset(): void {
  active.value?.abort();
  active.value = undefined;
  catalog.value = undefined;
  standardRepositoryConfiguration.value = undefined;
  error.value = false;
  failureContext.value = undefined;
}

watch(input, reset, { flush: 'sync' });
watch(() => {
  switch (props.layout) {
  case 'inline-results': return inlineQuery.value;
  case 'candidate-results': case undefined: return undefined;
  default: throw new Error(String(props.layout satisfies never));
  }
}, clearInlineRepository);

watch(() => props.disabled, disabled => {
  if (!disabled || active.value === undefined) {
    return;
  }
  if (props.layout === 'inline-results' && catalog.value === undefined) {
    clearInlineRepository();
    return;
  }
  active.value.abort();
  active.value = undefined;
});
onUnmounted(reset);

async function checkRepository({ value, requestedVariant, freshness }: { value: string, requestedVariant: string | undefined, freshness: 'reuse' | 'refresh' }): Promise<void> {
  if (props.disabled || active.value) {
    return;
  }
  const previousMain = freshness === 'refresh' && catalog.value !== undefined ? mainPath.value : undefined;
  const previousCompanion = (() => {
    switch (freshness) {
    case 'refresh': return companionPath.value;
    case 'reuse': return undefined;
    default: throw new Error(String(freshness satisfies never));
    }
  })();
  const previousMultimodal = freshness === 'refresh' && (catalog.value !== undefined || projectorsForHint({ hint: candidateHint.value }).length > 0) ? multimodal.value : undefined;
  const controller = new AbortController();
  error.value = false;
  failureContext.value = undefined;
  active.value = controller;
  let readingMetadata = false;
  try {
    const parsed = parseRepository({ input: value });
    // This explicit repository/search-result action authorizes metadata only.
    readingMetadata = true;
    const found = await getMetadataSession().inspect({ input: value, signal: controller.signal, freshness });
    readingMetadata = false;
    if (controller.signal.aborted || active.value !== controller) {
      return;
    }
    catalog.value = found;
    const current = immediateSelection.value ? currentRepositoryConfiguration({ repository: found.repository }) : undefined;
    const initial = initialRepositorySelection({ catalog: found, requestedVariant: requestedVariant ?? parsed.requestedVariant ?? current?.variant });
    standardRepositoryConfiguration.value = initialRepositorySelection({ catalog: found, requestedVariant: undefined });
    const chosenMainPath = previousMain ?? current?.mainPath;
    mainPath.value = chosenMainPath && found.models.some(model => model.files[0]?.path === chosenMainPath) ? chosenMainPath : initial.mainPath;
    const previousProjector = previousCompanion ?? (current === undefined ? undefined : current.projectorPath ?? '');
    companionPath.value = previousProjector === undefined
      ? initial.companionPath
      : found.projectors.some(file => file.path === previousProjector) ? previousProjector : '';
    multimodal.value = previousMultimodal ?? (current === undefined ? initial.multimodal : current.projectorPath === undefined ? 'off' : 'on');
    error.value = modelLaunchChoices({ catalog: found }).length === 0;
    if (props.layout !== undefined && target.value === undefined && !error.value) {
      editingConfiguration.value = true;
    }
  } catch {
    if (!controller.signal.aborted) {
      error.value = true;
      failureContext.value = readingMetadata ? 'metadata' : undefined;
    }
  } finally {
    if (active.value === controller) {
      active.value = undefined;
    }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="layout !== undefined" tw-class="min-w-0 text-left" @keydown.esc="handleInlineEscape({ event: $event })">
    <component :is="sourceView" ref="search" v-bind="candidateMode ? { immediateSelection, describeCandidate, refreshInventory, destinationLabel: downloadDestination.label, downloadDisabled: disabled || destinationBusy || destinationUnavailable } : { query: inlineQuery, active: !disabled, immediateSelection, selectedRepository, choosingRepository: choosingResult?.repository }" :disabled="disabled" :expanded-repository="openedRepository" @update:query="inlineQuery = $event" @select="(repository: string, source: 'result' | 'url') => openInlineRepository({ repository, source })" @choose="chooseInlineModel({ id: $event })" @search="clearInlineRepository">
      <template v-if="!candidateMode && immediateSelection" #result-actions="{ repository }">
        <ModelSelectorVariantDownload :destination-label="downloadDestination.label" :request="searchResultDownload({ repository })" :label="repository" :disabled="disabled || destinationBusy || destinationUnavailable" :refresh-inventory="refreshInventory" />
      </template>
      <template #repository>
        <ModelSelectorConfiguration v-if="openedRepository" @collapse="closeInlineRepository">
          <template v-if="candidate || (catalog && variants.length)" #summary>
            <ModelSelectorConfigurationSummary :status="configurationStatus" :quantization="configurationQuantization" :multimodal="configurationMultimodal" :bytes="configurationBytes" :expanded="editingConfiguration" selectable :checked="configurationSelected" :selection-disabled="inlineSelectionDisabled" @toggle="editingConfiguration = !editingConfiguration" @choose="select({ presentation: 'close' })" />
          </template>
          <template v-if="(catalog || candidateHint) && editingConfiguration" #source>
            <ModelSelectorRepositorySource v-if="repositorySource" v-bind="repositorySource" />
          </template>
          <div v-if="candidate && !catalog && editingConfiguration" tw-class="pt-2">
            <ModelSelectorFileOptions :model-name="candidate.name" :choices="candidateChoices" :selected="candidateHintId" :disabled="disabled || active !== undefined" @select="chooseCandidateHint({ id: $event }); applyEditedConfiguration()">
              <template #action="{ choice }"><ModelSelectorVariantDownload :request="variantDownload({ id: choice.id })" :label="choice.label" :disabled="disabled || active !== undefined || destinationBusy || destinationUnavailable" :refresh-inventory="refreshInventory" /></template>
            </ModelSelectorFileOptions>
          </div>
          <p v-if="active" role="status" tw-class="px-1 py-2 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__fetching_configuration() }}</p>
          <p v-if="error" role="alert" tw-class="px-1 py-2 text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__could_not_check_repository() }}</p>
          <CspMessageHint v-if="error && failureContext === 'metadata'" :target="{ kind: 'huggingface-metadata' }" activity-for-display-only="model-information" presentation="error" />
          <ModelSelectorFileOptions v-if="catalog && variants.length && editingConfiguration" :model-name="catalog.repository" :choices="variants" :selected="mainPath" :disabled="disabled || active !== undefined" test-id="chat-repository-main-file" @select="mainPath = $event; applyEditedConfiguration()">
            <template #action="{ choice }"><ModelSelectorVariantDownload :request="variantDownload({ id: choice.id })" :label="choice.label" :disabled="disabled || active !== undefined || destinationBusy || destinationUnavailable" :refresh-inventory="refreshInventory" /></template>
          </ModelSelectorFileOptions>
          <div v-if="companionVariants.length && editingConfiguration" tw-class="border-t border-gray-100 pt-2 dark:border-gray-800">
            <div tw-class="flex items-center justify-between gap-3 px-2 py-1">
              <span tw-class="text-xs font-medium">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__multimodal() }}</span>
              <ToggleSwitch>
                <button type="button" role="switch" :aria-label="lazyStrings.LlamaCppBrowserRepositoryPicker__multimodal()" data-testid="chat-repository-multimodal" :aria-checked="multimodal === 'on'" :disabled="disabled || active !== undefined" @click="multimodal = multimodal === 'on' ? 'off' : 'on'; applyEditedConfiguration()" />
              </ToggleSwitch>
            </div>
            <div v-if="multimodal === 'on'" tw-class="mt-1">
              <p tw-class="px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__companion_files() }}</p>
              <ModelSelectorFileOptions :model-name="catalog?.repository ?? candidate?.name ?? ''" :choices="companionVariants" :selected="companionPath" :disabled="disabled || active !== undefined" test-id="chat-repository-companion-file" @select="companionPath = $event; applyEditedConfiguration()" />
            </div>
          </div>
          <div v-if="candidate" tw-class="my-2 flex flex-wrap items-center gap-2">
            <LlamaCppBrowserModelActionButton appearance="secondary" size="compact" data-testid="chat-inspect-suggested-configuration" :disabled="disabled || active !== undefined || candidateHint === undefined" @click="inspectCandidate"><GlobeIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelSelector__show_configuration() }}</LlamaCppBrowserModelActionButton>
            <button v-if="catalog && editingConfiguration" type="button" :disabled="active !== undefined" tw-class="rounded-lg px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800" @click="returnToCandidate">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__back_to_suggestions() }}</button>
          </div>
          <div v-if="candidateHint || (catalog && variants.length)" tw-class="space-y-2 border-t border-gray-100 pt-2 dark:border-gray-800">
            <LlamaCppBrowserDownloadDestination layout="compact" :view="downloadDestination.view" :disabled="disabled" :layout-file="catalog ? { repository: catalog.repository, path: mainPath } : undefined" :popup-target="popupTarget" />
            <p v-if="destinationFailure || (catalog && saved.status === 'unavailable')" role="status" tw-class="px-2 text-xs text-gray-500 dark:text-gray-400">{{ destination.kind === 'host' ? lazyStrings.LlamaCppBrowserDownloadDestination__reconnect_in_folder_settings() : lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p>
            <p v-if="firstUseSelection && (!candidateMode || !configurationSelected)" :title="lazyStrings.ModelSelector__download_before_first_use()" tw-class="px-1 text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSelector__downloads_automatically() }}</p>
          </div>
        </ModelSelectorConfiguration>
      </template>
    </component>
  </div>
  <div v-else data-testid="chat-repository-picker" tw-class="space-y-5 text-left">
    <LlamaCppBrowserHuggingFaceSearch v-show="catalog === undefined" v-model:input="input" :disabled="disabled || catalog !== undefined" :selection-status="active !== undefined ? 'loading' : 'idle'" direct-action="inspect" :input-error="undefined" scroll-owner="parent" @select="checkRepository({ value: $event, requestedVariant: undefined, freshness: 'reuse' })" />
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__could_not_check_repository() }}</p>
    <CspMessageHint v-if="error && failureContext === 'metadata'" :target="{ kind: 'huggingface-metadata' }" activity-for-display-only="model-information" presentation="error" />
    <section v-if="catalog" data-testid="chat-model-configuration" tw-class="space-y-4">
      <div tw-class="space-y-2">
        <button type="button" data-testid="chat-model-back-to-search" :disabled="disabled" tw-class="group -ml-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100" @click="catalog = undefined"><ArrowLeftIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transform-none" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__back_to_search() }}</button>
        <p data-testid="chat-model-repository-name" tw-class="break-words text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ catalog.repository }}</p>
      </div>
      <LlamaCppBrowserModelConfiguration v-model:quantization="mainPath" v-model:multimodal="multimodal" v-model:projector="companionPath" :choices="choices" :projectors="catalog.projectors" :disabled="disabled" :multimodal-description-id="undefined" />
      <div tw-class="space-y-3 border-t border-gray-100 pt-4 dark:border-gray-800">
        <div tw-class="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span v-if="bytes !== undefined" data-testid="chat-model-download-size" tw-class="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-gray-600 dark:text-gray-300"><HardDriveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />{{ formatDownloadBytes({ bytes }) }}</span>
          <span v-if="saved.status === 'saved'" data-testid="chat-model-saved" tw-class="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400"><CheckIcon aria-hidden="true" tw-class="h-3 w-3 text-blue-500 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__saved() }}</span>
        </div>
        <div data-testid="chat-model-destination-row" tw-class="grid grid-cols-1 items-center gap-y-2">
          <LlamaCppBrowserDownloadDestination layout="field" :view="downloadDestination.view" :disabled="disabled" :layout-file="{ repository: catalog.repository, path: mainPath }" />
        </div>
        <p v-if="destinationFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
        <p v-else-if="saved.status === 'unavailable'" role="status" data-testid="chat-model-destination-unavailable" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ destination.kind === 'host' ? lazyStrings.LlamaCppBrowserDownloadDestination__reconnect_in_folder_settings() : lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p>
        <LlamaCppBrowserModelActionButton data-testid="chat-use-repository-model" appearance="primary" size="large" :aria-busy="target !== undefined && !disabled && destinationPersistence !== 'failed' && saved.status === 'checking' || undefined" :disabled="disabled || destinationBusy || destinationUnavailable || target === undefined || (saved.status !== 'saved' && saved.status !== 'missing')" tw-class="w-full" @click="select({ presentation: 'close' })"><span tw-class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center gap-3"><span tw-class="col-start-2 min-w-0 text-center">{{ lazyStrings.SHARED__use_model_in_this_chat() }}</span><span aria-hidden="true" tw-class="flex h-6 w-6 items-center justify-center rounded-lg bg-gray-100/80 text-blue-500 transition-[background-color,color] duration-200 group-hover:bg-blue-100/80 group-hover:text-blue-600 dark:bg-gray-700/60 dark:text-blue-400 dark:group-hover:bg-blue-500/15 dark:group-hover:text-blue-300 motion-reduce:transition-none"><ArrowRightIcon tw-class="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transform-none" /></span></span></LlamaCppBrowserModelActionButton>
        <CspMessageHint v-if="saved.status === 'missing'" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" />
      </div>
    </section>
  </div>
</template>
