import { computed, onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from 'vue';
import type { ModelSelectorV2Model } from '@/components/ModelSelectorV2.vue';
import { cloneDownloadDestination } from '@/01-models/download';
import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { downloadJobKey, getDownloadQueue, type DownloadJob, type DownloadJobError, type DownloadJobStatus } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import type { ModelSuggestion, SuggestedQuantization } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { suggestionDownloadKey } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { installedSelection, parseModelReference } from '@/features/llama-cpp-browser/hugging-face/storage';
import { findLocalSuggestedModel, resolveSuggestionPlan } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import { repositoryUrlPath, type DownloadProgress, type DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import { confirmModelLaunchConfiguration, modelLaunchChoices } from '@/features/llama-cpp-browser/model-launch/target';
import { destinationKey, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { importLocalModelDirectories } from '@/features/llama-cpp-browser/logic/local-model-input';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import type { LocalModel, ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { inspectSpeechRecognitionCandidate } from '@/features/speech-cpp-browser/recognition/model-file';
import { speechRecognitionModelCatalog } from '@/features/speech-cpp-browser/recognition/model-catalog';
import { inspectStoredSpeechRecognitionModel, openStoredSpeechRecognitionModel } from '@/features/speech-cpp-browser/recognition/models';
import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { downloadFilesForDisplay } from '@/logic/hugging-face-download/presentation';
import { exactObject } from '@/utils/exact-object';
import type { useAudioTranscriptionPreferences } from './useAudioTranscriptionPreferences';

type Selection =
  | { kind: 'suggestion', suggestion: ModelSuggestion, quantization: SuggestedQuantization }
  | { kind: 'stored', model: LocalModel }
  | { kind: 'repository_reference', modelId: string, repository: string, variant: string }
  | { kind: 'repository', selection: DownloadSelection, intentKey: string | undefined };
type Entry = { id: string, label: string, description: string | undefined, selection: Selection };
type SuggestedEntry = Omit<Entry, 'selection'> & { selection: Extract<Selection, { kind: 'suggestion' }> };
type PinnedSelection = Extract<Selection, { kind: 'repository' }>;
type DownloadRequest = {
  prepared: DownloadSelection | undefined,
  intentKey: string | undefined,
  key: string,
  repository: string,
  source: DownloadJob['source'],
  destination: ModelDestination,
  prepare({ signal }: { signal: AbortSignal }): Promise<DownloadSelection>,
};
export type AudioTranscriptionModelDownloadState = { status: DownloadJobStatus, progress: DownloadProgress | undefined, error: DownloadJobError | undefined };
export type AudioTranscriptionQuantization = { id: string, label: string, filePath: string, bytes: number };
type QuantizationChoice = AudioTranscriptionQuantization & { pinned: PinnedSelection, installed: LocalModel | undefined };
export type AudioTranscriptionModelDetails =
  | { kind: 'huggingface', repository: string, repositoryUrl: string, revision: string | undefined, files: readonly { name: string, url: string, bytes: number }[] | undefined }
  | { kind: 'local', name: string, fileName: string | undefined, bytes: number };
export type AudioTranscriptionModelImport = {
  directories: Promise<ModelDirectoryInput[]>,
  controller: AbortController,
  save: 'browser' | 'later',
  repositoryLayout: 'confirmed',
};

/** Selection remains local until an explicit import, repository check or Run. */
export function useAudioTranscriptionModels({ preference }: { preference: { modelId: Readonly<Ref<string | undefined>>, rememberModel: ReturnType<typeof useAudioTranscriptionPreferences>['rememberModel'] } }) {
  const suggestions: SuggestedEntry[] = speechRecognitionModelCatalog.map(suggestion => ({
    id: `suggestion:${suggestion.id}`,
    label: suggestion.name,
    description: `${suggestion.developer} · ${suggestion.quantizationHints[0].preferredQuantization}`,
    selection: { kind: 'suggestion', suggestion, quantization: suggestion.quantizationHints[0] },
  }));
  const requestedId = ref<string | undefined>(suggestions[0]?.id);
  const stored = shallowRef<readonly LocalModel[]>([]);
  const repositories = shallowRef<readonly Entry[]>([]);
  const configurations = shallowRef<ReadonlyMap<string, PinnedSelection>>(new Map());
  const installedBindings = shallowRef<ReadonlyMap<string, string>>(new Map());
  const localNames = shallowRef<ReadonlyMap<string, string>>(new Map());
  const quantizationChoices = shallowRef<ReadonlyMap<string, readonly QuantizationChoice[]>>(new Map());
  const quantizationLabels = shallowRef<ReadonlyMap<string, string>>(new Map());
  const quantizationsActive = shallowRef<{ id: string, controller: AbortController }>();
  const quantizationsFailure = ref<'metadata'>();
  const backgroundFailures = shallowRef<ReadonlySet<string>>(new Set());
  const authorizingDownloads = shallowRef<ReadonlyMap<string, { key: string, destination: ModelDestination }>>(new Map());
  const failure = ref<'inventory' | 'import' | 'model'>();
  const importing = ref(false);
  const opening = ref(false);
  const refreshing = ref(false);
  const inventoryKnown = ref(false);
  const jobId = ref<number>();
  const queue = getDownloadQueue();
  const controllers = new Set<AbortController>();
  const lifetime = new AbortController();
  let scan: AbortController | undefined;
  let scanCompletion: Promise<void> | undefined;
  let disposed = false;
  let repositorySequence = 0;
  let pendingSelectionSaves = 0;
  const downloadDestination = useModelDownloadDestination({
    blocked: () => importing.value || opening.value,
    changed: () => {
      if (!disposed) {
        void refresh();
      }
    },
  });

  function storedSuggestion({ quantization }: { quantization: SuggestedQuantization }): LocalModel | undefined {
    const opfs = findLocalSuggestedModel({ quantization, models: stored.value, destination: { kind: 'opfs' } });
    if (opfs !== undefined) {
      return opfs;
    }
    for (const model of stored.value) {
      if (model.source === undefined) {
        continue;
      }
      const host = findLocalSuggestedModel({ quantization, models: stored.value, destination: { kind: 'host', directoryId: model.source.directoryId } });
      if (host !== undefined) {
        return host;
      }
    }
    return undefined;
  }

  function bindingKey({ pinned }: { pinned: PinnedSelection }): string {
    return selectionKey({ selection: pinned.selection });
  }

  function repositorySource({ selection }: { selection: Selection }): { repository: string } | undefined {
    switch (selection.kind) {
    case 'repository': return { repository: selection.selection.repository };
    case 'repository_reference': return { repository: selection.repository };
    case 'suggestion': return { repository: selection.quantization.hfRepository };
    case 'stored': {
      const model = selection.model;
      if (model.source !== undefined) {
        return { repository: model.source.repository };
      }
      if (model.modelId.startsWith('hf.co/')) {
        return { repository: parseModelReference({ modelId: model.modelId }).repository };
      }
      return undefined;
    }
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  }

  const sourceEntries = computed<readonly Entry[]>(() => [
    ...suggestions,
    ...repositories.value,
    ...stored.value.map(model => ({
      id: `stored:${model.modelId}`,
      label: model.modelId,
      description: model.source?.directoryName,
      selection: { kind: 'stored' as const, model },
    })),
  ]);
  const entryView = computed(() => {
    const entries: Entry[] = [];
    const aliases = new Map<string, string>();
    const localEntries = new Map<string, string>();
    for (const sourceEntry of sourceEntries.value) {
      const pinned = configurations.value.get(sourceEntry.id);
      const label = (() => {
        const original = sourceEntry.selection;
        switch (original.kind) {
        case 'stored': return pinned?.selection.repository ?? sourceEntry.label;
        case 'suggestion': case 'repository': case 'repository_reference': return sourceEntry.label;
        default: {
          const exhaustive: never = original;
          throw new Error(String(exhaustive));
        }
        }
      })();
      let entry: Entry = pinned === undefined ? sourceEntry : {
        ...sourceEntry,
        label,
        description: pinned.selection.files[0]?.path,
        selection: pinned,
      };
      const selection = entry.selection;
      const installed = (() => {
        switch (selection.kind) {
        case 'stored': return selection.model;
        case 'repository_reference': return stored.value.find(model => model.modelId === selection.modelId);
        case 'suggestion': return storedSuggestion({ quantization: selection.quantization });
        case 'repository': {
          const modelId = installedBindings.value.get(bindingKey({ pinned: selection }));
          return stored.value.find(model => model.modelId === modelId);
        }
        default: {
          const exhaustive: never = selection;
          throw new Error(String(exhaustive));
        }
        }
      })();
      if (installed !== undefined) {
        const existingId = localEntries.get(installed.modelId);
        if (existingId !== undefined && sourceEntry.selection.kind === 'stored' && pinned === undefined) {
          aliases.set(entry.id, existingId);
          continue;
        }
        if (existingId === undefined) {
          localEntries.set(installed.modelId, entry.id);
        }
        entry = { ...entry, selection: { kind: 'stored', model: installed } };
      }
      entries.push(entry);
    }
    return { entries, aliases };
  });
  const entries = computed(() => entryView.value.entries);
  const selectedId = computed(() => {
    const requested = requestedId.value;
    if (requested === undefined) {
      return undefined;
    }
    const id = entryView.value.aliases.get(requested) ?? requested;
    return entries.value.some(entry => entry.id === id) ? id : undefined;
  });
  const selectedEntry = computed(() => entries.value.find(entry => entry.id === selectedId.value));
  const selectedSourceEntry = computed(() => sourceEntries.value.find(entry => entry.id === selectedId.value));
  const models = computed<readonly ModelSelectorV2Model[]>(() => entries.value.map(entry => {
    const { id, label, description, selection, ...unhandledEntry } = entry;
    unhandledEntry satisfies Record<PropertyKey, never>;
    const availability = (() => {
      switch (selection.kind) {
      case 'stored': return 'local';
      case 'suggestion': case 'repository': case 'repository_reference': return inventoryKnown.value ? 'download_required' : 'checking';
      default: {
        const exhaustive: never = selection;
        throw new Error(String(exhaustive));
      }
      }
    })();
    return exactObject<ModelSelectorV2Model>()({ id, label, description, availability });
  }));
  const busy = computed(() => importing.value || opening.value);
  const progress = computed(() => queue.jobs.value.find(job => job.id === jobId.value)?.progress);
  const downloadStates = computed<ReadonlyMap<string, AudioTranscriptionModelDownloadState>>(() => {
    const states = new Map<string, AudioTranscriptionModelDownloadState>();
    for (const entry of entries.value) {
      const request = requestForId({ id: entry.id });
      if (request === undefined) {
        continue;
      }
      const localKey = `${entry.id}:${request.key}`;
      if (authorizingDownloads.value.get(entry.id)?.key === request.key) {
        states.set(entry.id, { status: 'resolving', progress: undefined, error: undefined });
        continue;
      }
      if (backgroundFailures.value.has(localKey)) {
        states.set(entry.id, { status: 'failed', progress: undefined, error: 'selection-unavailable' });
        continue;
      }
      const matching = [...queue.jobs.value].reverse().find(job => job.key === downloadJobKey({ key: request.key, destination: job.destination }) || request.prepared !== undefined && job.selection !== undefined && selectionKey({ selection: job.selection }) === selectionKey({ selection: request.prepared }));
      if (matching !== undefined) {
        states.set(entry.id, { status: matching.status, progress: matching.progress, error: matching.error });
      }
    }
    return states;
  });
  const selectedPinned = computed(() => {
    const entry = selectedSourceEntry.value;
    if (entry === undefined) {
      return undefined;
    }
    const configured = configurations.value.get(entry.id);
    if (configured !== undefined) {
      return configured;
    }
    const selection = entry.selection;
    switch (selection.kind) {
    case 'repository': return selection;
    case 'stored': case 'suggestion': case 'repository_reference': return undefined;
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  });
  const canInspectQuantizations = computed(() => selectedSourceEntry.value !== undefined && repositorySource({ selection: selectedPinned.value ?? selectedSourceEntry.value.selection }) !== undefined);
  const quantizationsBusy = computed(() => quantizationsActive.value?.id === selectedId.value && quantizationsActive.value !== undefined);
  const quantizations = computed<readonly AudioTranscriptionQuantization[]>(() => (selectedId.value === undefined ? [] : quantizationChoices.value.get(selectedId.value) ?? []).map(choice => {
    const { id, label, filePath, bytes, pinned: _pinned, installed: _installed, ...unhandled } = choice;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<AudioTranscriptionQuantization>()({ id, label, filePath, bytes });
  }));
  const selectedQuantizationId = computed(() => selectedPinned.value?.selection.files[0]?.path);
  const selectedQuantizationLabel = computed(() => {
    const entry = selectedSourceEntry.value;
    if (entry === undefined) {
      return undefined;
    }
    const pinned = selectedPinned.value;
    if (pinned !== undefined) {
      const label = quantizationLabels.value.get(selectionKey({ selection: pinned.selection }));
      if (label !== undefined) {
        return label;
      }
    }
    const selection = entry.selection;
    switch (selection.kind) {
    case 'suggestion': return pinned === undefined || pinned.intentKey === suggestionDownloadKey({ suggestionId: selection.suggestion.id, quantization: selection.quantization, multimodal: 'off' }) ? selection.quantization.preferredQuantization : undefined;
    case 'repository_reference': return selection.variant;
    case 'repository': case 'stored': return undefined;
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  });
  const selectedDetails = computed<AudioTranscriptionModelDetails | undefined>(() => {
    const entry = selectedSourceEntry.value;
    if (entry === undefined) {
      return undefined;
    }
    const pinned = selectedPinned.value;
    const source = repositorySource({ selection: pinned ?? entry.selection });
    if (source !== undefined) {
      const files = pinned === undefined ? undefined : downloadFilesForDisplay({
        files: pinned.selection.files.map(file => ({ ...file, repository: pinned.selection.repository, revision: pinned.selection.revision })),
        destination: downloadDestination.destination.value,
        rootName: undefined,
      }).map(file => {
        const { name, url, size, destination: _destination, completed: _completed, state: _state, ...unhandled } = file;
        unhandled satisfies Record<PropertyKey, never>;
        if (size === undefined) {
          throw new Error('A pinned model file requires its exact size');
        }
        return { name, url, bytes: size };
      });
      return { kind: 'huggingface', repository: source.repository, repositoryUrl: `https://huggingface.co/${repositoryUrlPath({ repository: source.repository })}`, revision: pinned?.selection.revision, files };
    }
    const selection = selectedEntry.value?.selection;
    switch (selection?.kind) {
    case 'stored': return { kind: 'local', name: entry.label, fileName: localNames.value.get(selection.model.modelId), bytes: selection.model.size };
    case 'suggestion': case 'repository': case 'repository_reference': case undefined: return undefined;
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  });

  function modelIdForSelection({ selection }: { selection: Selection | undefined }): string | undefined {
    switch (selection?.kind) {
    case 'suggestion': return `hf.co/${selection.quantization.hfRepository}:${selection.quantization.preferredQuantization}`;
    case 'stored': return selection.model.modelId;
    case 'repository_reference': return selection.modelId;
    case 'repository': {
      const file = selection.selection.files[0];
      return file === undefined ? undefined : formatHuggingFaceModelId({ repository: selection.selection.repository, mainFilePath: file.path });
    }
    case undefined: return undefined;
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  }
  const selectedModelId = computed(() => modelIdForSelection({ selection: selectedEntry.value?.selection }));

  function saveSelection(): void {
    const modelId = selectedModelId.value;
    if (pendingSelectionSaves === 0 && modelId === preference.modelId.value) {
      return;
    }
    pendingSelectionSaves++;
    void preference.rememberModel({ modelId }).catch(() => {}).finally(() => {
      pendingSelectionSaves--;
    });
  }

  function select({ id }: { id: string | undefined }): void {
    if (!busy.value && (id === undefined || sourceEntries.value.some(entry => entry.id === id))) {
      quantizationsActive.value?.controller.abort();
      requestedId.value = id;
      failure.value = undefined;
      quantizationsFailure.value = undefined;
      saveSelection();
    }
  }

  async function inspectSelectedQuantizations({ signal: requestedSignal }: { signal: AbortSignal }): Promise<void> {
    const entry = selectedSourceEntry.value;
    if (busy.value || disposed || entry === undefined) {
      return;
    }
    const currentPinned = selectedPinned.value;
    const source = repositorySource({ selection: currentPinned ?? entry.selection });
    if (source === undefined) {
      return;
    }
    quantizationsActive.value?.controller.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([requestedSignal, controller.signal, lifetime.signal]);
    quantizationsActive.value = { id: entry.id, controller };
    quantizationsFailure.value = undefined;
    try {
      signal.throwIfAborted();
      // Only the explicit metadata action calls this method. The selector's
      // open, input, details disclosure and ordinary selection never call it.
      const catalog = await awaitInspection({ task: getMetadataSession().inspect({ input: source.repository, signal, freshness: 'reuse' }), signal });
      signal.throwIfAborted();
      if (catalog.repository.toLowerCase() !== source.repository.toLowerCase()) {
        throw new Error('The selected model repository changed');
      }
      const suggested = (() => {
        const selection = entry.selection;
        switch (selection.kind) {
        case 'suggestion': {
          try {
            return { selection: resolveSuggestionPlan({ quantization: selection.quantization, catalog, multimodal: 'off' }), key: suggestionDownloadKey({ suggestionId: selection.suggestion.id, quantization: selection.quantization, multimodal: 'off' }) };
          } catch {
            return undefined;
          }
        }
        case 'stored': case 'repository': case 'repository_reference': return undefined;
        default: {
          const exhaustive: never = selection;
          throw new Error(String(exhaustive));
        }
        }
      })();
      const choices: QuantizationChoice[] = [];
      for (const choice of modelLaunchChoices({ catalog })) {
        const model = choice.models[0];
        if (choice.models.length !== 1 || model?.files.length !== 1) {
          continue;
        }
        const target = (() => {
          try {
            return confirmModelLaunchConfiguration({ catalog, mainFilePath: choice.primaryRelativePath, companionFilePath: undefined, multimodal: 'off' });
          } catch {
            return undefined;
          }
        })();
        if (target === undefined) {
          continue;
        }
        const pinned: PinnedSelection = { kind: 'repository', selection: target.selection, intentKey: suggested !== undefined && selectionKey({ selection: suggested.selection }) === selectionKey({ selection: target.selection }) ? suggested.key : undefined };
        const installed = await locallyInstalled({ selection: target.selection, signal });
        signal.throwIfAborted();
        choices.push({ id: choice.primaryRelativePath, label: choice.quantization ?? choice.label, filePath: choice.primaryRelativePath, bytes: model.size, pinned, installed: installed !== undefined && stored.value.some(local => local.modelId === installed.modelId) ? installed : undefined });
      }
      if (disposed || selectedId.value !== entry.id || quantizationsActive.value?.controller !== controller) {
        return;
      }
      quantizationChoices.value = new Map(quantizationChoices.value).set(entry.id, choices);
      const labels = new Map(quantizationLabels.value);
      for (const choice of choices) {
        labels.set(selectionKey({ selection: choice.pinned.selection }), choice.label);
      }
      quantizationLabels.value = labels;
      const initialPath = (() => {
        if (currentPinned !== undefined) {
          return currentPinned.selection.files[0]?.path;
        }
        const selection = entry.selection;
        switch (selection.kind) {
        case 'suggestion': return suggested?.selection.files[0]?.path;
        case 'repository': return selection.selection.files[0]?.path;
        case 'repository_reference': return choices.find(choice => modelIdForSelection({ selection: choice.pinned }) === selection.modelId)?.filePath;
        case 'stored': {
          const matching = choices.filter(choice => choice.installed?.modelId === selection.model.modelId);
          return matching.length === 1 ? matching[0]?.id : undefined;
        }
        default: {
          const exhaustive: never = selection;
          throw new Error(String(exhaustive));
        }
        }
      })();
      // Pin the already selected bundled variant after metadata confirms it;
      // checking metadata never switches to a different quantization by rank.
      if (currentPinned === undefined && initialPath !== undefined) {
        selectQuantization({ id: initialPath });
      }
    } catch {
      if (!signal.aborted && !disposed && selectedId.value === entry.id) {
        quantizationsFailure.value = 'metadata';
      }
    } finally {
      if (quantizationsActive.value?.controller === controller) {
        quantizationsActive.value = undefined;
      }
    }
  }

  function selectQuantization({ id }: { id: string }): void {
    const entryId = selectedId.value;
    const choice = entryId === undefined ? undefined : quantizationChoices.value.get(entryId)?.find(choice => choice.id === id);
    if (busy.value || disposed || entryId === undefined || choice === undefined) {
      return;
    }
    requestedId.value = entryId;
    configurations.value = new Map(configurations.value).set(entryId, choice.pinned);
    if (choice.installed !== undefined && stored.value.some(model => model.modelId === choice.installed?.modelId)) {
      installedBindings.value = new Map(installedBindings.value).set(bindingKey({ pinned: choice.pinned }), choice.installed.modelId);
    }
    quantizationsFailure.value = undefined;
    failure.value = undefined;
    saveSelection();
  }

  async function locallyInstalled({ selection, signal }: { selection: DownloadSelection, signal: AbortSignal }): Promise<LocalModel | undefined> {
    const primary = selection.files[0];
    if (primary === undefined || selection.files.length !== 1) {
      return undefined;
    }
    const modelId = formatHuggingFaceModelId({ repository: selection.repository, mainFilePath: primary.path });
    const checked = new Set<string>();
    for (const local of stored.value) {
      const destination: ModelDestination | undefined = local.source === undefined
        ? local.modelId === modelId ? { kind: 'opfs' } : undefined
        : local.source.repository.toLowerCase() === selection.repository.toLowerCase() && local.source.primaryRelativePath === primary.path ? { kind: 'host', directoryId: local.source.directoryId } : undefined;
      if (destination === undefined || checked.has(destinationKey({ destination }))) {
        continue;
      }
      checked.add(destinationKey({ destination }));
      try {
        const installed = await awaitInspection({ task: installedSelection({ selection, destination }), signal });
        if (installed !== undefined && stored.value.some(model => model.modelId === installed.modelId)) {
          return installed;
        }
      } catch {
        // A disconnected saved folder does not remove remote file choices.
        signal.throwIfAborted();
      }
    }
    return undefined;
  }

  async function capturedLocalModel({ selection, signal }: { selection: Selection, signal: AbortSignal }): Promise<LocalModel | undefined> {
    while (scan !== undefined && scanCompletion !== undefined) {
      const current = scan;
      try {
        await awaitInspection({ task: scanCompletion, signal: AbortSignal.any([signal, current.signal]) });
      } catch {
        // A replacement scan supersedes the aborted one. Cancellation of this
        // action stops waiting without aborting inventory for other actions.
        signal.throwIfAborted();
      }
    }
    signal.throwIfAborted();
    switch (selection.kind) {
    case 'stored': return selection.model;
    case 'repository_reference': return stored.value.find(model => model.modelId === selection.modelId);
    case 'suggestion': return storedSuggestion({ quantization: selection.quantization });
    case 'repository': {
      const model = await locallyInstalled({ selection: selection.selection, signal });
      signal.throwIfAborted();
      if (model !== undefined) {
        installedBindings.value = new Map(installedBindings.value).set(bindingKey({ pinned: selection }), model.modelId);
      }
      return model;
    }
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  }

  function downloadRequest({ selection, destination }: { selection: Exclude<Selection, { kind: 'stored' }>, destination: ModelDestination }): DownloadRequest {
    switch (selection.kind) {
    case 'repository': return {
      prepared: selection.selection,
      intentKey: selection.intentKey,
      key: selection.intentKey ?? selectionKey({ selection: selection.selection }),
      repository: selection.selection.repository,
      source: 'repository',
      destination,
      prepare: async () => selection.selection,
    };
    case 'repository_reference': return {
      prepared: undefined,
      intentKey: selection.modelId,
      key: selection.modelId,
      repository: selection.repository,
      source: 'repository',
      destination,
      prepare: async ({ signal }) => {
        const catalog = await getMetadataSession().inspect({ input: selection.repository, signal, freshness: 'reuse' });
        const matches = catalog.models.filter(model => model.files.length === 1 && formatHuggingFaceModelId({ repository: catalog.repository, mainFilePath: model.files[0]!.path }) === selection.modelId);
        const match = matches.length === 1 ? matches[0]?.files[0] : undefined;
        if (match === undefined) {
          throw new Error('The saved speech recognition variant is no longer available');
        }
        return confirmModelLaunchConfiguration({ catalog, mainFilePath: match.path, companionFilePath: undefined, multimodal: 'off' }).selection;
      },
    };
    case 'suggestion': {
      const key = suggestionDownloadKey({ suggestionId: selection.suggestion.id, quantization: selection.quantization, multimodal: 'off' });
      return {
        prepared: undefined,
        intentKey: key,
        key,
        repository: selection.quantization.hfRepository,
        source: 'suggestion',
        destination,
        prepare: async ({ signal }) => {
          const catalog = await getMetadataSession().inspect({ input: selection.quantization.hfRepository, signal, freshness: 'reuse' });
          const resolved = resolveSuggestionPlan({ quantization: selection.quantization, catalog, multimodal: 'off' });
          if (resolved.files.length !== 1) {
            throw new Error('Recognition requires one complete model file');
          }
          return resolved;
        },
      };
    }
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  }

  function requestForId({ id }: { id: string }): DownloadRequest | undefined {
    const entry = sourceEntries.value.find(entry => entry.id === id);
    const selection = configurations.value.get(id) ?? entry?.selection;
    switch (selection?.kind) {
    case 'suggestion': case 'repository': case 'repository_reference': return downloadRequest({ selection, destination: downloadDestination.destination.value });
    case 'stored': case undefined: return undefined;
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  }

  async function backgroundDownload({ id }: { id: string }): Promise<void> {
    const entry = entries.value.find(entry => entry.id === id);
    const request = requestForId({ id });
    if (disposed || entry === undefined || request === undefined) {
      return;
    }
    switch (entry.selection.kind) {
    case 'stored': return;
    case 'suggestion': case 'repository': case 'repository_reference': break;
    default: {
      const exhaustive: never = entry.selection;
      throw new Error(String(exhaustive));
    }
    }
    const { prepared, intentKey, ...download } = request;
    const destination = cloneDownloadDestination({ destination: download.destination });
    const currentAuthorization = authorizingDownloads.value.get(id);
    if (currentAuthorization?.key === request.key && destinationKey({ destination: currentAuthorization.destination }) === destinationKey({ destination })) {
      return;
    }
    const authorization = { key: request.key, destination };
    authorizingDownloads.value = new Map(authorizingDownloads.value).set(id, authorization);
    const localKey = `${id}:${request.key}`;
    backgroundFailures.value = new Set([...backgroundFailures.value].filter(key => key !== localKey));
    try {
      if (await capturedLocalModel({ selection: entry.selection, signal: lifetime.signal }) !== undefined) {
        return;
      }
      const authorized = await downloadDestination.authorize({ destination });
      // Authorization owns the captured destination even if this view closes
      // or another selector changes the shared preference while it waits.
      const job = queue.enqueue({ ...download, destination: authorized.destination, expectedRoot: authorized.expectedRoot });
      if (authorizingDownloads.value.get(id) === authorization) {
        const updated = new Map(authorizingDownloads.value);
        updated.delete(id);
        authorizingDownloads.value = updated;
      }
      // The queue owns this transfer. This view neither selects this model nor
      // keeps a worker/runtime mounted to download it in the background.
      const result = await job.done;
      if (disposed || result.status !== 'complete' || result.selection === undefined) {
        return;
      }
      if (prepared !== undefined && selectionKey({ selection: prepared }) !== selectionKey({ selection: result.selection })) {
        throw new Error('The completed download differs from the pinned file selection');
      }
      const pinned: PinnedSelection = { kind: 'repository', selection: result.selection, intentKey };
      if (pinned.selection.files.length !== 1) {
        throw new Error('Recognition requires one complete model file');
      }
      const installed = await awaitInspection({ task: installedSelection({ selection: result.selection, destination: result.destination, expectedRoot: authorized.expectedRoot }), signal: lifetime.signal });
      if (installed === undefined) {
        throw new Error('Downloaded speech recognition model is unavailable');
      }
      const candidate = await inspectStoredSpeechRecognitionModel({ modelId: installed.modelId, signal: lifetime.signal });
      lifetime.signal.throwIfAborted();
      switch (candidate.kind) {
      case 'other': throw new Error('Downloaded model does not support speech recognition');
      case 'recognition': break;
      default: {
        const exhaustive: never = candidate;
        throw new Error(String(exhaustive));
      }
      }
      stored.value = [...stored.value.filter(model => model.modelId !== installed.modelId), installed];
      localNames.value = new Map(localNames.value).set(installed.modelId, candidate.info.name);
      installedBindings.value = new Map(installedBindings.value).set(bindingKey({ pinned }), installed.modelId);
      const current = requestForId({ id });
      if (current?.key === request.key) {
        configurations.value = new Map(configurations.value).set(id, pinned);
      }
    } catch {
      if (!disposed) {
        backgroundFailures.value = new Set(backgroundFailures.value).add(localKey);
      }
    } finally {
      if (authorizingDownloads.value.get(id) === authorization) {
        const updated = new Map(authorizingDownloads.value);
        updated.delete(id);
        authorizingDownloads.value = updated;
      }
    }
  }

  async function refresh(): Promise<void> {
    scan?.abort();
    const controller = new AbortController();
    scan = controller;
    const completion = Promise.withResolvers<void>();
    scanCompletion = completion.promise;
    refreshing.value = true;
    try {
      const inventory = await listModelInventory({ signal: controller.signal });
      const recognized: LocalModel[] = [];
      const names = new Map<string, string>();
      for (const model of inventory) {
        controller.signal.throwIfAborted();
        try {
          const candidate = await inspectStoredSpeechRecognitionModel({ modelId: model.modelId, signal: controller.signal });
          switch (candidate.kind) {
          case 'recognition': recognized.push(model);
            names.set(model.modelId, candidate.info.name);
            break;
          case 'other': break;
          default: {
            const exhaustive: never = candidate;
            throw new Error(String(exhaustive));
          }
          }
        } catch {
          // Other runtime formats and unreadable entries are not ASR choices.
          controller.signal.throwIfAborted();
        }
      }
      controller.signal.throwIfAborted();
      if (!disposed && scan === controller) {
        stored.value = recognized;
        inventoryKnown.value = true;
        localNames.value = names;
        const previousFailure = failure.value;
        switch (previousFailure) {
        case 'inventory': failure.value = undefined;
          break;
        case 'import': case 'model': case undefined: break;
        default: {
          const exhaustive: never = previousFailure;
          throw new Error(String(exhaustive));
        }
        }
      }
    } catch {
      if (!controller.signal.aborted && !disposed) {
        failure.value = 'inventory';
      }
    } finally {
      if (scan === controller) {
        scan = undefined;
        scanCompletion = undefined;
        refreshing.value = false;
      }
      completion.resolve();
    }
  }

  async function importModels({ directories, controller, save, repositoryLayout: _repositoryLayout }: { directories: AudioTranscriptionModelImport['directories'], controller: AbortController, save: 'browser' | 'later', repositoryLayout: 'confirmed' }): Promise<void> {
    if (busy.value || disposed) {
      controller.abort();
      return;
    }
    controllers.add(controller);
    importing.value = true;
    failure.value = undefined;
    try {
      const captured = await directories;
      controller.signal.throwIfAborted();
      // Reject split models and companions before registering a local source.
      for (const directory of captured) {
        const ggufs = directory.files.filter(entry => /\.gguf$/i.test(entry.relativePath));
        const primary = ggufs[0];
        if (ggufs.length !== 1 || primary === undefined || (await inspectSpeechRecognitionCandidate({ file: primary.file, name: primary.file.name, signal: controller.signal })).kind !== 'recognition') {
          throw new Error('Choose a single complete speech recognition GGUF');
        }
      }
      const imported = await importLocalModelDirectories({ directories: captured, signal: controller.signal, save });
      controller.signal.throwIfAborted();
      const recognized: LocalModel[] = [];
      const names = new Map(localNames.value);
      for (const model of imported) {
        const candidate = await inspectStoredSpeechRecognitionModel({ modelId: model.modelId, signal: controller.signal });
        switch (candidate.kind) {
        case 'recognition': recognized.push(model);
          names.set(model.modelId, candidate.info.name);
          break;
        case 'other': break;
        default: {
          const exhaustive: never = candidate;
          throw new Error(String(exhaustive));
        }
        }
      }
      controller.signal.throwIfAborted();
      const first = recognized[0];
      if (first === undefined) {
        throw new Error('No speech recognition model was imported');
      }
      stored.value = [...stored.value.filter(previous => !recognized.some(model => model.modelId === previous.modelId)), ...recognized];
      localNames.value = names;
      quantizationsActive.value?.controller.abort();
      requestedId.value = `stored:${first.modelId}`;
      saveSelection();
    } catch {
      if (!controller.signal.aborted && !disposed) {
        failure.value = 'import';
      }
    } finally {
      controllers.delete(controller);
      importing.value = false;
    }
  }

  function repositoryEntryId({ selection }: { selection: DownloadSelection }): string {
    const existing = repositories.value.find(entry => entry.selection.kind === 'repository' && selectionKey({ selection: entry.selection.selection }) === selectionKey({ selection }));
    if (existing !== undefined) {
      return existing.id;
    }
    const id = `repository:${++repositorySequence}`;
    repositories.value = [...repositories.value, { id, label: selection.repository, description: selection.files[0]?.path, selection: { kind: 'repository', selection, intentKey: undefined } }];
    return id;
  }

  function addRepositoryModel({ selection }: { selection: DownloadSelection }): void {
    if (!busy.value && !disposed && selection.files.length === 1) {
      select({ id: repositoryEntryId({ selection }) });
    }
  }

  async function openSelected({ signal: requestedSignal }: { signal: AbortSignal }): Promise<{ modelId: string, file: File }> {
    const signal = AbortSignal.any([requestedSignal, lifetime.signal]);
    signal.throwIfAborted();
    const entry = entries.value.find(entry => entry.id === selectedId.value);
    if (busy.value || disposed || entry === undefined) {
      throw new Error('Select an available speech recognition model');
    }
    const destination = cloneDownloadDestination({ destination: downloadDestination.destination.value });
    opening.value = true;
    failure.value = undefined;
    jobId.value = undefined;
    try {
      const local = await capturedLocalModel({ selection: entry.selection, signal });
      const selection: Selection = local === undefined ? entry.selection : { kind: 'stored', model: local };
      let modelId: string;
      let newlyInstalled: LocalModel | undefined;
      let openedPinned: PinnedSelection | undefined;
      switch (selection.kind) {
      case 'stored': modelId = selection.model.modelId;
        break;
      case 'suggestion':
      case 'repository_reference':
      case 'repository': {
        const request = downloadRequest({ selection, destination });
        const { prepared, intentKey, ...download } = request;
        let installed = prepared === undefined ? undefined : await locallyInstalled({ selection: prepared, signal }) ?? await installedSelection({ selection: prepared, destination });
        openedPinned = prepared === undefined ? undefined : { kind: 'repository', selection: prepared, intentKey };
        signal.throwIfAborted();
        if (installed === undefined) {
          // Run is the explicit authorization for metadata and model download.
          const authorized = await awaitInspection({ task: downloadDestination.authorize({ destination }), signal });
          signal.throwIfAborted();
          const job = queue.enqueue({
            ...download,
            destination: authorized.destination,
            expectedRoot: authorized.expectedRoot,
          });
          jobId.value = job.id;
          // Leaving this view stops this run's wait. The shared download remains
          // available in the existing download manager and to other consumers.
          const result: DownloadJob = await awaitInspection({ task: job.done, signal });
          signal.throwIfAborted();
          if (result.status !== 'complete' || result.selection === undefined) {
            throw new Error('Speech recognition model download did not complete');
          }
          if (prepared !== undefined && selectionKey({ selection: prepared }) !== selectionKey({ selection: result.selection })) {
            throw new Error('The completed download differs from the pinned file selection');
          }
          installed = await installedSelection({ selection: result.selection, destination: result.destination, expectedRoot: authorized.expectedRoot });
          openedPinned = { kind: 'repository', selection: result.selection, intentKey };
        }
        signal.throwIfAborted();
        if (installed === undefined) {
          throw new Error('Downloaded speech recognition model is unavailable');
        }
        modelId = installed.modelId;
        newlyInstalled = installed;
        break;
      }
      default: {
        const exhaustive: never = selection;
        throw new Error(String(exhaustive));
      }
      }
      const file = await openStoredSpeechRecognitionModel({ modelId, signal });
      signal.throwIfAborted();
      if (newlyInstalled !== undefined) {
        stored.value = [...stored.value.filter(model => model.modelId !== modelId), newlyInstalled];
        if (openedPinned !== undefined) {
          configurations.value = new Map(configurations.value).set(entry.id, openedPinned);
          installedBindings.value = new Map(installedBindings.value).set(bindingKey({ pinned: openedPinned }), modelId);
        }
      }
      return { modelId, file };
    } catch (error) {
      if (!signal.aborted && !disposed) {
        failure.value = 'model';
      }
      throw error;
    } finally {
      opening.value = false;
      jobId.value = undefined;
    }
  }

  async function openSelectedLocal({ signal: requestedSignal }: { signal: AbortSignal }): Promise<{ modelId: string, file: File } | undefined> {
    const selection = selectedEntry.value?.selection;
    if (busy.value || disposed || selection === undefined) {
      return undefined;
    }
    const signal = AbortSignal.any([requestedSignal, lifetime.signal]);
    const local = await capturedLocalModel({ selection, signal });
    if (local === undefined) {
      return undefined;
    }
    const file = await openStoredSpeechRecognitionModel({ modelId: local.modelId, signal });
    signal.throwIfAborted();
    return { modelId: local.modelId, file };
  }

  watch(preference.modelId, modelId => {
    if (pendingSelectionSaves > 0) {
      return;
    }
    if (modelId === undefined) {
      requestedId.value = suggestions[0]?.id;
      return;
    }
    const catalog = suggestions.find(entry => modelIdForSelection({ selection: entry.selection }) === modelId);
    if (catalog !== undefined) {
      requestedId.value = catalog.id;
      return;
    }
    requestedId.value = `stored:${modelId}`;
    if (modelId.startsWith('hf.co/')) {
      try {
        const { repository, variant } = parseModelReference({ modelId });
        if (variant === undefined || variant === '') {
          return;
        }
        const id = `reference:${modelId}`;
        if (!repositories.value.some(entry => entry.id === id)) {
          repositories.value = [...repositories.value, { id, label: repository, description: variant, selection: { kind: 'repository_reference', modelId, repository, variant } }];
        }
        requestedId.value = id;
      } catch {
        // The chooser remains unselected if a saved reference is unreadable.
      }
    }
  }, { immediate: true, flush: 'sync' });

  const unsubscribe = llamaCppBrowserModelFiles.subscribeModelList({
    listener: () => {
      void refresh();
    },
  });
  void refresh();
  onScopeDispose(() => {
    disposed = true;
    lifetime.abort();
    scan?.abort();
    unsubscribe();
    for (const controller of controllers) {
      controller.abort();
    }
  });

  return {
    models,
    selectedId: readonly(selectedId),
    selectedModelId,
    select,
    refresh,
    refreshing: readonly(refreshing),
    openSelected,
    openSelectedLocal,
    importModels,
    addRepositoryModel,
    backgroundDownload,
    downloadStates,
    downloadDestination,
    quantizations,
    selectedQuantizationId,
    selectedQuantizationLabel,
    canInspectQuantizations,
    quantizationsBusy,
    quantizationsFailure: readonly(quantizationsFailure),
    inspectSelectedQuantizations,
    selectQuantization,
    selectedDetails,
    busy,
    progress,
    failure: readonly(failure),
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
