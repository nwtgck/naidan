<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { SCOPED_SETTING_FIELDS, type LmParameterSettingField, type ScopedSettingChange } from '@/01-models/scoped-setting-change';
import type {
  Chat,
  Endpoint,
  EndpointType,
  LmParameters,
  ScopedTitleGeneration,
  SystemPrompt,
} from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import {
  areEndpointsEqual,
  areOptionalEndpointsEqual,
  cloneEndpoint,
  cloneOptionalEndpoint,
  isHttpEndpoint,
  selectHttpEndpointSeed,
} from '@/01-models/endpoint';
import type { ChatId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import {
  XIcon,
  Settings2Icon,
  MessageSquareQuoteIcon,
  LayersIcon,
  GlobeIcon,
  AlertCircleIcon,
  Trash2Icon,
  PlusIcon,
} from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { ENDPOINT_PRESETS } from '@/constants';
import { naturalSort } from '@/utils/string';
import { hasChatOverrides } from '@/logic/chat-settings-resolver';
import { formatSettingsSourceLabel } from '@/logic/settings-labels';
import {
  cloneLmParameters,
  hasLmParameterOverrides,
  normalizeLmParameters,
} from '@/utils/lm-parameters';
import {
  createChangedLmParameterSettingChanges,
  createSystemPromptSettingChange,
} from '@/logic/scoped-setting-changes';
import PromptApiStatus from '@/features/prompt-api/components/PromptApiStatus.vue';
import { endpointTypeLabel } from './endpoint-type-label';
import { getPromptApiLanguageModel } from '@/features/prompt-api/api';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api';

import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';

const LmParametersEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmParametersEditor.vue') });
const TransformersJsUpsell = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/transformers-js/components/TransformersJsUpsell.vue') });

const props = defineProps<{
  show?: boolean,
}>();

const emit = defineEmits<{
  (e: 'close'): void,
}>();

const { currentChatId, currentChat, resolvedSettings, inheritedSettings } = useCurrentChatState();
const chatMetadata = useChatMetadata();
const chatModels = useChatModels();
const isFetchingModels = computed(() => chatModels.fetchingModels.value);
const sortedAvailableModels = computed(() => naturalSort({ values: chatModels.availableModels.value || [] }));
const titleEndpointModels = ref<string[]>([]);
const isFetchingTitleEndpointModels = ref(false);
const sortedTitleEndpointModels = computed(() => naturalSort({ values: titleEndpointModels.value }));
const { settings } = useSettings();
const { setActiveFocusArea } = useLayout();

type ChatSettingsDraft = {
  endpoint: Endpoint | undefined,
  modelId: string | undefined,
  titleGeneration: ScopedTitleGeneration | undefined,
  autoTitleEnabled: boolean | undefined,
  titleModelId: string | undefined,
  systemPrompt: SystemPrompt | undefined,
  lmParameters: LmParameters | undefined,
};

function emptyDraft(): ChatSettingsDraft {
  return {
    endpoint: undefined,
    modelId: undefined,
    titleGeneration: undefined,
    autoTitleEnabled: undefined,
    titleModelId: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
  };
}

function cloneDraft({ draft }: { draft: ChatSettingsDraft }): ChatSettingsDraft {
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: draft.endpoint }),
    modelId: draft.modelId,
    titleGeneration: cloneScopedTitleGeneration({ titleGeneration: draft.titleGeneration }),
    autoTitleEnabled: draft.autoTitleEnabled,
    titleModelId: draft.titleModelId,
    systemPrompt: draft.systemPrompt === undefined ? undefined : { ...draft.systemPrompt },
    lmParameters: cloneLmParameters({ lmParameters: draft.lmParameters }),
  };
}

function draftFromChat({ chat }: { chat: Chat }): ChatSettingsDraft {
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: chat.endpoint }),
    modelId: chat.modelId,
    titleGeneration: cloneScopedTitleGeneration({ titleGeneration: chat.titleGeneration }),
    autoTitleEnabled: chat.autoTitleEnabled,
    titleModelId: chat.titleModelId,
    systemPrompt: chat.systemPrompt === undefined ? undefined : { ...chat.systemPrompt },
    lmParameters: cloneLmParameters({ lmParameters: chat.lmParameters }),
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

function legacyFieldsFromScopedTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration | undefined,
}): { autoTitleEnabled: boolean | undefined, titleModelId: string | undefined } {
  switch (titleGeneration) {
  case undefined:
  case 'inherit':
    return { autoTitleEnabled: undefined, titleModelId: undefined };
  case 'disabled':
    return { autoTitleEnabled: false, titleModelId: undefined };
  default:
    return {
      autoTitleEnabled: true,
      titleModelId: titleGeneration.model === 'same_scope' ? undefined : titleGeneration.model.id,
    };
  }
}

