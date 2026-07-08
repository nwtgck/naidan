<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { useChatGroups, type ToolConfigsUpdater } from '@/composables/chat/useChatGroups';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useChatGroupMounts } from '@/composables/chat/useChatGroupMounts';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import {
  Settings2Icon,
  MessageSquareQuoteIcon,
  LayersIcon,
  GlobeIcon,
  AlertCircleIcon,
  Trash2Icon,
  PlusIcon,
  ChefHatIcon,
  SearchIcon,
  FolderIcon,
  WrenchIcon,
} from 'lucide-vue-next';
import { SCOPED_SETTING_FIELDS, type LmParameterSettingField, type ScopedSettingChange } from '@/01-models/scoped-setting-change';
import type {
  Endpoint,
  EndpointType,
  LmParameters,
  Mount,
  ScopedTitleGeneration,
  SystemPrompt,
} from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import {
  areEndpointModelNamespacesEqual,
  areEndpointsEqual,
  areOptionalEndpointsEqual,
  cloneEndpoint,
  cloneOptionalEndpoint,
  isHttpEndpoint,
  selectHttpEndpointSeed,
} from '@/01-models/endpoint';
import type { ChatGroupId, VolumeId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import VolumeCreator from './VolumeCreator.vue';
import MountBadgeList from './MountBadgeList.vue';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { storageService } from '@/00-storage/service';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';
import { ENDPOINT_PRESETS } from '@/constants';
import { naturalSort } from '@/utils/string';
import { hasGroupOverrides } from '@/logic/chat-settings-resolver';
import {
  cloneLmParameters,
  hasLmParameterOverrides,
  normalizeLmParameters,
} from '@/utils/lm-parameters';
import {
  createChangedLmParameterSettingChanges,
  createSystemPromptSettingChange,
} from '@/logic/scoped-setting-changes';
import type { WeshMount } from '@/features/wesh/types';
import PromptApiStatus from '@/features/prompt-api/components/PromptApiStatus.vue';
import { endpointTypeLabel } from './endpoint-type-label';
import { getPromptApiLanguageModel } from '@/features/prompt-api/api';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api';

const LmParametersEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmParametersEditor.vue') });
const RecipeExportModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/recipes/components/RecipeExportModal.vue') });
const TransformersJsUpsell = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/transformers-js/components/TransformersJsUpsell.vue') });
const ChatGroupToolsSettings = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/tools/components/ChatGroupToolsSettings.vue') });

const { currentChatGroup } = useCurrentChatState();
const { settings } = useSettings();
const { setActiveFocusArea } = useLayout();
const chatGroups = useChatGroups();
const chatModels = useChatModels();
const { openFileExplorer } = useFileExplorerModal();
const chatGroupMountsActions = useChatGroupMounts();
const isFetchingModels = computed(() => chatModels.fetchingModels.value);

const selectedProviderProfileId = ref('');
const error = ref<string | null>(null);
const groupModels = ref<string[]>([]);
const sortedGroupModels = computed(() => naturalSort({ values: groupModels.value || [] }));
const titleEndpointModels = ref<string[]>([]);
const isFetchingTitleEndpointModels = ref(false);
const sortedTitleEndpointModels = computed(() => naturalSort({ values: titleEndpointModels.value }));

const showExportModal = ref(false);
const chatGroupMounts = computed<readonly Mount[]>(() => currentChatGroup.value?.mounts ?? []);
const existingChatGroupMountPaths = computed(() => chatGroupMounts.value.map(mount => mount.mountPath));

async function handleVolumeCreated({
  volumeId,
  mountPath,
  readOnly,
}: {
  volumeId: VolumeId,
  mountPath: string,
  readOnly: boolean,
}): Promise<void> {
  const chatGroupId = currentChatGroup.value?.id;
  if (chatGroupId === undefined) return;
  await chatGroupMountsActions.addMount({
    chatGroupId,
    mount: { type: 'volume', volumeId, mountPath, readOnly },
  });
}

async function handleChatGroupMountRemove({ volumeId }: { volumeId: VolumeId }): Promise<void> {
  const chatGroupId = currentChatGroup.value?.id;
  if (chatGroupId === undefined) return;
  await chatGroupMountsActions.removeMount({ chatGroupId, volumeId });
}

async function handleChatGroupMountToggleReadOnly({
  volumeId,
  readOnly,
}: {
  volumeId: VolumeId,
  readOnly: boolean,
}): Promise<void> {
  const chatGroupId = currentChatGroup.value?.id;
  if (chatGroupId === undefined) return;
  const mount = chatGroupMounts.value.find(candidate => candidate.volumeId === volumeId);
  if (mount === undefined) return;
  await chatGroupMountsActions.updateMount({
    chatGroupId,
    volumeId,
    mountPath: mount.mountPath,
    readOnly,
  });
}

async function handleOpenChatGroupMountExplorer({ volumeId }: { volumeId: VolumeId }): Promise<void> {
  const mounts = chatGroupMounts.value;
  if (mounts.length === 0) return;

  const workerMounts: WeshMount[] = [];
  for (const mount of mounts) {
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (handle === null) continue;
    workerMounts.push({
      type: 'directory',
      path: mount.mountPath,
      handle,
      readOnly: mount.readOnly,
    });
  }

  const clickedMount = mounts.find(mount => mount.volumeId === volumeId);
  openFileExplorer({ options: {
    kind: 'wesh-mounts',
    title: await ensureStrings.ChatGroupSettingsPanel__folders(),
    rootName: await ensureStrings.ChatGroupSettingsPanel__files(),
    mounts: workerMounts,
    initialPath: clickedMount?.mountPath.split('/').filter(Boolean),
  } });
}

function handleCreateRecipe(): void {
  showExportModal.value = true;
}

type GroupSettingsDraft = {
  endpoint: Endpoint | undefined,
  modelId: string | undefined,
  titleGeneration: ScopedTitleGeneration | undefined,
  systemPrompt: SystemPrompt | undefined,
  lmParameters: LmParameters | undefined,
};

function emptyDraft(): GroupSettingsDraft {
  return {
    endpoint: undefined,
    modelId: undefined,
    titleGeneration: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
  };
}

function cloneDraft({ draft }: { draft: GroupSettingsDraft }): GroupSettingsDraft {
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: draft.endpoint }),
    modelId: draft.modelId,
    titleGeneration: cloneScopedTitleGeneration({ titleGeneration: draft.titleGeneration }),
    systemPrompt: draft.systemPrompt === undefined ? undefined : { ...draft.systemPrompt },
    lmParameters: cloneLmParameters({ lmParameters: draft.lmParameters }),
  };
}

function draftFromCurrent(): GroupSettingsDraft | undefined {
  const group = currentChatGroup.value;
  if (group === null || group === undefined) return undefined;
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: group.endpoint }),
    modelId: group.modelId,
    titleGeneration: cloneScopedTitleGeneration({ titleGeneration: group.titleGeneration }),
    systemPrompt: group.systemPrompt === undefined ? undefined : { ...group.systemPrompt },
    lmParameters: cloneLmParameters({ lmParameters: group.lmParameters }),
  };
}

function areSystemPromptsEqual({
  left,
  right,
}: {
  left: SystemPrompt | undefined,
  right: SystemPrompt | undefined,
}): boolean {
  return left?.behavior === right?.behavior && left?.content === right?.content;
}

function cloneScopedTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration | undefined,
}): ScopedTitleGeneration | undefined {
  if (titleGeneration === undefined) return undefined;
  if (typeof titleGeneration === 'string') return titleGeneration;

  return titleGeneration.endpoint === 'same_scope'
    ? {
      endpoint: 'same_scope',
      model: titleGeneration.model === 'same_scope' ? 'same_scope' : { ...titleGeneration.model },
    }
    : {
      endpoint: cloneEndpoint({ endpoint: titleGeneration.endpoint }),
      model: { ...titleGeneration.model },
    };
}

