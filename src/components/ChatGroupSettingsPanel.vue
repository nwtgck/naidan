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
  SystemPrompt,
} from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import {
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
  autoTitleEnabled: boolean | undefined,
  titleModelId: string | undefined,
  systemPrompt: SystemPrompt | undefined,
  lmParameters: LmParameters | undefined,
};

function emptyDraft(): GroupSettingsDraft {
  return {
    endpoint: undefined,
    modelId: undefined,
    autoTitleEnabled: undefined,
    titleModelId: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
  };
}

function cloneDraft({ draft }: { draft: GroupSettingsDraft }): GroupSettingsDraft {
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: draft.endpoint }),
    modelId: draft.modelId,
    autoTitleEnabled: draft.autoTitleEnabled,
    titleModelId: draft.titleModelId,
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
    autoTitleEnabled: group.autoTitleEnabled,
    titleModelId: group.titleModelId,
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

// Keep select parsing exhaustive: adding an EndpointType must fail typechecking
// until the UI value and label handling are reviewed.
const endpointTypeSelectValueRecord: Readonly<Record<EndpointType, true>> = {
  openai: true,
  ollama: true,
  transformers_js: true,
};

function endpointTypeFromSelectValue({ value }: { value: string }): EndpointType | undefined {
  if (value === 'global') return undefined;
  if (Object.hasOwn(endpointTypeSelectValueRecord, value)) return value as EndpointType;
  throw new Error(`Unhandled endpoint type value: ${value}`);
}

