import type { LocalModelImportRequest } from '@/features/llama-cpp-browser/logic/local-model-input';
import { computed, onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from 'vue';
import type { ModelSelectorItem } from '@/components/model-selector-item';
import { cloneDownloadDestination } from '@/01-models/download';
import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { downloadJobKey, findModelDownloadJob, getDownloadQueue, type DownloadJob, type DownloadJobError, type DownloadJobStatus } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import type { SuggestedQuantization } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
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
import { speechRecognitionModelCatalog, type SpeechRecognitionModelSuggestion } from '@/features/speech-cpp-browser/recognition/model-catalog';
import { inspectStoredSpeechRecognitionModel, openStoredSpeechRecognitionModel } from '@/features/speech-cpp-browser/recognition/models';
import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { downloadFilesForDisplay } from '@/logic/hugging-face-download/presentation';
import { exactObject } from '@/utils/exact-object';
import type { useAudioTranscriptionPreferences } from './useAudioTranscriptionPreferences';

type Selection =
  | { kind: 'suggestion', suggestion: SpeechRecognitionModelSuggestion, quantization: SpeechRecognitionModelSuggestion['quantizationHints'][number] }
  | { kind: 'stored', model: LocalModel }
  | { kind: 'repository_reference', modelId: string, repository: string, variant: string }
  | { kind: 'repository', selection: DownloadSelection, intentKey: string | undefined };
type Entry = { id: string, label: string, description: string | undefined, selection: Selection };
type UnverifiedStoredModel = { model: LocalModel, compatibility: 'unmatched' | 'unconfirmed' };
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
export type AudioTranscriptionPickerModel = ModelSelectorItem & {
  modelId: string | undefined,
  compatibility: UnverifiedStoredModel['compatibility'] | undefined,
};
type QuantizationChoice = AudioTranscriptionQuantization & { pinned: PinnedSelection, installed: LocalModel | undefined };
export type AudioTranscriptionModelDetails =
  | { kind: 'huggingface', repository: string, repositoryUrl: string, revision: string | undefined, files: readonly { name: string, url: string, bytes: number }[] | undefined }
  | { kind: 'local', name: string, fileName: string | undefined, bytes: number };

/** Selection remains local until an explicit import, repository check or Run. */
export function useAudioTranscriptionModels({ preference }: { preference: { modelId: Readonly<Ref<string | undefined>>, rememberModel: ReturnType<typeof useAudioTranscriptionPreferences>['rememberModel'] } }) {
  const suggestions: SuggestedEntry[] = speechRecognitionModelCatalog.map(suggestion => ({
    id: `suggestion:${suggestion.id}`,
    label: suggestion.name,
    description: `${suggestion.developer} · ${suggestion.quantizationHints[0].preferredQuantization}`,
    selection: { kind: 'suggestion', suggestion, quantization: suggestion.quantizationHints[0] },
  }));
  const activeHintIds = shallowRef<ReadonlyMap<string, string>>(new Map());
  const requestedId = ref<string | undefined>(suggestions[0]?.id);
  const stored = shallowRef<readonly LocalModel[]>([]);
  const unverifiedStored = shallowRef<readonly UnverifiedStoredModel[]>([]);
  const unverifiedById = computed(() => {
    const recognized = new Set(stored.value.map(model => model.modelId));
    return new Map(unverifiedStored.value.filter(entry => !recognized.has(entry.model.modelId)).map(entry => [entry.model.modelId, entry]));
  });
  const repositories = shallowRef<readonly Entry[]>([]);
  const checkingRepositories = shallowRef<ReadonlySet<string>>(new Set());
  const configurations = shallowRef<ReadonlyMap<string, PinnedSelection>>(new Map());
  const installedBindings = shallowRef<ReadonlyMap<string, string>>(new Map());
  const localNames = shallowRef<ReadonlyMap<string, string>>(new Map());
  const quantizationChoices = shallowRef<ReadonlyMap<string, readonly QuantizationChoice[]>>(new Map());
  const quantizationLabels = shallowRef<ReadonlyMap<string, string>>(new Map());
  const quantizationsActive = shallowRef<{ id: string, controller: AbortController }>();
  const quantizationsFailure = ref<'metadata'>();
  const backgroundFailures = shallowRef<ReadonlySet<string>>(new Set());
  const authorizingDownloads = shallowRef<ReadonlyMap<string, { key: string, destination: ModelDestination, controller: AbortController }>>(new Map());
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
    ...suggestions.map(entry => {
      const quantization = entry.selection.suggestion.quantizationHints.find(hint => hint.id === activeHintIds.value.get(entry.id));
      return quantization === undefined ? entry : {
        ...entry,
        description: `${entry.selection.suggestion.developer} · ${quantization.preferredQuantization}`,
        selection: { ...entry.selection, quantization },
      };
    }),
    ...repositories.value,
    ...[...stored.value, ...Array.from(unverifiedById.value.values(), entry => entry.model)].map(model => ({
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
        case 'repository_reference': return stored.value.find(model => model.modelId === selection.modelId) ?? unverifiedById.value.get(selection.modelId)?.model;
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
  const pickerModels = computed<readonly AudioTranscriptionPickerModel[]>(() => entries.value.map(entry => {
    const { id, label, description, selection, ...unhandledEntry } = entry;
    unhandledEntry satisfies Record<PropertyKey, never>;
    const availability = (() => {
      switch (selection.kind) {
      case 'stored': return 'local';
      case 'suggestion': case 'repository_reference': return inventoryKnown.value ? 'download_required' : 'checking';
      case 'repository': return inventoryKnown.value && !checkingRepositories.value.has(id) ? 'download_required' : 'checking';
      default: {
        const exhaustive: never = selection;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const compatibility = (() => {
      switch (selection.kind) {
      case 'stored': return unverifiedById.value.get(selection.model.modelId)?.compatibility;
      case 'suggestion': case 'repository_reference': case 'repository': return undefined;
      default: throw new Error(String(selection satisfies never));
      }
    })();
    return exactObject<AudioTranscriptionPickerModel>()({ id, label, description, availability, compatibility, modelId: modelIdForSelection({ selection }) });
  }));
  const models = computed(() => pickerModels.value.filter(model => model.compatibility === undefined));
  const busy = computed(() => importing.value || opening.value);
  const progress = computed(() => queue.jobs.value.find(job => job.id === jobId.value)?.progress);
  const downloadStates = computed<ReadonlyMap<string, AudioTranscriptionModelDownloadState>>(() => {
    const states = new Map<string, AudioTranscriptionModelDownloadState>();
    for (const entry of entries.value) {
      const request = requestForId({ id: entry.id });
      if (request === undefined) {
        continue;
      }
      const localKey = `${entry.id}:${downloadJobKey({ key: request.key, destination: request.destination })}`;
      if (currentDownloadAuthorization({ id: entry.id, request }) !== undefined) {
        states.set(entry.id, { status: 'resolving', progress: undefined, error: undefined });
        continue;
      }
      if (backgroundFailures.value.has(localKey)) {
        states.set(entry.id, { status: 'failed', progress: undefined, error: 'selection-unavailable' });
        continue;
      }
      const matching = queuedDownload({ request });
      if (matching !== undefined) {
        states.set(entry.id, { status: matching.status, progress: matching.progress, error: matching.error });
      }
    }
    return states;
  });
  function pinnedForEntry({ entry }: { entry: Entry | undefined }): PinnedSelection | undefined {
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
  }
  const selectedPinned = computed(() => pinnedForEntry({ entry: selectedSourceEntry.value }));
  const canInspectQuantizations = computed(() => selectedSourceEntry.value !== undefined && repositorySource({ selection: selectedPinned.value ?? selectedSourceEntry.value.selection }) !== undefined);
  const quantizationsBusy = computed(() => quantizationsActive.value?.id === selectedId.value && quantizationsActive.value !== undefined);
  function quantizationsForModel({ id }: { id: string | undefined }): readonly AudioTranscriptionQuantization[] {
    if (id === undefined) {
      return [];
    }
    const verified = quantizationChoices.value.get(id);
    if (verified === undefined) {
      const selection = sourceEntries.value.find(entry => entry.id === id)?.selection;
      switch (selection?.kind) {
      case 'suggestion': return selection.suggestion.quantizationHints.map(hint => ({
        id: `suggestion:${hint.id}`,
        label: hint.preferredQuantization,
        filePath: hint.fileName,
        bytes: hint.approximateModelBytes,
      }));
      case 'stored': case 'repository_reference': case 'repository': case undefined: return [];
      default: throw new Error(String(selection satisfies never));
      }
    }
    return verified.map(choice => {
      const { id, label, filePath, bytes, pinned: _pinned, installed: _installed, ...unhandled } = choice;
      unhandled satisfies Record<PropertyKey, never>;
      return exactObject<AudioTranscriptionQuantization>()({ id, label, filePath, bytes });
    });
  }
  const quantizations = computed(() => quantizationsForModel({ id: selectedId.value }));
  const selectedQuantizationId = computed(() => {
    const id = selectedId.value;
    return id === undefined ? undefined : modelVariant({ id });
  });
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
  function detailsForModel({ id, filePath }: { id: string | undefined, filePath: string | undefined }): AudioTranscriptionModelDetails | undefined {
    const entry = sourceEntries.value.find(entry => entry.id === id);
    if (entry === undefined) {
      return undefined;
    }
    const variant = filePath === undefined ? undefined : quantizationChoices.value.get(entry.id)?.find(choice => choice.filePath === filePath);
    const pinned = variant?.pinned ?? pinnedForEntry({ entry });
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
    const selection = entries.value.find(candidate => candidate.id === id)?.selection;
    switch (selection?.kind) {
    case 'stored': return { kind: 'local', name: entry.label, fileName: localNames.value.get(selection.model.modelId), bytes: selection.model.size };
    case 'suggestion': case 'repository': case 'repository_reference': case undefined: return undefined;
    default: {
      const exhaustive: never = selection;
      throw new Error(String(exhaustive));
    }
    }
  }
  const selectedDetails = computed(() => detailsForModel({ id: selectedId.value, filePath: undefined }));

  function modelVariant({ id }: { id: string }): string | undefined {
    const entry = sourceEntries.value.find(candidate => candidate.id === id);
    const pinned = pinnedForEntry({ entry });
    if (pinned !== undefined) {
      return pinned.selection.files[0]?.path;
    }
    const selection = entry?.selection;
    switch (selection?.kind) {
    case 'suggestion':
      if (quantizationChoices.value.has(id)) {
        return quantizationChoices.value.get(id)?.find(choice => choice.filePath === selection.quantization.fileName)?.id;
      }
      return `suggestion:${selection.quantization.id}`;
    case 'stored': case 'repository_reference': case 'repository': case undefined: return undefined;
    default: throw new Error(String(selection satisfies never));
    }
  }

  function configurationSummary({ id, variant }: { id: string, variant: string | undefined }): 'standard' | 'selected' | 'missing' {
    const entry = sourceEntries.value.find(candidate => candidate.id === id);
    const current = quantizationsForModel({ id }).find(choice => choice.id === variant);
    if (entry?.selection.kind !== 'suggestion' || current === undefined) {
      return 'missing';
    }
    return current.label === entry.selection.suggestion.quantizationHints[0].preferredQuantization ? 'standard' : 'selected';
  }

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

  async function inspectQuantizations({ id, signal: requestedSignal, pinCurrent }: { id: string | undefined, signal: AbortSignal, pinCurrent: boolean }): Promise<string | undefined> {
    const entry = sourceEntries.value.find(entry => entry.id === id);
    if (busy.value || disposed || entry === undefined) {
      return undefined;
    }
    const currentPinned = pinnedForEntry({ entry });
    const source = repositorySource({ selection: currentPinned ?? entry.selection });
    if (source === undefined) {
      return undefined;
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
      const catalog = await awaitInspection({ task: getMetadataSession().inspect({ input: source.repository, signal, freshness: 'refresh' }), signal });
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
      if (disposed || quantizationsActive.value?.controller !== controller) {
        return undefined;
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
      if (pinCurrent && currentPinned === undefined && initialPath !== undefined && selectedId.value === entry.id) {
        selectQuantization({ id: initialPath });
      }
      return initialPath;
    } catch {
      if (!signal.aborted && !disposed && quantizationsActive.value?.controller === controller) {
        quantizationsFailure.value = 'metadata';
      }
    } finally {
      if (quantizationsActive.value?.controller === controller) {
        quantizationsActive.value = undefined;
      }
    }
    return undefined;
  }

  async function inspectSelectedQuantizations({ signal }: { signal: AbortSignal }): Promise<void> {
    await inspectQuantizations({ id: selectedId.value, signal, pinCurrent: true });
  }

  function selectQuantization({ id, entryId: requestedEntryId }: { id: string, entryId?: string }): void {
    const entryId = requestedEntryId ?? selectedId.value;
    if (busy.value || disposed || entryId === undefined) {
      return;
    }
    const verified = quantizationChoices.value.get(entryId);
    const choice = verified?.find(candidate => candidate.id === id);
    if (choice === undefined) {
      const selection = sourceEntries.value.find(entry => entry.id === entryId)?.selection;
      const hint = verified === undefined && selection?.kind === 'suggestion'
        ? selection.suggestion.quantizationHints.find(candidate => `suggestion:${candidate.id}` === id)
        : undefined;
      if (hint === undefined) {
        return;
      }
      activeHintIds.value = new Map(activeHintIds.value).set(entryId, hint.id);
    } else {
      configurations.value = new Map(configurations.value).set(entryId, choice.pinned);
      if (choice.installed !== undefined && stored.value.some(model => model.modelId === choice.installed?.modelId)) {
        installedBindings.value = new Map(installedBindings.value).set(bindingKey({ pinned: choice.pinned }), choice.installed.modelId);
      }
    }
    requestedId.value = entryId;
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

  function isInstalledAtDestination({ selection, destination }: { selection: DownloadSelection, destination: ModelDestination }): boolean {
    const modelId = installedBindings.value.get(bindingKey({ pinned: { kind: 'repository', selection, intentKey: undefined } }));
    const local = stored.value.find(model => model.modelId === modelId);
    if (local === undefined) {
      return false;
    }
    switch (destination.kind) {
    case 'opfs': return local.modelId.startsWith('hf.co/');
    case 'host': return local.source?.directoryId === destination.directoryId;
    default: throw new Error(String(destination satisfies never));
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

  function variantDownloadRequest({ id, variantId }: { id: string, variantId: string }): DownloadRequest | undefined {
    const verified = quantizationChoices.value.get(id);
    if (verified !== undefined) {
      const choice = verified.find(variant => variant.id === variantId);
      return choice === undefined || choice.installed !== undefined ? undefined : downloadRequest({ selection: choice.pinned, destination: downloadDestination.destination.value });
    }
    const selection = sourceEntries.value.find(entry => entry.id === id)?.selection;
    switch (selection?.kind) {
    case 'suggestion': {
      const quantization = selection.suggestion.quantizationHints.find(hint => `suggestion:${hint.id}` === variantId);
      return quantization === undefined || storedSuggestion({ quantization }) !== undefined ? undefined
        : downloadRequest({ selection: { ...selection, quantization }, destination: downloadDestination.destination.value });
    }
    case 'stored': case 'repository_reference': case 'repository': case undefined: return undefined;
    default: throw new Error(String(selection satisfies never));
    }
  }

  function queuedDownload({ request }: { request: DownloadRequest }): DownloadJob | undefined {
    return findModelDownloadJob({ jobs: queue.jobs.value, key: request.key, destination: request.destination, selection: request.prepared });
  }

  function currentDownloadAuthorization({ id, request }: { id: string, request: DownloadRequest }) {
    const pending = authorizingDownloads.value.get(id);
    return pending?.key === request.key && destinationKey({ destination: pending.destination }) === destinationKey({ destination: request.destination })
      ? pending : undefined;
  }

  function stopBackgroundDownload({ id }: { id: string }): void {
    const request = requestForId({ id });
    if (request === undefined) {
      return;
    }
    const authorization = currentDownloadAuthorization({ id, request });
    if (authorization !== undefined) {
      authorization.controller.abort();
      const updated = new Map(authorizingDownloads.value);
      updated.delete(id);
      authorizingDownloads.value = updated;
      return;
    }
    const job = queuedDownload({ request });
    if (job !== undefined) {
      queue.cancel({ id: job.id });
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
    const authorization = { key: request.key, destination, controller: new AbortController() };
    const signal = authorization.controller.signal;
    authorizingDownloads.value = new Map(authorizingDownloads.value).set(id, authorization);
    const localKey = `${id}:${downloadJobKey({ key: request.key, destination })}`;
    backgroundFailures.value = new Set([...backgroundFailures.value].filter(key => key !== localKey));
    try {
      if (await capturedLocalModel({ selection: entry.selection, signal: AbortSignal.any([lifetime.signal, signal]) }) !== undefined) {
        return;
      }
      const authorized = await awaitInspection({ task: downloadDestination.authorize({ destination }), signal });
      signal.throwIfAborted();
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
      if (!disposed && !signal.aborted) {
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
    if (disposed) {
      return;
    }
    scan?.abort();
    const controller = new AbortController();
    scan = controller;
    const completion = Promise.withResolvers<void>();
    scanCompletion = completion.promise;
    refreshing.value = true;
    try {
      const inventory = await listModelInventory({ signal: controller.signal });
      const recognized: LocalModel[] = [];
      const unverified: UnverifiedStoredModel[] = [];
      const names = new Map<string, string>();
      for (const model of inventory) {
        controller.signal.throwIfAborted();
        try {
          const candidate = await inspectStoredSpeechRecognitionModel({ modelId: model.modelId, signal: controller.signal });
          switch (candidate.kind) {
          case 'recognition': recognized.push(model);
            names.set(model.modelId, candidate.info.name);
            break;
          case 'other': unverified.push({ model, compatibility: 'unmatched' });
            break;
          default: {
            const exhaustive: never = candidate;
            throw new Error(String(exhaustive));
          }
          }
        } catch {
          controller.signal.throwIfAborted();
          unverified.push({ model, compatibility: 'unconfirmed' });
        }
      }
      controller.signal.throwIfAborted();
      if (!disposed && scan === controller) {
        stored.value = recognized;
        unverifiedStored.value = unverified;
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

  async function importModels({ request }: { request: LocalModelImportRequest }): Promise<{ models: readonly LocalModel[], skipped: readonly string[] }> {
    const { directories, controller, save } = request;
    const skipped: string[] = [];
    if (busy.value || disposed) {
      controller.abort();
      return { models: [], skipped };
    }
    controllers.add(controller);
    importing.value = true;
    failure.value = undefined;
    try {
      const captured = await directories;
      controller.signal.throwIfAborted();
      const inputs: ModelDirectoryInput[] = [];
      // A model folder can hold files for more than one runtime.
      for (const directory of captured) {
        const files: ModelDirectoryInput['files'] = [];
        for (const entry of directory.files) {
          if (!/\.gguf$/i.test(entry.relativePath)) {
            continue;
          }
          let candidate: Awaited<ReturnType<typeof inspectSpeechRecognitionCandidate>>;
          try {
            candidate = await inspectSpeechRecognitionCandidate({ file: entry.file, name: entry.file.name, signal: controller.signal });
          } catch {
            controller.signal.throwIfAborted();
            skipped.push(directory.rootName + '/' + entry.relativePath);
            continue;
          }
          switch (candidate.kind) {
          case 'recognition': files.push(entry);
            break;
          case 'other': skipped.push(directory.rootName + '/' + entry.relativePath);
            break;
          default: throw new Error(String(candidate satisfies never));
          }
        }
        if (files.length) {
          inputs.push({ ...directory, files });
        }
      }
      if (!inputs.length) {
        throw new Error('No complete speech recognition GGUF found');
      }
      const imported = await importLocalModelDirectories({ directories: inputs, signal: controller.signal, save });
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
      if (!recognized.length) {
        throw new Error('No speech recognition model was imported');
      }
      stored.value = [...stored.value.filter(previous => !recognized.some(model => model.modelId === previous.modelId)), ...recognized];
      localNames.value = names;
      return { models: recognized, skipped };
    } catch {
      if (!controller.signal.aborted && !disposed) {
        failure.value = 'import';
      }
      return { models: [], skipped };
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
      const id = repositoryEntryId({ selection });
      if (!checkingRepositories.value.has(id)) {
        checkingRepositories.value = new Set(checkingRepositories.value).add(id);
        // Resolve an exact local copy before showing that the chosen repository needs a download.
        void capturedLocalModel({ selection: { kind: 'repository', selection, intentKey: undefined }, signal: lifetime.signal }).then(model => {
          if (!disposed && model !== undefined && selectedId.value === id) {
            saveSelection();
          }
        }).catch(() => {}).finally(() => {
          const active = new Set(checkingRepositories.value);
          active.delete(id);
          checkingRepositories.value = active;
        });
      }
      select({ id });
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
    for (const entry of suggestions) {
      const hint = entry.selection.suggestion.quantizationHints.find(quantization => modelIdForSelection({ selection: { ...entry.selection, quantization } }) === modelId);
      if (hint !== undefined) {
        activeHintIds.value = new Map(activeHintIds.value).set(entry.id, hint.id);
        const previous = configurations.value.get(entry.id);
        if (previous !== undefined && modelIdForSelection({ selection: previous }) !== modelId) {
          const updated = new Map(configurations.value);
          updated.delete(entry.id);
          configurations.value = updated;
        }
        requestedId.value = entry.id;
        return;
      }
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
    pickerModels,
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
    stopBackgroundDownload,
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
    detailsForModel,
    quantizationsForModel,
    variantDownloadRequest,
    requestForId,
    isInstalledAtDestination,
    configurationSummary,
    modelVariant,
    inspectQuantizations,
    busy,
    progress,
    failure: readonly(failure),
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