function areScopedTitleGenerationsEqual({
  left,
  right,
}: {
  left: ScopedTitleGeneration | undefined,
  right: ScopedTitleGeneration | undefined,
}): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.model !== right.model) {
    if (left.model === 'same_scope' || right.model === 'same_scope') return false;
    if (left.model.id !== right.model.id) return false;
  }
  if (left.endpoint === 'same_scope' || right.endpoint === 'same_scope') {
    return left.endpoint === right.endpoint;
  }
  return areEndpointsEqual({ left: left.endpoint, right: right.endpoint });
}

type TitleGenerationMode = 'inherit' | 'override' | 'disabled';

function scopedTitleGenerationFromDraft({
  draft,
}: {
  draft: { titleGeneration: ScopedTitleGeneration | undefined },
}): ScopedTitleGeneration {
  return draft.titleGeneration ?? 'inherit';
}
function titleGenerationModeFromValue({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration,
}): TitleGenerationMode {
  switch (titleGeneration) {
  case 'inherit':
    return 'inherit';
  case 'disabled':
    return 'disabled';
  default:
    return 'override';
  }
}

function titleModelIdFromScopedTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration,
}): string | undefined {
  if (typeof titleGeneration === 'string' || titleGeneration.model === 'same_scope') return undefined;
  return titleGeneration.model.id;
}

// Keep select parsing exhaustive: adding an EndpointType must fail typechecking
// until the UI value and label handling are reviewed.
const endpointTypeSelectValueRecord: Readonly<Record<EndpointType, true>> = {
  openai: true,
  ollama: true,
  transformers_js: true,
  browser_provided_lm: true,
};

function endpointTypeFromSelectValue({ value }: { value: string }): EndpointType | undefined {
  if (value === 'global') return undefined;
  if (Object.hasOwn(endpointTypeSelectValueRecord, value)) return value as EndpointType;
  throw new Error(`Unhandled endpoint type value: ${value}`);
}


type TitleEndpointTypeSelectValue = 'inherit' | 'same_scope' | Endpoint['type'];

function titleEndpointTypeFromSelectValue({ value }: { value: string }): TitleEndpointTypeSelectValue {
  if (value === 'inherit') return 'inherit';
  if (value === 'same_scope') return 'same_scope';
  if (value === 'unsupported_experimental_endpoint') return 'unsupported_experimental_endpoint';
  if (Object.hasOwn(endpointTypeSelectValueRecord, value)) return value as EndpointType;
  throw new Error(`Unhandled title endpoint type value: ${value}`);
}

function globalEndpointTypeLabel(): string | undefined {
  const endpointType = endpointTypeLabel({ endpointType: settings.value.endpoint.type });
  if (endpointType === undefined) return undefined;
  return lazyStrings.ChatGroupSettingsPanel__global_endpoint_type({ endpointType });
}

function titleModelExplanation(): string | undefined {
  return lazyStrings.ChatGroupSettingsPanel__title_model_explanation({ inheritance: 'none' });
}

function globalModelLabel({ modelId }: { modelId: string | undefined }): string | undefined {
  const resolvedModelId = modelId || lazyStrings.ChatGroupSettingsPanel__none();
  if (resolvedModelId === undefined) return undefined;
  return lazyStrings.ChatGroupSettingsPanel__global_model({ modelId: resolvedModelId });
}

function createChanges({
  previous,
  next,
}: {
  previous: GroupSettingsDraft,
  next: GroupSettingsDraft,
}): ScopedSettingChange[] {
  const changes: ScopedSettingChange[] = [];
  const lmChanges = new Map(
    createChangedLmParameterSettingChanges({
      previous: previous.lmParameters,
      next: next.lmParameters,
    }).map(change => [change.field, change] as const),
  );
  const titleGenerationChanged = !areScopedTitleGenerationsEqual({
    left: previous.titleGeneration,
    right: next.titleGeneration,
  });

  // Iterate the exhaustive field list so adding a ScopedSettingChange variant
  // fails typechecking here until draft comparison semantics are implemented.
  for (const field of SCOPED_SETTING_FIELDS) {
    switch (field) {
    case 'endpoint':
      if (!areOptionalEndpointsEqual({ left: previous.endpoint, right: next.endpoint })) {
        changes.push(next.endpoint === undefined
          ? { field: 'endpoint', behavior: 'inherit' }
          : {
            field: 'endpoint',
            behavior: 'override',
            value: cloneEndpoint({ endpoint: next.endpoint }),
          });
      }
      break;
    case 'model_id':
      if (previous.modelId !== next.modelId) {
        changes.push(next.modelId === undefined
          ? { field: 'model_id', behavior: 'inherit' }
          : { field: 'model_id', behavior: 'override', value: next.modelId });
      }
      break;
    case 'title_generation':
      if (titleGenerationChanged) {
        changes.push(next.titleGeneration === undefined || next.titleGeneration === 'inherit'
          ? { field: 'title_generation', behavior: 'inherit' }
          : { field: 'title_generation', behavior: 'override', value: next.titleGeneration });
      }
      break;
    case 'system_prompt':
      if (!areSystemPromptsEqual({ left: previous.systemPrompt, right: next.systemPrompt })) {
        changes.push(createSystemPromptSettingChange({ systemPrompt: next.systemPrompt }));
      }
      break;
    case 'lm_param_temperature':
    case 'lm_param_top_p':
    case 'lm_param_max_completion_tokens':
    case 'lm_param_presence_penalty':
    case 'lm_param_frequency_penalty':
    case 'lm_param_stop':
    case 'lm_param_reasoning_effort': {
      const change = lmChanges.get(field);
      if (change !== undefined) changes.push(change);
      break;
    }
    default: {
      const _ex: never = field;
      throw new Error(`Unhandled scoped setting field: ${_ex}`);
    }
    }
  }

  return changes;
}

const localSettings = ref<GroupSettingsDraft>(emptyDraft());
const baselineSettings = ref<GroupSettingsDraft>(emptyDraft());
const editingChatGroupId = ref<ChatGroupId | undefined>(undefined);
const pendingFieldRevisions = new Map<ScopedSettingChange['field'], number>();
const saveQueues = new Map<ChatGroupId, Promise<void>>();
const saveError = ref<string | null>(null);
let nextSaveRevision = 0;

const effectiveEndpoint = computed(() => localSettings.value.endpoint ?? settings.value.endpoint);
const effectiveEndpointType = computed(() => effectiveEndpoint.value.type);
const localTitleGeneration = computed(() => scopedTitleGenerationFromDraft({ draft: localSettings.value }));
const localTitleGenerationMode = computed(() => titleGenerationModeFromValue({ titleGeneration: localTitleGeneration.value }));
const localTitleModelId = computed(() => titleModelIdFromScopedTitleGeneration({ titleGeneration: localTitleGeneration.value }));

const localTitleEndpoint = computed(() => {
  const titleGeneration = localTitleGeneration.value;
  if (titleGeneration === 'inherit') return 'inherit';
  if (titleGeneration === 'disabled') return 'same_scope';
  return titleGeneration.endpoint;
});
const localTitleEndpointSelectValue = computed<TitleEndpointTypeSelectValue>(() => {
  const endpoint = localTitleEndpoint.value;
  if (endpoint === 'inherit' || endpoint === 'same_scope') return endpoint;
  return endpoint.type;
});
const localTitleEndpointUsesInheritance = computed(() => localTitleEndpoint.value === 'inherit');
const localTitleEndpointUsesSameScope = computed(() => localTitleEndpoint.value === 'same_scope');
const effectiveTitleEndpoint = computed<Endpoint>(() => localTitleEndpoint.value === 'same_scope' || localTitleEndpoint.value === 'inherit'
  ? effectiveEndpoint.value
  : localTitleEndpoint.value);