type TitleGenerationMode = 'inherit' | 'enabled' | 'disabled';

function scopedTitleGenerationFromDraft({
  draft,
}: {
  draft: { titleGeneration: ScopedTitleGeneration | undefined, autoTitleEnabled: boolean | undefined, titleModelId: string | undefined },
}): ScopedTitleGeneration {
  if (draft.titleGeneration !== undefined) return draft.titleGeneration;
  if (draft.autoTitleEnabled === false) return 'disabled';
  if (draft.autoTitleEnabled === undefined && draft.titleModelId === undefined) return 'inherit';
  return {
    endpoint: 'same_scope',
    model: draft.titleModelId === undefined ? 'same_scope' : { id: draft.titleModelId },
  };
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
    return 'enabled';
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


type TitleEndpointTypeSelectValue = 'same_scope' | Endpoint['type'];

function titleEndpointTypeFromSelectValue({ value }: { value: string }): TitleEndpointTypeSelectValue {
  if (value === 'same_scope') return 'same_scope';
  if (value === 'unsupported_experimental_endpoint') return 'unsupported_experimental_endpoint';
  if (Object.hasOwn(endpointTypeSelectValueRecord, value)) return value as EndpointType;
  throw new Error(`Unhandled title endpoint type value: ${value}`);
}

function inheritedEndpointTypeLabel(): string | undefined {
  const endpointType = inheritedSettings.value?.endpoint.type;
  if (endpointType === undefined) {
    return formatSettingsSourceLabel({
      value: undefined,
      source: inheritedSettings.value?.sources.endpoint,
    });
  }
  const label = endpointTypeLabel({ endpointType });
  if (label === undefined) return undefined;
  return formatSettingsSourceLabel({
    value: label,
    source: inheritedSettings.value?.sources.endpoint,
  });
}

function titleModelExplanation(): string | undefined {
  const source = resolvedSettings.value?.sources.autoTitleEnabled;
  if (localSettings.value.autoTitleEnabled !== undefined || source === undefined) {
    return lazyStrings.ChatSettingsPanel__title_model_explanation({
      inheritance: { type: 'none' },
    });
  }

  return lazyStrings.ChatSettingsPanel__title_model_explanation({
    inheritance: {
      type: 'inherited',
      state: resolvedSettings.value?.autoTitleEnabled ? 'enabled' : 'disabled',
      source,
    },
  });
}

function createChanges({
  previous,
  next,
}: {
  previous: ChatSettingsDraft,
  next: ChatSettingsDraft,
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
    case 'auto_title_enabled':
      if (!titleGenerationChanged && previous.autoTitleEnabled !== next.autoTitleEnabled) {
        changes.push(next.autoTitleEnabled === undefined
          ? { field: 'auto_title_enabled', behavior: 'inherit' }
          : { field: 'auto_title_enabled', behavior: 'override', value: next.autoTitleEnabled });
      }
      break;
    case 'title_model_id':
      if (!titleGenerationChanged && previous.titleModelId !== next.titleModelId) {
        changes.push(next.titleModelId === undefined
          ? { field: 'title_model_id', behavior: 'inherit' }
          : { field: 'title_model_id', behavior: 'override', value: next.titleModelId });
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

const localSettings = ref<ChatSettingsDraft>(emptyDraft());
const baselineSettings = ref<ChatSettingsDraft>(emptyDraft());
const editingChatId = ref<ChatId | undefined>(undefined);
const pendingFieldRevisions = new Map<ScopedSettingChange['field'], number>();
const saveQueues = new Map<ChatId, Promise<void>>();
const saveError = ref<string | null>(null);
let nextSaveRevision = 0;

const hasActiveOverrides = computed(() => hasChatOverrides({ chat: localSettings.value }));
const effectiveEndpoint = computed(() => localSettings.value.endpoint ?? inheritedSettings.value?.endpoint ?? settings.value.endpoint);
const effectiveEndpointType = computed(() => effectiveEndpoint.value?.type);
const localTitleGeneration = computed(() => scopedTitleGenerationFromDraft({ draft: localSettings.value }));
const localTitleGenerationMode = computed(() => titleGenerationModeFromValue({ titleGeneration: localTitleGeneration.value }));
const localTitleModelId = computed(() => titleModelIdFromScopedTitleGeneration({ titleGeneration: localTitleGeneration.value }));

const localTitleEndpoint = computed(() => {
  const titleGeneration = localTitleGeneration.value;
  if (typeof titleGeneration === 'string') return 'same_scope';
  return titleGeneration.endpoint;
});
const localTitleEndpointSelectValue = computed<TitleEndpointTypeSelectValue>(() => {
  const endpoint = localTitleEndpoint.value;
  return endpoint === 'same_scope' ? 'same_scope' : endpoint.type;
});
const localTitleEndpointUsesSameScope = computed(() => localTitleEndpoint.value === 'same_scope');
const effectiveTitleEndpoint = computed<Endpoint>(() => localTitleEndpoint.value === 'same_scope'
  ? effectiveEndpoint.value
  : localTitleEndpoint.value);
const effectiveTitleEndpointType = computed(() => effectiveTitleEndpoint.value.type);
const localTitleEndpointUrl = computed({
  get: () => {
    const endpoint = localTitleEndpoint.value;
    return endpoint !== 'same_scope' && isHttpEndpoint(endpoint) ? endpoint.url : '';
  },
  set: (url: string) => {
    const titleGeneration = localTitleGeneration.value;
    const endpoint = localTitleEndpoint.value;
    if (typeof titleGeneration === 'string' || endpoint === 'same_scope' || !isHttpEndpoint(endpoint)) return;
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
const titleModelOptions = computed(() => localTitleEndpointUsesSameScope.value
  ? sortedAvailableModels.value
  : sortedTitleEndpointModels.value);
const titleModelLoading = computed(() => localTitleEndpointUsesSameScope.value
  ? isFetchingModels.value
  : isFetchingTitleEndpointModels.value);

function setLocalTitleEndpointType({
  endpointType,
}: {
  endpointType: TitleEndpointTypeSelectValue,
}): void {
  const modelId = localTitleModelId.value;
  switch (endpointType) {
  case 'same_scope':
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: 'same_scope',
        model: sameScopeTitleModel({ modelId }),
      },
    });
    return;
  case 'browser_provided_lm':
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: { type: 'browser_provided_lm' },
        model: { id: BROWSER_PROVIDED_LM_MODEL_ID },
      },
    });
    return;
  case 'transformers_js':
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: { type: 'transformers_js' },
        model: explicitTitleModel({ modelId }),
      },
    });
    return;
  case 'unsupported_experimental_endpoint':
    return;
  case 'openai':
  case 'ollama': {
    const currentTitleEndpoint = localTitleEndpoint.value;
    const seed = selectHttpEndpointSeed({
      preferred: currentTitleEndpoint === 'same_scope' ? undefined : currentTitleEndpoint,
      fallback: effectiveEndpoint.value,
    });
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: {
          type: endpointType,
          url: seed?.url ?? '',
          httpHeaders: seed?.httpHeaders?.map(([name, value]) => [name, value]),
        },
        model: explicitTitleModel({ modelId }),
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
  const legacy = legacyFieldsFromScopedTitleGeneration({ titleGeneration });
  localSettings.value.autoTitleEnabled = legacy.autoTitleEnabled;
  localSettings.value.titleModelId = legacy.titleModelId;
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
  case 'enabled':
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
    const endpoint = localSettings.value.endpoint ?? inheritedSettings.value?.endpoint;
    if (!endpoint || !isHttpEndpoint(endpoint)) return;
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
    const endpoint = localSettings.value.endpoint ?? inheritedSettings.value?.endpoint;
    if (!endpoint || !isHttpEndpoint(endpoint)) return;
    localSettings.value.endpoint = {
      type: endpoint.type,
      url: endpoint.url,
      httpHeaders,
    };
  },
});