function endpointTypeLabel({ endpointType }: { endpointType: EndpointType }): string | undefined {
  switch (endpointType) {
  case 'openai':
    return 'OpenAI';
  case 'ollama':
    return lazyStrings.ChatGroupSettingsPanel__ollama();
  case 'transformers_js':
    return lazyStrings.ChatGroupSettingsPanel__transformers_js();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

function globalEndpointTypeLabel(): string | undefined {
  const endpointType = endpointTypeLabel({ endpointType: settings.value.endpoint.type });
  if (endpointType === undefined) return undefined;
  return lazyStrings.ChatGroupSettingsPanel__global_endpoint_type({ endpointType });
}

function titleModelExplanation(): string | undefined {
  const inheritance = localSettings.value.autoTitleEnabled === undefined
    ? (settings.value.autoTitleEnabled ? 'enabled' : 'disabled')
    : 'none';
  return lazyStrings.ChatGroupSettingsPanel__title_model_explanation({ inheritance });
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
    case 'auto_title_enabled':
      if (previous.autoTitleEnabled !== next.autoTitleEnabled) {
        changes.push(next.autoTitleEnabled === undefined
          ? { field: 'auto_title_enabled', behavior: 'inherit' }
          : { field: 'auto_title_enabled', behavior: 'override', value: next.autoTitleEnabled });
      }
      break;
    case 'title_model_id':
      if (previous.titleModelId !== next.titleModelId) {
        changes.push(next.titleModelId === undefined
          ? { field: 'title_model_id', behavior: 'inherit' }
          : { field: 'title_model_id', behavior: 'override', value: next.titleModelId });
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

const localEndpointUrl = computed({
  get: () => {
    const endpoint = localSettings.value.endpoint;
    return endpoint !== undefined && isHttpEndpoint(endpoint)
      ? endpoint.url
      : '';
  },
  set: (url: string) => {
    const endpoint = localSettings.value.endpoint ?? settings.value.endpoint;
    if (!isHttpEndpoint(endpoint)) return;
    localSettings.value.endpoint = {
      type: endpoint.type,
      url,
      httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
    };
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
  case 'auto_title_enabled':
    target.autoTitleEnabled = source.autoTitleEnabled;
    return;
  case 'title_model_id':
    target.titleModelId = source.titleModelId;
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
    if (type === 'transformers_js' || isLocalhost({ url })) void fetchModels();
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

async function updateEndpointType({
  endpointType,
}: {
  endpointType: EndpointType | undefined,
}): Promise<void> {
  switch (endpointType) {
  case undefined:
    localSettings.value.endpoint = undefined;
    break;
  case 'transformers_js':
    localSettings.value.endpoint = { type: endpointType };
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
  localSettings.value.endpoint = { type: preset.type, url: preset.url };
  error.value = null;
  await saveChangesFromUi();
}

async function handleQuickProviderProfileChange() {
  const providerProfile = settings.value.providerProfiles?.find(p => idToRaw({ id: p.id }) === selectedProviderProfileId.value);
  if (providerProfile) {
    localSettings.value.endpoint = cloneEndpoint({ endpoint: providerProfile.endpoint });
    localSettings.value.modelId = providerProfile.defaultModelId;
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
  if (!currentChatGroup.value) return;
  error.value = null;
  const endpoint = effectiveEndpoint.value;
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    groupModels.value = [];
    return;
  }

  try {
    const models = await chatModels.fetchForEndpoint({
      endpoint: cloneEndpoint({ endpoint }),
    });
    groupModels.value = models;
    if (models.length === 0) error.value = await ensureStrings.SHARED__no_models_found_at_this_endpoint();
    if (localSettings.value.modelId && !models.includes(localSettings.value.modelId)) {
      localSettings.value.modelId = undefined;
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
  if (type === 'transformers_js' || (url && isLocalhost({ url }))) void fetchModels();
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
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div
    v-if="currentChatGroup"
    class="flex flex-col h-full bg-[#fcfcfd] dark:bg-gray-900 transition-colors relative overflow-hidden focus:outline-none"
    tabindex="-1"
    @click="setActiveFocusArea({ area: 'chat-group-settings' })"
    @focusin="setActiveFocusArea({ area: 'chat-group-settings' })"
  >
    <!-- Header -->
    <div class="border-b border-gray-100 dark:border-gray-800 px-4 sm:px-6 py-3 flex items-center justify-between bg-white/80 dark:bg-gray-900/80 backdrop-blur-md shadow-sm z-20">
      <div class="flex items-center gap-3 overflow-hidden min-h-[44px]">
        <div class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
          <Settings2Icon class="w-5 h-5 text-blue-600" />
        </div>
        <div class="flex flex-col overflow-hidden">
          <h2 class="text-base sm:text-lg font-bold text-gray-800 dark:text-gray-100 tracking-tight truncate">
            {{ lazyStrings.ChatGroupSettingsPanel__group_settings_title({ groupName: currentChatGroup.name }) }}
          </h2>
          <span class="text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider">{{ lazyStrings.ChatGroupSettingsPanel__group_overrides() }}</span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <div
          v-if="hasActiveOverrides"
          class="flex items-center gap-1.5 px-3 py-1 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-full"
        >
          <div class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></div>
          <span class="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__active_overrides() }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="saveError"
      class="mx-4 sm:mx-6 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
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
    <div class="flex-1 overflow-y-auto overscroll-contain">
      <div class="max-w-4xl mx-auto p-6 sm:p-8 space-y-8">
        <!-- Quick Actions Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            @click="useGlobalSearch().openSearch({ groupIds: [idToRaw({ id: currentChatGroup.id })] })"
            class="flex items-center gap-4 w-full bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-2xl px-5 py-3 text-left hover:border-blue-300 dark:hover:border-blue-700 transition-all shadow-sm group"
          >
            <div class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl group-hover:bg-blue-50 dark:group-hover:bg-blue-900/20 transition-colors">
              <SearchIcon class="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors" />
            </div>
            <div class="flex flex-col min-w-0">
              <span class="text-[9px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest leading-none mb-1">{{ lazyStrings.ChatGroupSettingsPanel__search_group() }}</span>
              <span class="text-[11px] font-medium text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors truncate">{{ lazyStrings.ChatGroupSettingsPanel__search_messages() }}</span>
            </div>
          </button>

          <button
            @click="handleCreateRecipe"
            class="flex items-center gap-4 w-full bg-blue-50/30 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-2xl px-5 py-3 text-left hover:border-blue-400 dark:hover:border-blue-700 transition-all shadow-sm group"
          >
            <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm group-hover:shadow-md transition-all">
              <ChefHatIcon class="w-5 h-5 text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform" />
            </div>
            <div class="flex flex-col">
              <span class="text-[9px] font-bold text-blue-900/50 dark:text-blue-400/50 uppercase tracking-widest leading-none mb-1">{{ lazyStrings.ChatGroupSettingsPanel__share_settings() }}</span>
              <span class="text-[11px] font-bold text-blue-600 dark:text-blue-400">{{ lazyStrings.ChatGroupSettingsPanel__create_recipe() }}</span>
            </div>
          </button>
        </div>

        <div class="flex flex-col md:flex-row md:items-end justify-between border-b border-gray-200/50 dark:border-gray-800 pb-6 gap-6">
          <div class="flex flex-col md:flex-row gap-8 flex-1">
            <!-- Quick Switcher -->
            <div v-if="settings.providerProfiles && settings.providerProfiles.length > 0" class="w-full md:max-w-[240px] space-y-2">
              <label class="block text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider ml-1">{{ lazyStrings.ChatGroupSettingsPanel__quick_profile_switcher() }}</label>
              <select
                v-model="selectedProviderProfileId"
                @change="handleQuickProviderProfileChange"
                class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              >
                <option value="" disabled>{{ lazyStrings.ChatGroupSettingsPanel__load_from_saved_profiles() }}</option>
                <option v-for="p in settings.providerProfiles" :key="idToRaw({ id: p.id })" :value="idToRaw({ id: p.id })">{{ p.name }} ({{ endpointTypeLabel({ endpointType: p.endpoint.type }) }})</option>
              </select>
            </div>

            <!-- Endpoint Presets -->
            <div class="space-y-2 flex-1">
              <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider ml-1">{{ lazyStrings.ChatGroupSettingsPanel__quick_endpoint_presets() }}</label>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="preset in ENDPOINT_PRESETS"
                  :key="preset.name"
                  @click="applyPreset({ preset })"
                  type="button"
                  class="px-4 py-2 text-[10px] font-bold rounded-xl border transition-all shadow-sm"
                  :class="localEndpointUrl === preset.url && localSettings.endpoint?.type === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600'"
                >
                  {{ preset.name }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div class="space-y-2">
            <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_type() }}</label>
            <select
              data-testid="group-setting-endpoint-type-select"
              :value="localSettings.endpoint?.type || 'global'"
              @change="async (e) => {
                const value = (e.target as HTMLSelectElement).value;
                await updateEndpointType({ endpointType: endpointTypeFromSelectValue({ value }) });
              }"
              class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
            >
              <option value="global">{{ globalEndpointTypeLabel() }}</option>
              <option value="openai">{{ lazyStrings.ChatGroupSettingsPanel__openai_compatible() }}</option>
              <option value="ollama">{{ lazyStrings.ChatGroupSettingsPanel__ollama() }}</option>
              <option value="transformers_js">{{ lazyStrings.ChatGroupSettingsPanel__transformers_js_experimental() }}</option>
            </select>
          </div>

          <div class="space-y-2" v-if="effectiveEndpointType !== 'transformers_js'">
            <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_url() }}</label>
            <input
              v-if="localSettings.endpoint"
              v-model="localEndpointUrl"
              @input="error = null"
              @blur="saveChangesFromUi"
              type="text"
              class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
              :placeholder="isHttpEndpoint(settings.endpoint) ? settings.endpoint.url : undefined"
              data-testid="group-setting-url-input"
            />
            <div v-if="error" class="mt-2">
              <p class="text-[10px] text-red-500 font-bold ml-1 leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200">{{ error }}</p>
            </div>
          </div>

          <div class="space-y-2" v-if="effectiveEndpointType !== 'transformers_js'">
            <div class="flex items-center justify-between ml-1">
              <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__custom_http_headers() }}</label>
              <button
                @click="addHeader"
                type="button"
                class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
              >
                <PlusIcon class="w-2.5 h-2.5" />
                {{ lazyStrings.ChatGroupSettingsPanel__add_header() }}
              </button>
            </div>

            <div v-if="localEndpointHttpHeaders && localEndpointHttpHeaders.length > 0" class="space-y-2">
              <div
                v-for="(header, index) in localEndpointHttpHeaders"
                :key="index"
                class="flex gap-2"
              >
                <input
                  v-model="header[0]"
                  @blur="saveChangesFromUi"
                  type="text"
                  class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  :placeholder="lazyStrings.ChatGroupSettingsPanel__name()"
                />
                <input
                  v-model="header[1]"
                  @blur="saveChangesFromUi"
                  type="text"
                  class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  :placeholder="lazyStrings.ChatGroupSettingsPanel__value()"
                />
                <button
                  @click="removeHeader({ index })"
                  class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                >
                  <Trash2Icon class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div v-else class="text-[10px] text-gray-400 italic ml-1">{{ lazyStrings.ChatGroupSettingsPanel__no_custom_headers() }}</div>
          </div>

          <div class="space-y-4">
            <div class="space-y-2">
              <div class="flex items-center justify-between ml-1">
                <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__model_id_override() }}</label>
                <button
                  v-if="localSettings.modelId"
                  @click="setGroupNameFromModelId"
                  type="button"
                  class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
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
                :placeholder="globalModelLabel({ modelId: settings.defaultModelId })"
                :allow-clear="true"
                @refresh="fetchModels"
                data-testid="group-setting-model-select"
              />
            </div>

            <div class="p-4 bg-gray-50/50 dark:bg-gray-800/20 border border-gray-100 dark:border-gray-700/50 rounded-2xl">
              <ReasoningSettings
                :selected-effort="localSettings.lmParameters?.reasoning?.effort"
                @update:effort="effort => {
                  const params = { ...(localSettings.lmParameters || EMPTY_LM_PARAMETERS), reasoning: { effort } };
                  localSettings.lmParameters = params;
                  saveChangesFromUi();
                }"
              />
            </div>
            <TransformersJsUpsell :show="effectiveEndpointType === 'transformers_js'" />
          </div>
        </div>

        <!-- Automatic Title Section -->
        <div class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl space-y-6 shadow-sm">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
                <Settings2Icon class="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <h4 class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__automatic_title() }}</h4>
                <p class="text-[10px] text-gray-500 dark:text-gray-400 font-medium">{{ lazyStrings.ChatGroupSettingsPanel__configure_how_chats_in_this_group_are_automatically_named() }}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
              <button
                @click="localSettings.autoTitleEnabled = undefined; saveChangesFromUi();"
                class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                :class="localSettings.autoTitleEnabled === undefined ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                {{ lazyStrings.ChatGroupSettingsPanel__inherit() }}
              </button>
              <button
                @click="localSettings.autoTitleEnabled = true; saveChangesFromUi();"
                class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                :class="localSettings.autoTitleEnabled === true ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                {{ lazyStrings.ChatGroupSettingsPanel__enabled() }}
              </button>
              <button
                @click="localSettings.autoTitleEnabled = false; saveChangesFromUi();"
                class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                :class="localSettings.autoTitleEnabled === false ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                {{ lazyStrings.ChatGroupSettingsPanel__disabled() }}
              </button>
            </div>
          </div>

          <div v-if="localSettings.autoTitleEnabled !== false" class="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-gray-50 dark:border-gray-800/50">
            <div class="space-y-2">
              <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatGroupSettingsPanel__title_model_override() }}</label>
              <ModelSelector
                :model-value="localSettings.titleModelId"
                @update:model-value="val => { localSettings.titleModelId = val; saveChangesFromUi(); }"
                :models="sortedGroupModels"
                :loading="isFetchingModels"
                :placeholder="globalModelLabel({ modelId: settings.titleModelId })"
                :allow-clear="true"
                @refresh="fetchModels"
                data-testid="group-setting-title-model-select"
              />
            </div>
            <div class="flex items-center">
              <p class="text-[10px] text-gray-400 italic leading-relaxed">
                {{ titleModelExplanation() }}
              </p>
            </div>
          </div>
        </div>

        <!-- Info Banners -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="flex items-start gap-4 p-4 bg-white dark:bg-blue-900/10 border border-gray-100 dark:border-blue-900/30 rounded-2xl shadow-sm">
            <div class="p-2 bg-blue-50 dark:bg-gray-800 rounded-xl border border-blue-100 dark:border-blue-900/20">
              <GlobeIcon class="w-4 h-4 text-blue-500" />
            </div>
            <div class="space-y-1">
              <p class="text-[10px] font-bold text-blue-900/70 dark:text-blue-300 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__group_level() }}</p>
              <p class="text-[11px] text-gray-500 dark:text-blue-400/70 leading-relaxed font-medium">{{ lazyStrings.ChatGroupSettingsPanel__these_settings_will_apply_to_all_chats_within_this_group_unless_overridden_by_a_specific_chat() }}</p>
            </div>
          </div>

          <div class="flex items-start gap-4 p-4 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm">
            <div class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700">
              <AlertCircleIcon class="w-4 h-4 text-gray-400" />
            </div>
            <div class="space-y-1">
              <p class="text-[10px] font-bold text-gray-400 dark:text-gray-400 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__local_overrides() }}</p>
              <p class="text-[11px] text-gray-500/70 dark:text-gray-400/70 leading-relaxed font-medium">
                {{ lazyStrings.ChatGroupSettingsPanel__these_settings_only_apply_to_this_group() }}
                <button
                  @click="restoreDefaults"
                  class="font-bold underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  data-testid="group-setting-restore-defaults"
                >
                  {{ lazyStrings.ChatGroupSettingsPanel__restore_defaults() }}
                </button>.
              </p>
            </div>
          </div>
        </div>

        <!-- Tools -->
        <section class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-4">
          <div class="space-y-1">
            <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
              <WrenchIcon class="w-3 h-3" />
              {{ lazyStrings.ChatGroupSettingsPanel__tools() }}
            </label>
            <p class="text-[11px] text-gray-500 dark:text-gray-400">
              {{ lazyStrings.ChatGroupSettingsPanel__inherit_global_settings_or_override_individual_tools_for_this_chat_group() }}
            </p>
          </div>
          <ChatGroupToolsSettings />
        </section>

        <!-- System Prompt and Parameters -->
        <div class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-8 pb-20">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div class="md:col-span-2 space-y-4">
              <div class="flex items-center justify-between">
                <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <MessageSquareQuoteIcon class="w-3 h-3" />
                  {{ lazyStrings.ChatGroupSettingsPanel__group_system_prompt() }}
                </label>

                <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'inherit' })"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="!localSettings.systemPrompt ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__inherit() }}
                  </button>
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'clear' })"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__clear() }}
                  </button>
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'replace' })"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content !== null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__override() }}
                  </button>
                  <button
                    @click="updateSystemPromptBehavior({ behavior: 'append' })"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="localSettings.systemPrompt?.behavior === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    {{ lazyStrings.ChatGroupSettingsPanel__append() }}
                  </button>
                </div>
              </div>
              <div v-if="!localSettings.systemPrompt" class="w-full bg-gray-50/50 dark:bg-gray-800/30 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-left">
                <p class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">{{ lazyStrings.ChatGroupSettingsPanel__inherited_instructions() }}</p>
                <p class="text-xs text-gray-400 dark:text-gray-500 italic whitespace-pre-wrap line-clamp-6">
                  {{ settings.systemPrompt || lazyStrings.ChatGroupSettingsPanel__no_global_instructions_defined() }}
                </p>
              </div>
              <div v-else-if="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null" class="w-full bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center">
                <p class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatGroupSettingsPanel__global_prompt_cleared() }}</p>
                <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{{ lazyStrings.ChatGroupSettingsPanel__this_group_will_not_use_any_system_instructions() }}</p>
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
                class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                :placeholder="localSettings.systemPrompt?.behavior === 'append' ? lazyStrings.ChatGroupSettingsPanel__added_after_global_instructions() : lazyStrings.ChatGroupSettingsPanel__completely_replaces_global_instructions()"
                data-testid="group-setting-system-prompt-textarea"
              ></textarea>
            </div>

            <div class="space-y-4">
              <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                <LayersIcon class="w-3 h-3" />
                {{ lazyStrings.ChatGroupSettingsPanel__settings_resolution() }}
              </label>
              <div class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-3 shadow-sm">
                <div class="flex items-center justify-between text-[10px] font-bold">
                  <span class="text-gray-400">{{ lazyStrings.ChatGroupSettingsPanel__system_prompt() }}</span>
                  <span :class="localSettings.systemPrompt ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-system-prompt">
                    {{ localSettings.systemPrompt ? (localSettings.systemPrompt.behavior === 'append' ? lazyStrings.ChatGroupSettingsPanel__appending() : (localSettings.systemPrompt.content === null ? lazyStrings.ChatGroupSettingsPanel__cleared() : lazyStrings.ChatGroupSettingsPanel__overriding())) : lazyStrings.ChatGroupSettingsPanel__global_default() }}
                  </span>
                </div>
                <div class="flex items-center justify-between text-[10px] font-bold">
                  <span class="text-gray-400">{{ lazyStrings.ChatGroupSettingsPanel__parameters() }}</span>
                  <span :class="hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-lm-parameters">
                    {{ hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? lazyStrings.ChatGroupSettingsPanel__group_overrides() : lazyStrings.ChatGroupSettingsPanel__inherited() }}
                  </span>
                </div>
                <div class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                  <p class="text-[9px] text-gray-400 leading-relaxed italic">{{ lazyStrings.ChatGroupSettingsPanel__group_settings_take_precedence_over_global_settings_but_can_be_overridden_by_individual_chats() }}</p>
                </div>
              </div>
            </div>
          </div>

          <div class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl">
            <LmParametersEditor
              :model-value="localSettings.lmParameters"
              @update:model-value="val => { localSettings.lmParameters = val; saveChangesFromUi(); }"
            />
          </div>

          <!-- Folders -->
          <div class="space-y-3">
            <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
              <FolderIcon class="w-3 h-3" />
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