const effectiveTitleEndpointType = computed(() => effectiveTitleEndpoint.value.type);
const localTitleEndpointUrl = computed({
  get: () => {
    const endpoint = localTitleEndpoint.value;
    return endpoint !== 'same_scope' && endpoint !== 'inherit' && isHttpEndpoint(endpoint) ? endpoint.url : '';
  },
  set: (url: string) => {
    const titleGeneration = localTitleGeneration.value;
    const endpoint = localTitleEndpoint.value;
    if (typeof titleGeneration === 'string' || endpoint === 'same_scope' || endpoint === 'inherit' || !isHttpEndpoint(endpoint)) return;
    updateLocalTitleGenerationDraft({
      titleGeneration: {
        endpoint: {
          type: endpoint.type,
          url,
          httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
        },
        model: titleGeneration.model === 'same_scope' ? { id: '' } : titleGeneration.model,
      },
    });
  },
});
const titleModelOptions = computed(() => {
  if (localTitleEndpointUsesInheritance.value) return [];
  return localTitleEndpointUsesSameScope.value
    ? sortedGroupModels.value
    : sortedTitleEndpointModels.value;
});
const titleModelLoading = computed(() => {
  if (localTitleEndpointUsesInheritance.value) return false;
  return localTitleEndpointUsesSameScope.value
    ? isFetchingModels.value
    : isFetchingTitleEndpointModels.value;
});

function preservedTitleModelIdForEndpoint({
  nextEndpoint,
}: {
  nextEndpoint: Endpoint,
}): string | undefined {
  return areEndpointModelNamespacesEqual({ left: effectiveTitleEndpoint.value, right: nextEndpoint })
    ? localTitleModelId.value
    : undefined;
}

function setLocalTitleEndpointType({
  endpointType,
}: {
  endpointType: TitleEndpointTypeSelectValue,
}): void {
  switch (endpointType) {
  case 'inherit':
    setLocalTitleGeneration({ titleGeneration: 'inherit' });
    return;
  case 'same_scope': {
    const modelId = preservedTitleModelIdForEndpoint({ nextEndpoint: effectiveEndpoint.value });
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: 'same_scope',
        model: sameScopeTitleModel({ modelId }),
      },
    });
    return;
  }
  case 'browser_provided_lm':
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: { type: 'browser_provided_lm' },
        model: { id: BROWSER_PROVIDED_LM_MODEL_ID },
      },
    });
    return;
  case 'transformers_js': {
    const nextEndpoint: Endpoint = { type: 'transformers_js' };
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: nextEndpoint,
        model: explicitTitleModel({ modelId: preservedTitleModelIdForEndpoint({ nextEndpoint }) }),
      },
    });
    return;
  }
  case 'unsupported_experimental_endpoint':
    return;
  case 'openai':
  case 'ollama': {
    const currentTitleEndpoint = localTitleEndpoint.value;
    const seed = selectHttpEndpointSeed({
      preferred: currentTitleEndpoint === 'same_scope' || currentTitleEndpoint === 'inherit' ? undefined : currentTitleEndpoint,
      fallback: effectiveEndpoint.value,
    });
    const nextEndpoint: Endpoint = {
      type: endpointType,
      url: seed?.url ?? '',
      httpHeaders: seed?.httpHeaders?.map(([name, value]) => [name, value]),
    };
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: nextEndpoint,
        model: explicitTitleModel({ modelId: preservedTitleModelIdForEndpoint({ nextEndpoint }) }),
      },
    });
    return;
  }
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled title endpoint type: ${_ex}`);
  }
  }
}

function handleTitleEndpointTypeChange({ event }: { event: Event }): void {
  setLocalTitleEndpointType({ endpointType: titleEndpointTypeFromSelectValue({ value: (event.target as HTMLSelectElement).value }) });
}

async function fetchTitleEndpointModels(): Promise<void> {
  if (localTitleEndpointUsesInheritance.value) return;
  if (localTitleEndpointUsesSameScope.value) {
    await fetchModels();
    return;
  }
  const endpoint = cloneEndpoint({ endpoint: effectiveTitleEndpoint.value });
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    titleEndpointModels.value = [];
    return;
  }

  isFetchingTitleEndpointModels.value = true;
  try {
    const models = await chatModels.fetchForEndpoint({ endpoint });
    if (!areEndpointsEqual({ left: endpoint, right: effectiveTitleEndpoint.value })) return;
    titleEndpointModels.value = models;
    const titleGeneration = localTitleGeneration.value;
    if (typeof titleGeneration === 'string' || titleGeneration.endpoint === 'same_scope') return;
    if (titleGeneration.model.id !== '' && !models.includes(titleGeneration.model.id)) {
      setLocalTitleGeneration({
        titleGeneration: {
          endpoint: cloneEndpoint({ endpoint: titleGeneration.endpoint }),
          model: { id: models[0] ?? '' },
        },
      });
    }
  } catch (caught) {
    error.value = caught instanceof Error
      ? caught.message
      : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
  } finally {
    isFetchingTitleEndpointModels.value = false;
  }
}

function updateLocalTitleGenerationDraft({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration,
}): void {
  localSettings.value.titleGeneration = cloneScopedTitleGeneration({ titleGeneration });
}

function setLocalTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration,
}): void {
  updateLocalTitleGenerationDraft({ titleGeneration });
  saveChangesFromUi();
}

function setLocalTitleGenerationMode({
  mode,
}: {
  mode: TitleGenerationMode,
}): void {
  switch (mode) {
  case 'inherit':
    setLocalTitleGeneration({ titleGeneration: 'inherit' });
    return;
  case 'disabled':
    setLocalTitleGeneration({ titleGeneration: 'disabled' });
    return;
  case 'override':
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
    return;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled title generation mode: ${_ex}`);
  }
  }
}

function sameScopeTitleModel({ modelId }: { modelId: string | undefined }): 'same_scope' | { id: string } {
  return modelId === undefined || modelId === '' ? 'same_scope' : { id: modelId };
}

function explicitTitleModel({ modelId }: { modelId: string | undefined }): { id: string } {
  return { id: modelId ?? '' };
}

function setLocalTitleModelId({
  modelId,
}: {
  modelId: string | undefined,
}): void {
  const titleGeneration = localTitleGeneration.value;
  const endpoint = typeof titleGeneration === 'string' ? 'same_scope' : titleGeneration.endpoint;
  if (endpoint === 'same_scope') {
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: sameScopeTitleModel({ modelId }) } });
    return;
  }
  setLocalTitleGeneration({
    titleGeneration: {
      endpoint: cloneEndpoint({ endpoint }),
      model: explicitTitleModel({ modelId }),
    },
  });
}
const isPromptApiSupported = computed(() => getPromptApiLanguageModel() !== undefined);

const localEndpointUrl = computed({
  get: () => {
    const endpoint = localSettings.value.endpoint;
    return endpoint !== undefined && isHttpEndpoint(endpoint)
      ? endpoint.url
      : '';
  },
  set: (url: string) => {
    const previousEndpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
    const endpoint = localSettings.value.endpoint ?? settings.value.endpoint;
    if (!isHttpEndpoint(endpoint)) return;
    localSettings.value.endpoint = {
      type: endpoint.type,
      url,
      httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
    };
    resetLocalModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: effectiveEndpoint.value });
  },
});

const localEndpointHttpHeaders = computed<[string, string][] | undefined>({
  get: () => {
    const endpoint = localSettings.value.endpoint;
    return endpoint !== undefined && isHttpEndpoint(endpoint)
      ? endpoint.httpHeaders
      : undefined;
  },
  set: (httpHeaders) => {
    const endpoint = localSettings.value.endpoint ?? settings.value.endpoint;
    if (!isHttpEndpoint(endpoint)) return;
    localSettings.value.endpoint = {
      type: endpoint.type,
      url: endpoint.url,
      httpHeaders,
    };
  },
});
const hasActiveOverrides = computed(() => hasGroupOverrides({ group: localSettings.value })
  || (currentChatGroup.value?.toolConfigs?.length ?? 0) > 0);