const inheritedEndpointUrlPlaceholder = computed(() => {
  const inherited = inheritedSettings.value;
  if (inherited === null || inherited === undefined || !isHttpEndpoint(inherited.endpoint)) {
    return formatSettingsSourceLabel({
      value: undefined,
      source: inherited?.sources.endpoint,
    });
  }
  return formatSettingsSourceLabel({
    value: inherited.endpoint.url,
    source: inherited.sources.endpoint,
  });
});

// Keep field synchronization exhaustive. A new LM setting command must
// fail typechecking here until clean/dirty draft merge semantics are defined.
function applyLmParameterFieldFromDraft({
  field,
  target,
  source,
}: {
  field: LmParameterSettingField,
  target: ChatSettingsDraft,
  source: ChatSettingsDraft,
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
  target: ChatSettingsDraft,
  source: ChatSettingsDraft,
}): void {
  switch (field) {
  case 'endpoint':
    target.endpoint = cloneOptionalEndpoint({ endpoint: source.endpoint });
    return;
  case 'model_id':
    target.modelId = source.modelId;
    return;
  case 'auto_title_enabled':
    target.titleGeneration = undefined;
    target.autoTitleEnabled = source.autoTitleEnabled;
    return;
  case 'title_model_id':
    target.titleGeneration = undefined;
    target.titleModelId = source.titleModelId;
    return;
  case 'title_generation':
    target.titleGeneration = cloneScopedTitleGeneration({ titleGeneration: source.titleGeneration });
    {
      const legacy = legacyFieldsFromScopedTitleGeneration({ titleGeneration: target.titleGeneration });
      target.autoTitleEnabled = legacy.autoTitleEnabled;
      target.titleModelId = legacy.titleModelId;
    }
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
  const chat = currentChat.value;
  if (chat === null || chat === undefined) return;
  const current = draftFromChat({ chat });

  if (!preserveDirty || editingChatId.value !== chat.id) {
    pendingFieldRevisions.clear();
    saveError.value = null;
    editingChatId.value = chat.id;
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

function saveChangesForChat({ chatId }: { chatId: ChatId | undefined }): Promise<void> {
  if (chatId === undefined) return Promise.resolve();

  // Capture the draft now, but calculate its changes only after earlier saves
  // for this chat settle. This lets a close or navigation wait for an in-flight
  // blur save and retry its draft if that earlier save failed.
  const snapshot = cloneDraft({ draft: localSettings.value });
  const previous = saveQueues.get(chatId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const baselineBeforeSave = cloneDraft({ draft: baselineSettings.value });
      const changes = createChanges({
        previous: baselineSettings.value,
        next: snapshot,
      });
      if (changes.length === 0) return;

      const revision = ++nextSaveRevision;
      for (const change of changes) {
        pendingFieldRevisions.set(change.field, revision);
        applyFieldFromDraft({
          field: change.field,
          target: baselineSettings.value,
          source: snapshot,
        });
      }

      if (editingChatId.value === chatId) {
        saveError.value = null;
      }

      try {
        await chatMetadata.updateScopedSettings({ chatId, changes });
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
        if (editingChatId.value === chatId) {
          saveError.value = cause instanceof Error
            ? cause.message
            : await ensureStrings.ChatSettingsPanel__failed_to_save_chat_settings();
        }
        throw cause;
      }

      for (const change of changes) {
        if (pendingFieldRevisions.get(change.field) === revision) {
          pendingFieldRevisions.delete(change.field);
        }
      }
      if (editingChatId.value === chatId) {
        syncLocalWithCurrent({ preserveDirty: true });
      }
    });

  saveQueues.set(chatId, operation);
  const cleanup = () => {
    if (saveQueues.get(chatId) === operation) {
      saveQueues.delete(chatId);
    }
  };
  operation.then(cleanup, cleanup);
  return operation;
}

function saveChanges(): Promise<void> {
  return saveChangesForChat({ chatId: editingChatId.value });
}

async function saveChangesFromUi(): Promise<void> {
  try {
    await saveChanges();
  } catch {
    // saveChanges records a user-visible error while preserving the draft.
  }
}

async function closePanel(): Promise<void> {
  try {
    await saveChanges();
  } catch {
    return;
  }
  emit('close');
}

onMounted(() => {
  syncLocalWithCurrent({ preserveDirty: false });
  if (currentChat.value) {
    const endpoint = currentChat.value.endpoint ?? settings.value.endpoint;
    const url = isHttpEndpoint(endpoint) ? endpoint.url : undefined;
    const type = endpoint.type;
    if (type === 'transformers_js' || type === 'browser_provided_lm' || isLocalhost({ url })) void fetchModels();
  }
});

onBeforeUnmount(() => {
  void saveChangesFromUi();
});

watch(() => currentChat.value?.id, async (newId) => {
  const oldEditingChatId = editingChatId.value;
  if (oldEditingChatId !== undefined && oldEditingChatId !== newId) {
    try {
      await saveChangesForChat({ chatId: oldEditingChatId });
    } catch {
      // Navigation has already selected another chat. The old target's error
      // must not be displayed as though it belonged to the new chat.
    }
  }
  if (currentChat.value?.id === newId) {
    syncLocalWithCurrent({ preserveDirty: false });
  }
}, { flush: 'sync' });

watch(
  () => {
    const chat = currentChat.value;
    if (chat === null || chat === undefined) return undefined;

    // Watch only the settings projection. The Chat object also contains the
    // message tree, which changes for every streaming chunk; observing it deeply
    // would run settings reconciliation for unrelated conversation updates.
    return JSON.stringify(draftFromChat({ chat }));
  },
  () => {
    if (currentChat.value?.id === editingChatId.value) {
      syncLocalWithCurrent({ preserveDirty: true });
    }
  },
);

watch(() => props.show, (show) => {
  if (show) {
    // A prop-driven close cannot await persistence. Preserve dirty fields on
    // reopen so a failed background save never discards the user's draft.
    syncLocalWithCurrent({ preserveDirty: true });
    setActiveFocusArea({ area: 'chat-settings' });
  } else {
    setActiveFocusArea({ area: 'chat' });
    void saveChangesFromUi();
  }
});

const selectedProviderProfileId = ref('');
const error = ref<string | null>(null);

function isLocalhost({ url }: { url: string | undefined }) {
  if (!url) return false;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

function clearBrowserProvidedLmModelOverrides(): void {
  if (localSettings.value.modelId === BROWSER_PROVIDED_LM_MODEL_ID) {
    localSettings.value.modelId = undefined;
  }
  if (localSettings.value.titleModelId === BROWSER_PROVIDED_LM_MODEL_ID) {
    localSettings.value.titleModelId = undefined;
  }
  const titleGeneration = localSettings.value.titleGeneration;
  if (typeof titleGeneration !== 'string' && titleGeneration?.model !== 'same_scope' && titleGeneration?.model.id === BROWSER_PROVIDED_LM_MODEL_ID) {
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
  }
}

async function updateEndpointType({
  endpointType,
}: {
  endpointType: EndpointType | undefined,
}): Promise<void> {
  switch (endpointType) {
  case undefined:
    localSettings.value.endpoint = undefined;
    clearBrowserProvidedLmModelOverrides();
    break;
  case 'transformers_js':
    localSettings.value.endpoint = { type: endpointType };
    clearBrowserProvidedLmModelOverrides();
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
      fallback: inheritedSettings.value?.endpoint,
    });
    localSettings.value.endpoint = {
      type: endpointType,
      url: seed?.url ?? '',
      httpHeaders: seed?.httpHeaders?.map(([name, value]) => [name, value]),
    };
    clearBrowserProvidedLmModelOverrides();
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
  clearBrowserProvidedLmModelOverrides();
  error.value = null;
  await saveChangesFromUi();
}

async function handleQuickProviderProfileChange() {
  const providerProfile = settings.value.providerProfiles?.find(p => idToRaw({ id: p.id }) === selectedProviderProfileId.value);
  if (providerProfile) {
    localSettings.value.endpoint = cloneEndpoint({ endpoint: providerProfile.endpoint });
    localSettings.value.modelId = providerProfile.defaultModelId;
    localSettings.value.titleModelId = providerProfile.titleModelId;
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
  const endpoint = localSettings.value.endpoint ?? inheritedSettings.value?.endpoint;
  if (!endpoint || !isHttpEndpoint(endpoint)) return;
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
  const chatId = currentChatId.value;
  if (!chatId) return;
  const requestedEndpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
  error.value = null;
  try {
    const models = await chatModels.fetchForChat({ chatId });
    if (
      currentChatId.value !== chatId
      || !areEndpointsEqual({ left: requestedEndpoint, right: effectiveEndpoint.value })
    ) return;
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
  if (localTitleGenerationMode.value === 'enabled' && !localTitleEndpointUsesSameScope.value) {
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

function updateSystemPromptContent({ content }: { content: string }) {
  if (localSettings.value.systemPrompt) {
    localSettings.value.systemPrompt.content = content;
  } else {
    localSettings.value.systemPrompt = { content, behavior: 'override' };
  }
}

async function handleRestoreDefaults() {
  localSettings.value = emptyDraft();
  await saveChangesFromUi();
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
  <Transition name="modal">
    <div v-if="show" tw-class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-2 md:p-6" @click.self="closePanel">
      <div class="modal-content-zoom" tw-class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 relative overflow-hidden">
        <!-- Title & Close -->
        <div tw-class="flex items-center justify-between p-6 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div tw-class="flex items-center gap-2">
            <div tw-class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
              <Settings2Icon tw-class="w-4 h-4 text-blue-600" />
            </div>
            <h3 tw-class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__chat_specific_overrides() }}</h3>
          </div>

          <div tw-class="flex items-center gap-2">
            <div
              v-if="hasActiveOverrides"
              tw-class="flex items-center gap-1.5 px-3 py-1 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-full"
            >
              <div tw-class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></div>
              <span tw-class="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__active_overrides() }}</span>
            </div>

            <button
              @click="closePanel"
              tw-class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
              data-testid="close-button"
            >
              <XIcon tw-class="w-5 h-5" />
            </button>
          </div>
        </div>

        <div
          v-if="saveError"
          tw-class="mx-6 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
          data-testid="chat-settings-save-error"
        >
          {{ saveError }}
        </div>

        <!-- Scrollable Content -->
        <div tw-class="flex-1 overflow-y-auto p-6 space-y-8 overscroll-contain">
          <div tw-class="flex flex-col md:flex-row md:items-end justify-between border-b border-gray-200/50 dark:border-gray-800 pb-8 gap-6">
            <div tw-class="flex flex-col md:flex-row gap-8 flex-1">
              <!-- Quick Switcher -->
              <div v-if="settings.providerProfiles && settings.providerProfiles.length > 0" tw-class="w-full md:max-w-[240px] space-y-2">
                <label tw-class="block text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider ml-1">{{ lazyStrings.ChatSettingsPanel__quick_profile_switcher() }}</label>
                <select
                  v-model="selectedProviderProfileId"
                  @change="handleQuickProviderProfileChange"
                  tw-class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                  style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                >
                  <option value="" disabled>{{ lazyStrings.ChatSettingsPanel__load_from_saved_profiles() }}</option>
                  <option v-for="p in settings.providerProfiles" :key="idToRaw({ id: p.id })" :value="idToRaw({ id: p.id })">{{ p.name }} ({{ endpointTypeLabel({ endpointType: p.endpoint.type }) }})</option>
                </select>
              </div>

              <!-- Endpoint Presets -->
              <div tw-class="space-y-2 flex-1">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider ml-1">{{ lazyStrings.ChatSettingsPanel__quick_endpoint_presets() }}</label>
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
              <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__endpoint_type() }}</label>
              <select
                data-testid="chat-setting-endpoint-type-select"
                :value="localSettings.endpoint?.type || 'global'"
                @change="async (e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  await updateEndpointType({ endpointType: endpointTypeFromSelectValue({ value }) });
                }"
                tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              >
                <option value="global">{{ inheritedEndpointTypeLabel() }}</option>
                <option value="openai">{{ lazyStrings.ChatSettingsPanel__openai_compatible() }}</option>
                <option value="ollama">{{ lazyStrings.ChatSettingsPanel__ollama() }}</option>
                <option value="transformers_js">{{ lazyStrings.ChatSettingsPanel__transformers_js_experimental() }}</option>
                <option value="browser_provided_lm" :tw-class="{ 'text-gray-400': !isPromptApiSupported }">{{ lazyStrings.SHARED__browser_provided() }}</option>
                <option
                  v-if="localTitleEndpointSelectValue === 'unsupported_experimental_endpoint'"
                  value="unsupported_experimental_endpoint"
                  disabled
                >{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option>
                <option
                  v-if="localSettings.endpoint?.type === 'unsupported_experimental_endpoint'"
                  value="unsupported_experimental_endpoint"
                  disabled
                >{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option>
              </select>
            </div>

            <PromptApiStatus v-if="effectiveEndpointType === 'browser_provided_lm'" show-ready />

            <div tw-class="space-y-2" v-if="effectiveEndpoint && isHttpEndpoint(effectiveEndpoint)">
              <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__endpoint_url() }}</label>
              <input
                v-model="localEndpointUrl"
                @blur="saveChangesFromUi"
                @keyup.enter="(e) => (e.target as HTMLInputElement).blur()"
                @input="error = null"
                type="text"
                tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                :placeholder="inheritedEndpointUrlPlaceholder"
                data-testid="chat-setting-url-input"
              />
              <div v-if="error" tw-class="mt-2">
                <p class="animate-in fade-in slide-in-from-top-1" tw-class="text-[10px] text-red-500 font-bold ml-1 leading-relaxed duration-200">{{ error }}</p>
              </div>
            </div>

            <div tw-class="space-y-2" v-if="effectiveEndpoint && isHttpEndpoint(effectiveEndpoint)">
              <div tw-class="flex items-center justify-between ml-1">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__custom_http_headers() }}</label>
                <button
                  @click="addHeader"
                  type="button"
                  tw-class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
                >
                  <PlusIcon tw-class="w-2.5 h-2.5" />
                  {{ lazyStrings.ChatSettingsPanel__add_header() }}
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
                    :placeholder="lazyStrings.ChatSettingsPanel__name()"
                  />
                  <input
                    v-model="header[1]"
                    @blur="saveChangesFromUi"
                    type="text"
                    tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                    :placeholder="lazyStrings.ChatSettingsPanel__value()"
                  />
                  <button
                    @click="removeHeader({ index })"
                    tw-class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2Icon tw-class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div v-else tw-class="text-[10px] text-gray-400 italic ml-1">{{ lazyStrings.ChatSettingsPanel__no_custom_headers() }}</div>
            </div>

            <div tw-class="space-y-4">
              <div tw-class="space-y-2">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__model_override() }}</label>
                <ModelSelector
                  :model-value="localSettings.modelId"
                  @update:model-value="val => { localSettings.modelId = val; saveChangesFromUi(); }"
                  :models="sortedAvailableModels"
                  :loading="isFetchingModels"
                  :disabled="effectiveEndpointType === 'browser_provided_lm'"
                  :placeholder="formatSettingsSourceLabel({ value: resolvedSettings?.modelId, source: resolvedSettings?.sources.modelId })"
                  :allow-clear="true"
                  @refresh="fetchModels"
                  data-testid="chat-setting-model-select"
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
          <div tw-class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl space-y-6">
            <div tw-class="flex items-center justify-between">
              <div tw-class="flex items-center gap-3">
                <div tw-class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
                  <Settings2Icon tw-class="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <h4 tw-class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__automatic_title() }}</h4>
                  <p tw-class="text-[10px] text-gray-500 dark:text-gray-400 font-medium">{{ lazyStrings.ChatSettingsPanel__configure_how_this_chat_is_automatically_named() }}</p>
                </div>
              </div>
              <div tw-class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                <button
                  @click="setLocalTitleGenerationMode({ mode: 'inherit' })"
                  :tw-class="['px-3 py-1 text-[9px] font-bold rounded transition-all', localTitleGenerationMode === 'inherit' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                >
                  {{ lazyStrings.ChatSettingsPanel__use_chat_group_setting() }}
                </button>
                <button
                  @click="setLocalTitleGenerationMode({ mode: 'enabled' })"
                  :tw-class="['px-3 py-1 text-[9px] font-bold rounded transition-all', localTitleGenerationMode === 'enabled' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                >
                  {{ lazyStrings.ChatSettingsPanel__enabled() }}
                </button>
                <button
                  @click="setLocalTitleGenerationMode({ mode: 'disabled' })"
                  :tw-class="['px-3 py-1 text-[9px] font-bold rounded transition-all', localTitleGenerationMode === 'disabled' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                >
                  {{ lazyStrings.ChatSettingsPanel__disabled() }}
                </button>
              </div>
            </div>

            <div v-if="localTitleGenerationMode === 'enabled'" tw-class="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-gray-50 dark:border-gray-800/50">
              <div tw-class="space-y-2">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__title_endpoint_type() }}</label>
                <select
                  :value="localTitleEndpointSelectValue"
                  @change="handleTitleEndpointTypeChange({ event: $event })"
                  tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                  data-testid="chat-setting-title-endpoint-type-select"
                >
                  <option value="same_scope">{{ lazyStrings.ChatSettingsPanel__same_as_chat_endpoint() }}</option>
                  <option value="openai">{{ lazyStrings.ChatSettingsPanel__openai_compatible() }}</option>
                  <option value="ollama">{{ lazyStrings.ChatSettingsPanel__ollama() }}</option>
                  <option value="transformers_js">{{ lazyStrings.ChatSettingsPanel__transformers_js_experimental() }}</option>
                  <option value="browser_provided_lm" :tw-class="{ 'text-gray-400': !isPromptApiSupported }">{{ lazyStrings.SHARED__browser_provided() }}</option>
                  <option
                    v-if="localTitleEndpointSelectValue === 'unsupported_experimental_endpoint'"
                    value="unsupported_experimental_endpoint"
                    disabled
                  >{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option>
                </select>
              </div>

              <div v-if="!localTitleEndpointUsesSameScope && isHttpEndpoint(effectiveTitleEndpoint)" tw-class="space-y-2">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__endpoint_url() }}</label>
                <input
                  v-model="localTitleEndpointUrl"
                  @blur="saveChangesFromUi"
                  @keyup.enter="(e) => (e.target as HTMLInputElement).blur()"
                  type="text"
                  tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  :placeholder="isHttpEndpoint(effectiveEndpoint) ? effectiveEndpoint.url : undefined"
                  data-testid="chat-setting-title-endpoint-url-input"
                />
              </div>

              <div tw-class="space-y-2">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__title_model_override() }}</label>
                <ModelSelector
                  :model-value="localTitleModelId"
                  @update:model-value="val => setLocalTitleModelId({ modelId: val })"
                  :models="titleModelOptions"
                  :loading="titleModelLoading"
                  :placeholder="localTitleEndpointUsesSameScope ? formatSettingsSourceLabel({ value: resolvedSettings?.titleModelId, source: resolvedSettings?.sources.titleModelId }) : undefined"
                  :allow-clear="localTitleEndpointUsesSameScope"
                  :clear-label="formatSettingsSourceLabel({ value: resolvedSettings?.titleModelId, source: resolvedSettings?.sources.titleModelId })"
                  :disabled="effectiveTitleEndpoint.type === 'browser_provided_lm'"
                  @refresh="fetchTitleEndpointModels"
                  data-testid="chat-setting-title-model-select"
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
                <p tw-class="text-[10px] font-bold text-blue-900/70 dark:text-blue-300 uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__auto_check() }}</p>
                <p tw-class="text-[11px] text-gray-500 dark:text-blue-400/70 leading-relaxed font-medium">{{ lazyStrings.ChatSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls() }}</p>
              </div>
            </div>

            <div tw-class="flex items-start gap-4 p-4 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm">
              <div tw-class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700">
                <AlertCircleIcon tw-class="w-4 h-4 text-gray-400" />
              </div>
              <div tw-class="space-y-1">
                <p tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-400 uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__local_overrides() }}</p>
                <p tw-class="text-[11px] text-gray-500/70 dark:text-gray-400/70 leading-relaxed font-medium">
                  {{ lazyStrings.ChatSettingsPanel__these_settings_only_apply_to_this_chat() }}
                  <button
                    @click="handleRestoreDefaults"
                    tw-class="font-bold underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    data-testid="chat-setting-restore-defaults"
                  >
                    {{ lazyStrings.ChatSettingsPanel__restore_defaults() }}
                  </button>.
                </p>
              </div>
            </div>
          </div>

          <!-- System Prompt and Parameters -->
          <div tw-class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-8">
            <div tw-class="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div tw-class="md:col-span-2 space-y-4">
                <div tw-class="flex items-center justify-between">
                  <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                    <MessageSquareQuoteIcon tw-class="w-3 h-3" />
                    {{ lazyStrings.ChatSettingsPanel__chat_system_prompt() }}
                  </label>

                  <div tw-class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'inherit' })"
                      :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', !localSettings.systemPrompt ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                    >
                      {{ lazyStrings.ChatSettingsPanel__inherit() }}
                    </button>
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'clear' })"
                      :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                    >
                      {{ lazyStrings.ChatSettingsPanel__clear() }}
                    </button>
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'replace' })"
                      :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content !== null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                    >
                      {{ lazyStrings.ChatSettingsPanel__override() }}
                    </button>
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'append' })"
                      :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', localSettings.systemPrompt?.behavior === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
                    >
                      {{ lazyStrings.ChatSettingsPanel__append() }}
                    </button>
                  </div>
                </div>
                <div v-if="!localSettings.systemPrompt" tw-class="w-full bg-gray-50/50 dark:bg-gray-800/30 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-left">
                  <p tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">{{ lazyStrings.ChatSettingsPanel__inherited_instructions() }}</p>
                  <p tw-class="text-xs text-gray-400 dark:text-gray-500 italic whitespace-pre-wrap line-clamp-6">
                    {{ inheritedSettings?.systemPromptMessages?.join('\n\n') || lazyStrings.ChatSettingsPanel__no_instructions_inherited() }}
                  </p>
                </div>
                <div v-else-if="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null" tw-class="w-full bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center">
                  <p tw-class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__parent_prompt_cleared() }}</p>
                  <p tw-class="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{{ lazyStrings.ChatSettingsPanel__this_chat_will_not_use_any_system_instructions() }}</p>
                </div>
                <textarea
                  v-else
                  :value="localSettings.systemPrompt?.content || ''"
                  @input="e => updateSystemPromptContent({ content: (e.target as HTMLTextAreaElement).value })"
                  @blur="saveChangesFromUi"
                  rows="4"
                  tw-class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                  :placeholder="localSettings.systemPrompt?.behavior === 'append' ? lazyStrings.ChatSettingsPanel__added_after_global_instructions() : lazyStrings.ChatSettingsPanel__completely_replaces_global_instructions()"
                  data-testid="chat-setting-system-prompt-textarea"
                ></textarea>
              </div>

              <div tw-class="space-y-4">
                <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <LayersIcon tw-class="w-3 h-3" />
                  {{ lazyStrings.ChatSettingsPanel__settings_resolution() }}
                </label>
                <div tw-class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-3">
                  <div tw-class="flex items-center justify-between text-[10px] font-bold">
                    <span tw-class="text-gray-400">{{ lazyStrings.ChatSettingsPanel__system_prompt() }}</span>
                    <span :tw-class="localSettings.systemPrompt ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-system-prompt">
                      {{ localSettings.systemPrompt ? (localSettings.systemPrompt.behavior === 'append' ? lazyStrings.ChatSettingsPanel__appending() : (localSettings.systemPrompt.content === null ? lazyStrings.ChatSettingsPanel__cleared() : lazyStrings.ChatSettingsPanel__overriding())) : lazyStrings.ChatSettingsPanel__group_global_default() }}
                    </span>
                  </div>
                  <div tw-class="flex items-center justify-between text-[10px] font-bold">
                    <span tw-class="text-gray-400">{{ lazyStrings.ChatSettingsPanel__parameters() }}</span>
                    <span :tw-class="hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-lm-parameters">
                      {{ hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? lazyStrings.ChatSettingsPanel__chat_overrides() : lazyStrings.ChatSettingsPanel__inherited() }}
                    </span>
                  </div>
                  <div tw-class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                    <p tw-class="text-[9px] text-gray-400 leading-relaxed italic">{{ lazyStrings.ChatSettingsPanel__chat_settings_take_precedence_over_provider_profiles_which_take_precedence_over_group_settings_which_take_precedence_over_global_settings() }}</p>
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
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
            <style scoped>
/* Modal Transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.9);
  opacity: 0;
}

.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes slide-in-from-top {
  from { transform: translateY(-0.5rem); }
  to { transform: translateY(0); }
}
.slide-in-from-top-1 {
  animation-name: slide-in-from-top;
}
</style>