// Keep field synchronization exhaustive. A new LM setting command must
// fail typechecking here until clean/dirty draft merge semantics are defined.
function applyLmParameterFieldFromDraft({
  field,
  target,
  source,
}: {
  field: LmParameterSettingField,
  target: GroupSettingsDraft,
  source: GroupSettingsDraft,
}): void {
  const lmParameters: LmParameters = {
    temperature: target.lmParameters?.temperature,
    topP: target.lmParameters?.topP,
    maxCompletionTokens: target.lmParameters?.maxCompletionTokens,
    presencePenalty: target.lmParameters?.presencePenalty,
    frequencyPenalty: target.lmParameters?.frequencyPenalty,
    stop: target.lmParameters?.stop === undefined
      ? undefined
      : [...target.lmParameters.stop],
    reasoning: { effort: target.lmParameters?.reasoning?.effort },
  };

  switch (field) {
  case 'lm_param_temperature':
    lmParameters.temperature = source.lmParameters?.temperature;
    break;
  case 'lm_param_top_p':
    lmParameters.topP = source.lmParameters?.topP;
    break;
  case 'lm_param_max_completion_tokens':
    lmParameters.maxCompletionTokens = source.lmParameters?.maxCompletionTokens;
    break;
  case 'lm_param_presence_penalty':
    lmParameters.presencePenalty = source.lmParameters?.presencePenalty;
    break;
  case 'lm_param_frequency_penalty':
    lmParameters.frequencyPenalty = source.lmParameters?.frequencyPenalty;
    break;
  case 'lm_param_stop':
    lmParameters.stop = source.lmParameters?.stop === undefined
      ? undefined
      : [...source.lmParameters.stop];
    break;
  case 'lm_param_reasoning_effort':
    lmParameters.reasoning.effort = source.lmParameters?.reasoning?.effort;
    break;
  default: {
    const _ex: never = field;
    throw new Error(`Unhandled LM parameter field: ${_ex}`);
  }
  }

  target.lmParameters = normalizeLmParameters({ lmParameters });
}

// Iterate every scoped field explicitly so adding a command cannot silently
// bypass external-state synchronization or save rollback.
function applyFieldFromDraft({
  field,
  target,
  source,
}: {
  field: ScopedSettingChange['field'],
  target: GroupSettingsDraft,
  source: GroupSettingsDraft,
}): void {
  switch (field) {
  case 'endpoint':
    target.endpoint = cloneOptionalEndpoint({ endpoint: source.endpoint });
    return;
  case 'model_id':
    target.modelId = source.modelId;
    return;
  case 'title_generation':
    target.titleGeneration = cloneScopedTitleGeneration({ titleGeneration: source.titleGeneration });
    return;
  case 'system_prompt':
    target.systemPrompt = source.systemPrompt === undefined ? undefined : { ...source.systemPrompt };
    return;
  case 'lm_param_temperature':
  case 'lm_param_top_p':
  case 'lm_param_max_completion_tokens':
  case 'lm_param_presence_penalty':
  case 'lm_param_frequency_penalty':
  case 'lm_param_stop':
  case 'lm_param_reasoning_effort':
    applyLmParameterFieldFromDraft({ field, target, source });
    return;
  default: {
    const _ex: never = field;
    throw new Error(`Unhandled setting field: ${_ex}`);
  }
  }
}

function syncLocalWithCurrent({ preserveDirty }: { preserveDirty: boolean }): void {
  const current = draftFromCurrent();
  const groupId = currentChatGroup.value?.id;
  if (current === undefined || groupId === undefined) return;

  if (!preserveDirty || editingChatGroupId.value !== groupId) {
    pendingFieldRevisions.clear();
    saveError.value = null;
    editingChatGroupId.value = groupId;
    localSettings.value = cloneDraft({ draft: current });
    baselineSettings.value = cloneDraft({ draft: current });
    return;
  }

  const dirtyFields = new Set<ScopedSettingChange['field']>([
    ...createChanges({
      previous: baselineSettings.value,
      next: localSettings.value,
    }).map(change => change.field),
    ...pendingFieldRevisions.keys(),
  ]);
  for (const field of SCOPED_SETTING_FIELDS) {
    if (dirtyFields.has(field)) continue;
    applyFieldFromDraft({ field, target: localSettings.value, source: current });
    applyFieldFromDraft({ field, target: baselineSettings.value, source: current });
  }
}

type SaveToolConfigUpdate =
  | { behavior: 'preserve' }
  | { behavior: 'update', updater: ToolConfigsUpdater };

function saveChangesForGroup({
  chatGroupId,
  toolConfigUpdate,
}: {
  chatGroupId: ChatGroupId | undefined,
  toolConfigUpdate: SaveToolConfigUpdate,
}): Promise<void> {
  if (chatGroupId === undefined) return Promise.resolve();

  const snapshot = cloneDraft({ draft: localSettings.value });
  const previous = saveQueues.get(chatGroupId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const baselineBeforeSave = cloneDraft({ draft: baselineSettings.value });
      const changes = createChanges({
        previous: baselineSettings.value,
        next: snapshot,
      });
      const hasToolConfigUpdate = (() => {
        switch (toolConfigUpdate.behavior) {
        case 'preserve':
          return false;
        case 'update':
          return true;
        default: {
          const _ex: never = toolConfigUpdate;
          throw new Error(`Unhandled Tool Config save behavior: ${String(_ex)}`);
        }
        }
      })();
      if (changes.length === 0 && !hasToolConfigUpdate) return;

      const revision = ++nextSaveRevision;
      for (const change of changes) {
        pendingFieldRevisions.set(change.field, revision);
        applyFieldFromDraft({
          field: change.field,
          target: baselineSettings.value,
          source: snapshot,
        });
      }

      if (editingChatGroupId.value === chatGroupId) {
        saveError.value = null;
      }

      try {
        switch (toolConfigUpdate.behavior) {
        case 'preserve':
          await chatGroups.updateScopedSettings({ chatGroupId, changes });
          break;
        case 'update':
          await chatGroups.updateScopedSettingsAndToolConfigs({
            chatGroupId,
            changes,
            updater: toolConfigUpdate.updater,
          });
          break;
        default: {
          const _ex: never = toolConfigUpdate;
          throw new Error(`Unhandled Tool Config save behavior: ${String(_ex)}`);
        }
        }
      } catch (cause: unknown) {
        for (const change of changes) {
          if (pendingFieldRevisions.get(change.field) !== revision) continue;
          pendingFieldRevisions.delete(change.field);
          applyFieldFromDraft({
            field: change.field,
            target: baselineSettings.value,
            source: baselineBeforeSave,
          });
        }
        if (editingChatGroupId.value === chatGroupId) {
          saveError.value = cause instanceof Error
            ? cause.message
            : await ensureStrings.ChatGroupSettingsPanel__failed_to_save_chat_group_settings();
        }
        throw cause;
      }

      for (const change of changes) {
        if (pendingFieldRevisions.get(change.field) === revision) {
          pendingFieldRevisions.delete(change.field);
        }
      }
      if (editingChatGroupId.value === chatGroupId) {
        syncLocalWithCurrent({ preserveDirty: true });
      }
    });

  saveQueues.set(chatGroupId, operation);
  const cleanup = () => {
    if (saveQueues.get(chatGroupId) === operation) {
      saveQueues.delete(chatGroupId);
    }
  };
  operation.then(cleanup, cleanup);
  return operation;
}

function saveChanges(): Promise<void> {
  return saveChangesForGroup({
    chatGroupId: editingChatGroupId.value,
    toolConfigUpdate: { behavior: 'preserve' },
  });
}

async function saveChangesFromUi(): Promise<void> {
  try {
    await saveChanges();
  } catch {
    // saveChanges records a user-visible error while preserving the draft.
  }
}

onMounted(() => {
  syncLocalWithCurrent({ preserveDirty: false });
  if (currentChatGroup.value) {
    const endpoint = effectiveEndpoint.value;
    const url = isHttpEndpoint(endpoint) ? endpoint.url : undefined;
    const type = endpoint.type;
    if (type === 'transformers_js' || type === 'browser_provided_lm' || isLocalhost({ url })) void fetchModels();
  }
  setActiveFocusArea({ area: 'chat-settings' });
});

onBeforeUnmount(() => {
  void saveChangesFromUi();
});

watch(() => currentChatGroup.value?.id, async (newId) => {
  const oldEditingId = editingChatGroupId.value;
  if (oldEditingId !== undefined && oldEditingId !== newId) {
    try {
      await saveChangesForGroup({
        chatGroupId: oldEditingId,
        toolConfigUpdate: { behavior: 'preserve' },
      });
    } catch {
      // The route has already moved to another group; do not attach the old
      // group's save error to the newly selected group.
    }
  }
  if (currentChatGroup.value?.id === newId) {
    syncLocalWithCurrent({ preserveDirty: false });
  }
}, { flush: 'sync' });

watch(
  () => {
    const draft = draftFromCurrent();

    // ChatGroup also owns its chat-item list. Watch only the settings draft so
    // sidebar activity does not repeatedly reconcile this form while it is open.
    return draft === undefined ? undefined : JSON.stringify(draft);
  },
  () => {
    if (currentChatGroup.value?.id === editingChatGroupId.value) {
      syncLocalWithCurrent({ preserveDirty: true });
    }
  },
);

function isLocalhost({ url }: { url: string | undefined }) {
  if (!url) return false;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

function clearBrowserProvidedLmModelOverrides(): void {
  if (localSettings.value.modelId === BROWSER_PROVIDED_LM_MODEL_ID) {
    localSettings.value.modelId = undefined;
  }
  const titleGeneration = localSettings.value.titleGeneration;
  if (typeof titleGeneration !== 'string' && titleGeneration?.model !== 'same_scope' && titleGeneration?.model.id === BROWSER_PROVIDED_LM_MODEL_ID) {
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
  }
}
function resetSameScopeTitleModelWhenEndpointNamespaceChanges({
  previousEndpoint,
  nextEndpoint,
}: {
  previousEndpoint: Endpoint,
  nextEndpoint: Endpoint,
}): void {
  if (areEndpointModelNamespacesEqual({ left: previousEndpoint, right: nextEndpoint })) return;
  const titleGeneration = localSettings.value.titleGeneration;
  if (titleGeneration === undefined || typeof titleGeneration === 'string' || titleGeneration.endpoint !== 'same_scope' || titleGeneration.model === 'same_scope') return;
  setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
}

function resetLocalModelsWhenEndpointNamespaceChanges({
  previousEndpoint,
  nextEndpoint,
}: {
  previousEndpoint: Endpoint,
  nextEndpoint: Endpoint,
}): void {
  if (areEndpointModelNamespacesEqual({ left: previousEndpoint, right: nextEndpoint })) return;
  localSettings.value.modelId = undefined;
  resetSameScopeTitleModelWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint });
}


async function updateEndpointType({
  endpointType,
}: {
  endpointType: EndpointType | undefined,
}): Promise<void> {
  const previousEndpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
  switch (endpointType) {
  case undefined:
    localSettings.value.endpoint = undefined;
    clearBrowserProvidedLmModelOverrides();
    resetLocalModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: effectiveEndpoint.value });
    break;
  case 'transformers_js':
    localSettings.value.endpoint = { type: endpointType };
    clearBrowserProvidedLmModelOverrides();
    resetLocalModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: effectiveEndpoint.value });
    break;
  case 'browser_provided_lm':
    localSettings.value.endpoint = { type: endpointType };
    localSettings.value.modelId = BROWSER_PROVIDED_LM_MODEL_ID;
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
    break;
  case 'openai':
  case 'ollama': {
    const seed = selectHttpEndpointSeed({
      preferred: localSettings.value.endpoint,
      fallback: settings.value.endpoint,
    });
    localSettings.value.endpoint = {
      type: endpointType,
      url: seed?.url ?? '',
      httpHeaders: seed?.httpHeaders?.map(([name, value]) => [name, value]),
    };
    clearBrowserProvidedLmModelOverrides();
    resetLocalModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: effectiveEndpoint.value });
    break;
  }
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }

  await saveChangesFromUi();
}

async function applyPreset({ preset }: { preset: typeof ENDPOINT_PRESETS[number] }) {
  const previousEndpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
  localSettings.value.endpoint = { type: preset.type, url: preset.url };
  clearBrowserProvidedLmModelOverrides();
  resetLocalModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: effectiveEndpoint.value });
  error.value = null;
  await saveChangesFromUi();
}

async function handleQuickProviderProfileChange() {
  const providerProfile = settings.value.providerProfiles?.find(p => idToRaw({ id: p.id }) === selectedProviderProfileId.value);
  if (providerProfile) {
    localSettings.value.endpoint = cloneEndpoint({ endpoint: providerProfile.endpoint });
    localSettings.value.modelId = providerProfile.defaultModelId;
    localSettings.value.titleGeneration = providerProfile.titleModelId === undefined
      ? { endpoint: 'same_scope', model: 'same_scope' }
      : { endpoint: 'same_scope', model: { id: providerProfile.titleModelId } };
    localSettings.value.systemPrompt = providerProfile.systemPrompt
      ? { content: providerProfile.systemPrompt, behavior: 'override' }
      : undefined;
    localSettings.value.lmParameters = cloneLmParameters({ lmParameters: providerProfile.lmParameters });
    await saveChangesFromUi();
  }
  error.value = null;
  selectedProviderProfileId.value = '';
}

function addHeader() {
  const endpoint = effectiveEndpoint.value;
  if (!isHttpEndpoint(endpoint)) return;
  localEndpointHttpHeaders.value = [
    ...(endpoint.httpHeaders ?? []),
    ['', ''],
  ];
}

async function removeHeader({ index }: { index: number }) {
  const headers = localEndpointHttpHeaders.value;
  if (headers !== undefined) {
    localEndpointHttpHeaders.value = headers.filter((_, headerIndex) => headerIndex !== index);
  }
  await saveChangesFromUi();
}

async function fetchModels() {
  const chatGroupId = currentChatGroup.value?.id;
  if (!chatGroupId) return;
  error.value = null;
  const endpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    groupModels.value = [];
    return;
  }

  try {
    const models = await chatModels.fetchForEndpoint({ endpoint });
    if (
      currentChatGroup.value?.id !== chatGroupId
      || !areEndpointsEqual({ left: endpoint, right: effectiveEndpoint.value })
    ) return;
    groupModels.value = models;
    if (models.length === 0) error.value = await ensureStrings.SHARED__no_models_found_at_this_endpoint();
    let changed = false;
    if (localSettings.value.modelId && !models.includes(localSettings.value.modelId)) {
      localSettings.value.modelId = undefined;
      changed = true;
    }
    const titleGeneration = localTitleGeneration.value;
    if (
      typeof titleGeneration !== 'string'
      && titleGeneration.endpoint === 'same_scope'
      && titleGeneration.model !== 'same_scope'
      && !models.includes(titleGeneration.model.id)
    ) {
      updateLocalTitleGenerationDraft({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
      changed = true;
    }
    if (changed) {
      await saveChangesFromUi();
    }
  } catch (caught) {
    error.value = caught instanceof Error
      ? caught.message
      : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
  }
}

watch([localEndpointUrl, effectiveEndpointType], ([url, type]) => {
  error.value = null;
  if (type === 'transformers_js' || type === 'browser_provided_lm' || (url && isLocalhost({ url }))) void fetchModels();
});

watch([localTitleEndpointUrl, effectiveTitleEndpointType], ([url, type]) => {
  error.value = null;
  if (localTitleGenerationMode.value === 'override' && !localTitleEndpointUsesSameScope.value) {
    if (type === 'transformers_js' || type === 'browser_provided_lm' || (url && isLocalhost({ url }))) void fetchTitleEndpointModels();
  }
});


async function updateSystemPromptBehavior({
  behavior,
}: {
  behavior: 'inherit' | 'clear' | 'replace' | 'append',
}) {
  switch (behavior) {
  case 'inherit':
    localSettings.value.systemPrompt = undefined;
    break;
  case 'clear':
    localSettings.value.systemPrompt = { behavior: 'override', content: null };
    break;
  case 'replace': {
    const content = localSettings.value.systemPrompt?.content ?? '';
    localSettings.value.systemPrompt = { behavior: 'override', content };
    break;
  }
  case 'append': {
    const content = localSettings.value.systemPrompt?.content ?? '';
    localSettings.value.systemPrompt = { behavior: 'append', content };
    break;
  }
  default: {
    const _ex: never = behavior;
    throw new Error(`Unhandled behavior: ${_ex}`);
  }
  }
  await saveChangesFromUi();
}

async function restoreDefaults(): Promise<void> {
  localSettings.value = emptyDraft();
  const toolConfigUpdate: SaveToolConfigUpdate = (() => {
    const persistence = settings.value.experimental?.toolConfigPersistence ?? 'disabled';
    switch (persistence) {
    case 'enabled':
      return { behavior: 'update', updater: () => undefined };
    case 'disabled':
      return { behavior: 'preserve' };
    default: {
      const _ex: never = persistence;
      throw new Error(`Unhandled Tool Config persistence status: ${_ex}`);
    }
    }
  })();

  try {
    await saveChangesForGroup({
      chatGroupId: editingChatGroupId.value,
      toolConfigUpdate,
    });
  } catch {
    // saveChangesForGroup records a user-visible error and restores its baseline.
  }
}

async function setGroupNameFromModelId() {
  const modelId = localSettings.value.modelId;
  const chatGroupId = editingChatGroupId.value;
  if (!modelId || !chatGroupId) return;
  const newName = modelId.split('/').pop() || modelId;
  await chatGroups.updateChatGroupMetadata({
    chatGroupId,
    updates: { name: newName },
  });
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    v-if="currentChatGroup"
    tw-class="flex flex-col h-full bg-[#fcfcfd] dark:bg-gray-900 transition-colors relative overflow-hidden focus:outline-none"
    tabindex="-1"
    @click="setActiveFocusArea({ area: 'chat-group-settings' })"
    @focusin="setActiveFocusArea({ area: 'chat-group-settings' })"
  >
    <!-- Header -->
    <div tw-class="border-b border-gray-100 dark:border-gray-800 px-4 sm:px-6 py-3 flex items-center justify-between bg-white/80 dark:bg-gray-900/80 backdrop-blur-md shadow-sm z-20">
      <div tw-class="flex items-center gap-3 overflow-hidden min-h-[44px]">
        <div tw-class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
          <Settings2Icon tw-class="w-5 h-5 text-blue-600" />
        </div>
        <div tw-class="flex flex-col overflow-hidden">
          <h2 tw-class="text-base sm:text-lg font-bold text-gray-800 dark:text-gray-100 tracking-tight truncate">
            {{ lazyStrings.ChatGroupSettingsPanel__group_settings_title({ groupName: currentChatGroup.name }) }}
          </h2>
          <span tw-class="text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider">{{ lazyStrings.ChatGroupSettingsPanel__group_overrides() }}</span>
        </div>
      </div>

      <div tw-class="flex items-center gap-2">
        <div
          v-if="hasActiveOverrides"
          tw-class="flex items-center gap-1.5 px-3 py-1 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-full"
        >
          <div tw-class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></div>
          <span tw-class="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__active_overrides() }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="saveError"
      tw-class="mx-4 sm:mx-6 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
      data-testid="chat-group-settings-save-error"
    >
      {{ saveError }}
    </div>

    <!-- Export Recipe Modal -->
    <RecipeExportModal
      :is-open="showExportModal"
      :group-name="currentChatGroup.name"
      :system-prompt="localSettings.systemPrompt"
      :lm-parameters="localSettings.lmParameters"
      :initial-model-id="localSettings.modelId"
      @close="showExportModal = false"
    />

    <!-- Content -->
    <div tw-class="flex-1 overflow-y-auto overscroll-contain">
      <div tw-class="max-w-4xl mx-auto p-6 sm:p-8 space-y-8">
        <!-- Quick Actions Grid -->
        <div tw-class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            @click="useGlobalSearch().openSearch({ groupIds: [idToRaw({ id: currentChatGroup.id })] })"
            tw-class="flex items-center gap-4 w-full bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-2xl px-5 py-3 text-left hover:border-blue-300 dark:hover:border-blue-700 transition-all shadow-sm group"
          >
            <div tw-class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl group-hover:bg-blue-50 dark:group-hover:bg-blue-900/20 transition-colors">
              <SearchIcon tw-class="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors" />
            </div>
            <div tw-class="flex flex-col min-w-0">
              <span tw-class="text-[9px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest leading-none mb-1">{{ lazyStrings.ChatGroupSettingsPanel__search_group() }}</span>
              <span tw-class="text-[11px] font-medium text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors truncate">{{ lazyStrings.ChatGroupSettingsPanel__search_messages() }}</span>
            </div>
          </button>

          <button
            @click="handleCreateRecipe"
            tw-class="flex items-center gap-4 w-full bg-blue-50/30 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-2xl px-5 py-3 text-left hover:border-blue-400 dark:hover:border-blue-700 transition-all shadow-sm group"
          >
            <div tw-class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm group-hover:shadow-md transition-all">
              <ChefHatIcon tw-class="w-5 h-5 text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform" />
            </div>
            <div tw-class="flex flex-col">
              <span tw-class="text-[9px] font-bold text-blue-900/50 dark:text-blue-400/50 uppercase tracking-widest leading-none mb-1">{{ lazyStrings.ChatGroupSettingsPanel__share_settings() }}</span>
              <span tw-class="text-[11px] font-bold text-blue-600 dark:text-blue-400">{{ lazyStrings.ChatGroupSettingsPanel__create_recipe() }}</span>
            </div>
          </button>
        </div>

        <div tw-class="flex flex-col md:flex-row md:items-end justify-between border-b border-gray-200/50 dark:border-gray-800 pb-6 gap-6">
          <div tw-class="flex flex-col md:flex-row gap-8 flex-1">
            <!-- Quick Switcher -->
            <div v-if="settings.providerProfiles && settings.providerProfiles.length > 0" tw-class="w-full md:max-w-[240px] space-y-2">
              <label tw-class="block text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider ml-1">{{ lazyStrings.ChatGroupSettingsPanel__quick_profile_switcher() }}</label>
              <select
                v-model="selectedProviderProfileId"
                @change="handleQuickProviderProfileChange"
                tw-class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              >
                <option value="" disabled>{{ lazyStrings.ChatGroupSettingsPanel__load_from_saved_profiles() }}</option>
                <option v-for="p in settings.providerProfiles" :key="idToRaw({ id: p.id })" :value="idToRaw({ id: p.id })">{{ p.name }} ({{ endpointTypeLabel({ endpointType: p.endpoint.type }) }})</option>
              </select>
            </div>

            <!-- Endpoint Presets -->
            <div tw-class="space-y-2 flex-1">
              <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider ml-1">{{ lazyStrings.ChatGroupSettingsPanel__quick_endpoint_presets() }}</label>
              <div tw-class="flex flex-wrap gap-1.5">
                <button
                  v-for="preset in ENDPOINT_PRESETS"
                  :key="preset.name"
                  @click="applyPreset({ preset })"
                  type="button"
                  :tw-class="['px-4 py-2 text-[10px] font-bold rounded-xl border transition-all shadow-sm', localEndpointUrl === preset.url && localSettings.endpoint?.type === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600']"
                >
                  {{ preset.name }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div tw-class="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div tw-class="space-y-2">
            <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_type() }}</label>
            <select
              data-testid="group-setting-endpoint-type-select"
              :value="localSettings.endpoint?.type || 'global'"
              @change="async (e) => {
                const value = (e.target as HTMLSelectElement).value;
                await updateEndpointType({ endpointType: endpointTypeFromSelectValue({ value }) });
              }"
              tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
            >
              <option value="global">{{ globalEndpointTypeLabel() }}</option>
              <option value="openai">{{ lazyStrings.ChatGroupSettingsPanel__openai_compatible() }}</option>
              <option value="ollama">{{ lazyStrings.ChatGroupSettingsPanel__ollama() }}</option>
              <option value="transformers_js">{{ lazyStrings.ChatGroupSettingsPanel__transformers_js_experimental() }}</option>
              <option value="browser_provided_lm" :tw-class="{ 'text-gray-400': !isPromptApiSupported }">{{ lazyStrings.SHARED__browser_provided() }}</option>
              <option
                v-if="localSettings.endpoint?.type === 'unsupported_experimental_endpoint'"
                value="unsupported_experimental_endpoint"
                disabled
              >{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option>
            </select>
          </div>

          <PromptApiStatus v-if="effectiveEndpointType === 'browser_provided_lm'" show-ready />

          <div tw-class="space-y-2" v-if="isHttpEndpoint(effectiveEndpoint)">
            <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_url() }}</label>
            <input
              v-if="localSettings.endpoint"
              v-model="localEndpointUrl"
              @input="error = null"
              @blur="saveChangesFromUi"
              type="text"
              tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
              :placeholder="isHttpEndpoint(settings.endpoint) ? settings.endpoint.url : undefined"
              data-testid="group-setting-url-input"
            />
            <div v-if="error" tw-class="mt-2">
              <p class="animate-in fade-in slide-in-from-top-1" tw-class="text-[10px] text-red-500 font-bold ml-1 leading-relaxed duration-200">{{ error }}</p>
            </div>
          </div>

          <div tw-class="space-y-2" v-if="isHttpEndpoint(effectiveEndpoint)">
            <div tw-class="flex items-center justify-between ml-1">
              <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__custom_http_headers() }}</label>
              <button
                @click="addHeader"
                type="button"
                tw-class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
              >
                <PlusIcon tw-class="w-2.5 h-2.5" />
                {{ lazyStrings.ChatGroupSettingsPanel__add_header() }}
              </button>
            </div>

            <div v-if="localEndpointHttpHeaders && localEndpointHttpHeaders.length > 0" tw-class="space-y-2">
              <div
                v-for="(header, index) in localEndpointHttpHeaders"
                :key="index"
                tw-class="flex gap-2"
              >
                <input
                  v-model="header[0]"
                  @blur="saveChangesFromUi"
                  type="text"
                  tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  :placeholder="lazyStrings.ChatGroupSettingsPanel__name()"
                />
                <input
                  v-model="header[1]"
                  @blur="saveChangesFromUi"
                  type="text"
                  tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  :placeholder="lazyStrings.ChatGroupSettingsPanel__value()"
                />
                <button
                  @click="removeHeader({ index })"
                  tw-class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                >
                  <Trash2Icon tw-class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div v-else tw-class="text-[10px] text-gray-400 italic ml-1">{{ lazyStrings.ChatGroupSettingsPanel__no_custom_headers() }}</div>
          </div>

          <div tw-class="space-y-4">
            <div tw-class="space-y-2">
              <div tw-class="flex items-center justify-between ml-1">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__model_id_override() }}</label>
                <button
                  v-if="localSettings.modelId"
                  @click="setGroupNameFromModelId"
                  type="button"
                  tw-class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
                  data-testid="group-setting-set-name-from-model"
                >
                  {{ lazyStrings.ChatGroupSettingsPanel__set_group_name() }}
                </button>
              </div>
              <ModelSelector
                :model-value="localSettings.modelId"
                @update:model-value="val => { localSettings.modelId = val; saveChangesFromUi(); }"
                :loading="isFetchingModels"
                :models="sortedGroupModels"
                :disabled="effectiveEndpointType === 'browser_provided_lm'"
                :placeholder="globalModelLabel({ modelId: settings.defaultModelId })"
                :allow-clear="true"
                @refresh="fetchModels"
                data-testid="group-setting-model-select"
              />
            </div>

            <fieldset
              :disabled="effectiveEndpointType === 'browser_provided_lm'"
              :tw-class="['p-4 bg-gray-50/50 dark:bg-gray-800/20 border border-gray-100 dark:border-gray-700/50 rounded-2xl', { 'opacity-50': effectiveEndpointType === 'browser_provided_lm' }]"
            >
              <ReasoningSettings
                :selected-effort="localSettings.lmParameters?.reasoning?.effort"
                @update:effort="effort => {
                  const params = { ...(localSettings.lmParameters || EMPTY_LM_PARAMETERS), reasoning: { effort } };
                  localSettings.lmParameters = params;
                  saveChangesFromUi();
                }"
              />
            </fieldset>
            <TransformersJsUpsell :show="effectiveEndpointType === 'transformers_js'" />
          </div>
        </div>

        <!-- Automatic Title Section -->
        <div tw-class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl space-y-6 shadow-sm">
          <div tw-class="flex items-center justify-between">
            <div tw-class="flex items-center gap-3">
              <div tw-class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
                <Settings2Icon tw-class="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <h4 tw-class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__automatic_title() }}</h4>
                <p tw-class="text-[10px] text-gray-500 dark:text-gray-400 font-medium">{{ lazyStrings.ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named() }}</p>
              </div>
            </div>
            <div tw-class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
              <button
                @click="setLocalTitleGenerationMode({ mode: 'inherit' })"
                :tw-class="['px-3 py-1 text-[9px] font-bold rounded transition-all', localTitleGenerationMode === 'inherit' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
              >
                {{ lazyStrings.ChatGroupSettingsPanel__use_global_setting() }}
              </button>
              <button
                @click="setLocalTitleGenerationMode({ mode: 'override' })"
                :tw-class="['px-3 py-1 text-[9px] font-bold rounded transition-all', localTitleGenerationMode === 'override' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
              >
                {{ lazyStrings.ChatGroupSettingsPanel__override() }}
              </button>
              <button
                @click="setLocalTitleGenerationMode({ mode: 'disabled' })"
                :tw-class="['px-3 py-1 text-[9px] font-bold rounded transition-all', localTitleGenerationMode === 'disabled' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
              >
                {{ lazyStrings.ChatGroupSettingsPanel__disabled() }}
              </button>
            </div>
          </div>

          <div v-if="localTitleGenerationMode !== 'disabled'" tw-class="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-gray-50 dark:border-gray-800/50">
            <div tw-class="space-y-2">
              <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__title_endpoint_type() }}</label>
              <select
                :value="localTitleEndpointSelectValue"
                @change="handleTitleEndpointTypeChange({ event: $event })"
                tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                data-testid="group-setting-title-endpoint-type-select"
              >
                <option value="inherit">{{ lazyStrings.ChatGroupSettingsPanel__use_global_setting() }}</option>
                <option value="same_scope">{{ lazyStrings.ChatGroupSettingsPanel__same_as_group_chat_endpoint() }}</option>
                <option value="openai">{{ lazyStrings.ChatGroupSettingsPanel__openai_compatible() }}</option>
                <option value="ollama">{{ lazyStrings.ChatGroupSettingsPanel__ollama() }}</option>
                <option value="transformers_js">{{ lazyStrings.ChatGroupSettingsPanel__transformers_js_experimental() }}</option>
                <option value="browser_provided_lm" :tw-class="{ 'text-gray-400': !isPromptApiSupported }">{{ lazyStrings.SHARED__browser_provided() }}</option>
                <option
                  v-if="localTitleEndpointSelectValue === 'unsupported_experimental_endpoint'"
                  value="unsupported_experimental_endpoint"
                  disabled
                >{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option>
              </select>
            </div>

            <div v-if="!localTitleEndpointUsesSameScope && isHttpEndpoint(effectiveTitleEndpoint)" tw-class="space-y-2">
              <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_url() }}</label>
              <input
                v-model="localTitleEndpointUrl"
                @blur="saveChangesFromUi"
                @keyup.enter="(e) => (e.target as HTMLInputElement).blur()"
                type="text"
                tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                :placeholder="isHttpEndpoint(effectiveEndpoint) ? effectiveEndpoint.url : undefined"
                data-testid="group-setting-title-endpoint-url-input"
              />
            </div>

            <div tw-class="space-y-2">
              <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__title_model_override() }}</label>
              <ModelSelector
                :model-value="localTitleEndpointUsesInheritance ? undefined : localTitleModelId"
                @update:model-value="val => setLocalTitleModelId({ modelId: val })"
                :models="titleModelOptions"
                :loading="titleModelLoading"
                :placeholder="localTitleEndpointUsesInheritance ? lazyStrings.ChatGroupSettingsPanel__use_global_setting() : (localTitleEndpointUsesSameScope ? globalModelLabel({ modelId: settings.titleGeneration === 'disabled' || settings.titleGeneration.model === 'same_scope' ? undefined : settings.titleGeneration.model.id }) : undefined)"
                :allow-clear="localTitleEndpointUsesSameScope && !localTitleEndpointUsesInheritance"
                :clear-label="localTitleEndpointUsesInheritance ? lazyStrings.ChatGroupSettingsPanel__use_global_setting() : globalModelLabel({ modelId: settings.titleGeneration === 'disabled' || settings.titleGeneration.model === 'same_scope' ? undefined : settings.titleGeneration.model.id })"
                :disabled="localTitleEndpointUsesInheritance || effectiveTitleEndpoint.type === 'browser_provided_lm'"
                @refresh="fetchTitleEndpointModels"
                data-testid="group-setting-title-model-select"
              />
            </div>
            <div tw-class="flex items-center">
              <p tw-class="text-[10px] text-gray-400 italic leading-relaxed">
                {{ titleModelExplanation() }}
              </p>
            </div>
          </div>
        </div>

        <!-- Info Banners -->
        <div tw-class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div tw-class="flex items-start gap-4 p-4 bg-white dark:bg-blue-900/10 border border-gray-100 dark:border-blue-900/30 rounded-2xl shadow-sm">
            <div tw-class="p-2 bg-blue-50 dark:bg-gray-800 rounded-xl border border-blue-100 dark:border-blue-900/20">
              <GlobeIcon tw-class="w-4 h-4 text-blue-500" />
            </div>
            <div tw-class="space-y-1">
              <p tw-class="text-[10px] font-bold text-blue-900/70 dark:text-blue-300 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__group_level() }}</p>
              <p tw-class="text-[11px] text-gray-500 dark:text-blue-400/70 leading-relaxed font-medium">{{ lazyStrings.ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat() }}</p>
            </div>
          </div>

          <div tw-class="flex items-start gap-4 p-4 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm">
            <div tw-class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700">
              <AlertCircleIcon tw-class="w-4 h-4 text-gray-400" />
            </div>
            <div tw-class="space-y-1">
              <p tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-400 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__local_overrides() }}</p>
              <p tw-class="text-[11px] text-gray-500/70 dark:text-gray-400/70 leading-relaxed font-medium">
                {{ lazyStrings.ChatGroupSettingsPanel__these_settings_only_apply_to_this_group() }}
                <button
                  @click="restoreDefaults"
                  tw-class="font-bold underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  data-testid="group-setting-restore-defaults"
                >
                  {{ lazyStrings.ChatGroupSettingsPanel__restore_defaults() }}
                </button>.
              </p>
            </div>
          </div>
        </div>

        <!-- Tools -->
        <section tw-class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-4">
          <div tw-class="space-y-1">
            <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
              <WrenchIcon tw-class="w-3 h-3" />
              {{ lazyStrings.ChatGroupSettingsPanel__tools() }}
            </label>
            <p tw-class="text-[11px] text-gray-500 dark:text-gray-400">
              {{ lazyStrings.ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group() }}
            </p>
          </div>
          <ChatGroupToolsSettings />
        </section>

        <!-- System Prompt and Parameters -->
        <div tw-class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-8 pb-20">
          <div tw-class="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div tw-class="md:col-span-2 space-y-4">
              <div tw-class="flex items-center justify-between">
                <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <MessageSquareQuoteIcon tw-class="w-3 h-3" />
                  {{ lazyStrings.ChatGroupSettingsPanel__group_system_prompt() }}
                </label>

                <div tw-class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'inherit' })"
                    :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', !localSettings.systemPrompt ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__inherit() }}
                  </button>
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'clear' })"
                    :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__clear() }}
                  </button>
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'replace' })"
                    :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content !== null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__override() }}
                  </button>
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'append' })"
                    :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', localSettings.systemPrompt?.behavior === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__append() }}
                  </button>
                </div>
              </div>
              <div v-if="!localSettings.systemPrompt" tw-class="w-full bg-gray-50/50 dark:bg-gray-800/30 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-left">
                <p tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">{{ lazyStrings.ChatGroupSettingsPanel__inherited_instructions() }}</p>
                <p tw-class="text-xs text-gray-400 dark:text-gray-500 italic whitespace-pre-wrap line-clamp-6">
                  {{ settings.systemPrompt || lazyStrings.ChatGroupSettingsPanel__no_global_instructions_defined() }}
                </p>
              </div>
              <div v-else-if="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null" tw-class="w-full bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center">
                <p tw-class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__global_prompt_cleared() }}</p>
                <p tw-class="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{{ lazyStrings.ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions() }}</p>
              </div>
              <textarea
                v-else
                :value="localSettings.systemPrompt?.content || ''"
                @input="e => {
                  const val = (e.target as HTMLTextAreaElement).value;
                  if(localSettings.systemPrompt) {
                    localSettings.systemPrompt.content = val;
                  } else {
                    localSettings.systemPrompt = { content: val, behavior: 'override' };
                  }
                }"
                @blur="saveChangesFromUi"
                rows="6"
                tw-class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                :placeholder="localSettings.systemPrompt?.behavior === 'append' ? lazyStrings.ChatGroupSettingsPanel__added_after_global_instructions() : lazyStrings.ChatGroupSettingsPanel__completely_replaces_global_instructions()"
                data-testid="group-setting-system-prompt-textarea"
              ></textarea>
            </div>

            <div tw-class="space-y-4">
              <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                <LayersIcon tw-class="w-3 h-3" />
                {{ lazyStrings.ChatGroupSettingsPanel__settings_resolution() }}
              </label>
              <div tw-class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-3 shadow-sm">
                <div tw-class="flex items-center justify-between text-[10px] font-bold">
                  <span tw-class="text-gray-400">{{ lazyStrings.ChatGroupSettingsPanel__system_prompt() }}</span>
                  <span :tw-class="localSettings.systemPrompt ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-system-prompt">
                    {{ localSettings.systemPrompt ? (localSettings.systemPrompt.behavior === 'append' ? lazyStrings.ChatGroupSettingsPanel__appending() : (localSettings.systemPrompt.content === null ? lazyStrings.ChatGroupSettingsPanel__cleared() : lazyStrings.ChatGroupSettingsPanel__overriding())) : lazyStrings.ChatGroupSettingsPanel__global_default() }}
                  </span>
                </div>
                <div tw-class="flex items-center justify-between text-[10px] font-bold">
                  <span tw-class="text-gray-400">{{ lazyStrings.ChatGroupSettingsPanel__parameters() }}</span>
                  <span :tw-class="hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-lm-parameters">
                    {{ hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? lazyStrings.ChatGroupSettingsPanel__group_overrides() : lazyStrings.ChatGroupSettingsPanel__inherited() }}
                  </span>
                </div>
                <div tw-class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                  <p tw-class="text-[9px] text-gray-400 leading-relaxed italic">{{ lazyStrings.ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats() }}</p>
                </div>
              </div>
            </div>
          </div>

          <div tw-class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl">
            <LmParametersEditor
              :model-value="localSettings.lmParameters"
              @update:model-value="val => { localSettings.lmParameters = val; saveChangesFromUi(); }"
            />
          </div>

          <!-- Folders -->
          <div tw-class="space-y-3">
            <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
              <FolderIcon tw-class="w-3 h-3" />
              {{ lazyStrings.ChatGroupSettingsPanel__folders() }}
            </label>

            <!-- Active chat group mounts (badge style) -->
            <div v-if="chatGroupMounts.length > 0" data-testid="chat-group-mounts">
              <MountBadgeList
                :mounts="chatGroupMounts"
                path-trim-prefix="/home/user/"
                :show-explorer="true"
                @toggle-read-only="handleChatGroupMountToggleReadOnly"
                @remove="handleChatGroupMountRemove"
                @open-explorer="handleOpenChatGroupMountExplorer"
              />
            </div>

            <!-- Add Folder / Copy Folder buttons -->
            <VolumeCreator
              :existing-mount-paths="existingChatGroupMountPaths"
              mount-path-prefix="/home/user/"
              @created="handleVolumeCreated"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
