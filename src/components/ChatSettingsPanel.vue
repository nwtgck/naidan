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
  Reasoning,
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
  cloneLmParameters as clonePlainLmParameters,
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
  systemPrompt: SystemPrompt | undefined,
  lmParameters: LmParameters | undefined,
};

function emptyDraft(): ChatSettingsDraft {
  return {
    endpoint: undefined,
    modelId: undefined,
    titleGeneration: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
  };
}

function cloneDraft({ draft }: { draft: ChatSettingsDraft }): ChatSettingsDraft {
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: draft.endpoint }),
    modelId: draft.modelId,
    titleGeneration: cloneScopedTitleGeneration({ titleGeneration: draft.titleGeneration }),
    systemPrompt: draft.systemPrompt === undefined ? undefined : { ...draft.systemPrompt },
    lmParameters: clonePlainLmParameters({ lmParameters: draft.lmParameters }),
  };
}

function draftFromChat({ chat }: { chat: Chat }): ChatSettingsDraft {
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: chat.endpoint }),
    modelId: chat.modelId,
    titleGeneration: cloneScopedTitleGeneration({ titleGeneration: chat.titleGeneration }),
    systemPrompt: chat.systemPrompt === undefined ? undefined : { ...chat.systemPrompt },
    lmParameters: clonePlainLmParameters({ lmParameters: chat.lmParameters }),
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
      lmParameters: cloneTitleLmParameters({ lmParameters: titleGeneration.lmParameters }) ?? emptyLmParameters(),
    }
    : {
      endpoint: cloneEndpoint({ endpoint: titleGeneration.endpoint }),
      model: { ...titleGeneration.model },
      lmParameters: clonePlainLmParameters({ lmParameters: titleGeneration.lmParameters }) ?? emptyLmParameters(),
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
  if (!areLmParametersEqual({ left: left.lmParameters, right: right.lmParameters })) return false;
  if (left.endpoint === 'same_scope' || right.endpoint === 'same_scope') {
    return left.endpoint === right.endpoint;
  }
  return areEndpointsEqual({ left: left.endpoint, right: right.endpoint });
}

type TitleGenerationMode = 'inherit' | 'override' | 'disabled';

type ScopedTitleGenerationDraft =
  | 'inherit'
  | 'disabled'
  | {
      endpoint: 'same_scope',
      model: 'same_scope' | { id: string },
      lmParameters?: 'same_scope' | LmParameters,
    }
  | {
      endpoint: Endpoint,
      model: { id: string },
      lmParameters?: LmParameters,
    };

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

type TitleReasoningSelectValue = 'inherit' | 'same_scope' | Reasoning['effort'];

function emptyLmParameters(): LmParameters {
  return {
    ...EMPTY_LM_PARAMETERS,
    reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
  };
}

function cloneTitleLmParameters({
  lmParameters,
}: {
  lmParameters: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters | undefined {
  if (lmParameters === undefined) return undefined;
  if (lmParameters === 'same_scope') return 'same_scope';
  return clonePlainLmParameters({ lmParameters }) ?? emptyLmParameters();
}

function titleLmParametersForEndpoint({
  endpoint,
  lmParameters,
}: {
  endpoint: Endpoint | 'same_scope',
  lmParameters: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters {
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') return 'same_scope';
  return cloneTitleLmParameters({ lmParameters }) as LmParameters | undefined ?? emptyLmParameters();
}

function areLmParametersEqual({
  left,
  right,
}: {
  left: 'same_scope' | LmParameters | undefined,
  right: 'same_scope' | LmParameters | undefined,
}): boolean {
  return JSON.stringify(left ?? emptyLmParameters()) === JSON.stringify(right ?? emptyLmParameters());
}

function titleGenerationWithLmParameters({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGenerationDraft,
}): ScopedTitleGeneration {
  if (typeof titleGeneration === 'string') return titleGeneration;

  const current = localTitleGeneration.value;
  const currentLmParameters = current === 'inherit'
    ? inheritedLmParameters()
    : typeof current === 'string'
      ? undefined
      : current.lmParameters;
  return {
    ...titleGeneration,
    lmParameters: titleLmParametersForEndpoint({
      endpoint: titleGeneration.endpoint,
      lmParameters: titleGeneration.lmParameters ?? currentLmParameters,
    }),
  } as ScopedTitleGeneration;
}

function titleReasoningSelectValueFromLmParameters({
  endpoint,
  lmParameters,
}: {
  endpoint: Endpoint | 'same_scope',
  lmParameters: 'same_scope' | LmParameters | undefined,
}): TitleReasoningSelectValue {
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') return 'same_scope';
  return lmParameters !== 'same_scope' && lmParameters?.reasoning?.effort !== undefined
    ? lmParameters.reasoning.effort
    : undefined;
}

function titleLmParametersFromReasoningSelectValue({
  value,
  current,
}: {
  value: Exclude<TitleReasoningSelectValue, 'inherit'>,
  current: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters {
  switch (value) {
  case 'same_scope':
    return 'same_scope';
  case undefined: {
    const lmParameters = current === 'same_scope'
      ? emptyLmParameters()
      : clonePlainLmParameters({ lmParameters: current }) ?? emptyLmParameters();
    lmParameters.reasoning.effort = undefined;
    return lmParameters;
  }
  case 'none':
  case 'low':
  case 'medium':
  case 'high': {
    const lmParameters = current === 'same_scope'
      ? emptyLmParameters()
      : clonePlainLmParameters({ lmParameters: current }) ?? emptyLmParameters();
    lmParameters.reasoning.effort = value;
    return lmParameters;
  }
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled title reasoning value: ${_ex}`);
  }
  }
}

function reasoningEffortLabel({ effort }: { effort: Reasoning['effort'] }): string | undefined {
  switch (effort) {
  case undefined:
    return lazyStrings.ReasoningSettings__default();
  case 'none':
    return lazyStrings.ReasoningSettings__off();
  case 'low':
    return lazyStrings.ReasoningSettings__low();
  case 'medium':
    return lazyStrings.ReasoningSettings__medium();
  case 'high':
    return lazyStrings.ReasoningSettings__high();
  default: {
    const _ex: never = effort;
    throw new Error(`Unhandled reasoning effort: ${_ex}`);
  }
  }
}

function titleReasoningLabel({
  lmParameters,
  sameScopeEffort,
}: {
  lmParameters: 'same_scope' | LmParameters | undefined,
  sameScopeEffort: Reasoning['effort'],
}): string | undefined {
  return lmParameters === 'same_scope'
    ? reasoningEffortLabel({ effort: sameScopeEffort })
    : reasoningEffortLabel({ effort: lmParameters?.reasoning?.effort });
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
  return lazyStrings.ChatSettingsPanel__title_model_explanation({
    inheritance: { type: 'none' },
  });
}

function endpointTypeValueLabel({ endpoint }: { endpoint: Endpoint }): string | undefined {
  return endpointTypeLabel({ endpointType: endpoint.type });
}

function mergedLmParameters({
  base,
  overrides,
}: {
  base: LmParameters | undefined,
  overrides: LmParameters | undefined,
}): LmParameters | undefined {
  const lmParameters = clonePlainLmParameters({ lmParameters: base }) ?? emptyLmParameters();
  if (overrides === undefined) return normalizeLmParameters({ lmParameters });

  if (overrides.temperature !== undefined) lmParameters.temperature = overrides.temperature;
  if (overrides.topP !== undefined) lmParameters.topP = overrides.topP;
  if (overrides.maxCompletionTokens !== undefined) lmParameters.maxCompletionTokens = overrides.maxCompletionTokens;
  if (overrides.presencePenalty !== undefined) lmParameters.presencePenalty = overrides.presencePenalty;
  if (overrides.frequencyPenalty !== undefined) lmParameters.frequencyPenalty = overrides.frequencyPenalty;
  if (overrides.stop !== undefined) lmParameters.stop = [...overrides.stop];
  if (overrides.reasoning?.effort !== undefined) lmParameters.reasoning.effort = overrides.reasoning.effort;

  return normalizeLmParameters({ lmParameters });
}

function localSameScopeLmParameters(): LmParameters | undefined {
  return mergedLmParameters({
    base: inheritedSettings.value?.lmParameters,
    overrides: localSettings.value.lmParameters,
  });
}

function inheritedLmParameters(): LmParameters | undefined {
  const titleGeneration = inheritedSettings.value?.titleGeneration;
  if (titleGeneration === undefined || titleGeneration === 'disabled') return undefined;
  return titleGeneration.lmParameters;
}

function materializedLocalLmParameters(): LmParameters | undefined {
  const titleGeneration = localTitleGeneration.value;
  if (titleGeneration === 'disabled') return undefined;
  if (titleGeneration === 'inherit') return clonePlainLmParameters({ lmParameters: inheritedLmParameters() });
  if (titleGeneration.lmParameters === 'same_scope') return localSameScopeLmParameters();
  return clonePlainLmParameters({ lmParameters: titleGeneration.lmParameters });
}

function materializedLocalTitleGeneration(): Exclude<ScopedTitleGeneration, 'inherit' | 'disabled'> {
  return {
    endpoint: cloneEndpoint({ endpoint: effectiveTitleEndpoint.value }),
    model: explicitTitleModel({ modelId: effectiveTitleModelId.value }),
    lmParameters: clonePlainLmParameters({ lmParameters: materializedLocalLmParameters() }) ?? emptyLmParameters(),
  };
}

const inheritedTitleEndpointTypeOptionLabel = computed(() => formatSettingsSourceLabel({
  value: inheritedSettings.value?.titleGeneration === 'disabled'
    ? lazyStrings.ChatSettingsPanel__disabled()
    : inheritedSettings.value?.titleGeneration === undefined
      ? undefined
      : endpointTypeValueLabel({ endpoint: inheritedSettings.value.titleGeneration.endpoint }),
  source: 'chat_group',
}));
const sameScopeTitleEndpointTypeOptionLabel = computed(() => formatSettingsSourceLabel({
  value: endpointTypeValueLabel({ endpoint: effectiveEndpoint.value }),
  source: 'chat',
}));


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
const activeTitleEndpoint = computed<Endpoint | undefined>(() => {
  if (localTitleEndpoint.value === 'inherit') {
    return inheritedSettings.value?.titleGeneration === 'disabled'
      ? undefined
      : inheritedSettings.value?.titleGeneration?.endpoint;
  }
  if (localTitleEndpoint.value === 'same_scope') return effectiveEndpoint.value;
  return localTitleEndpoint.value;
});
const effectiveTitleEndpoint = computed<Endpoint>(() => activeTitleEndpoint.value ?? effectiveEndpoint.value);
const effectiveTitleEndpointType = computed(() => effectiveTitleEndpoint.value.type);
const localTitleEndpointUrl = computed({
  get: () => (activeTitleEndpoint.value !== undefined && isHttpEndpoint(activeTitleEndpoint.value) ? activeTitleEndpoint.value.url : ''),
  set: (url: string) => {
    const endpoint = activeTitleEndpoint.value;
    if (endpoint === undefined || !isHttpEndpoint(endpoint)) return;
    updateLocalTitleGenerationDraft({
      titleGeneration: {
        endpoint: {
          type: endpoint.type,
          url,
          httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
        },
        model: explicitTitleModel({ modelId: effectiveTitleModelId.value })
      },
    });
  },
});
const localTitleEndpointHttpHeaders = computed(() => {
  const endpoint = activeTitleEndpoint.value;
  return endpoint !== undefined && isHttpEndpoint(endpoint)
    ? endpoint.httpHeaders?.map(([name, value]) => [name, value] as [string, string]) ?? []
    : undefined;
});

function setLocalTitleEndpointHttpHeaders({
  httpHeaders,
}: {
  httpHeaders: [string, string][],
}): void {
  const endpoint = activeTitleEndpoint.value;
  if (endpoint === undefined || !isHttpEndpoint(endpoint)) return;
  updateLocalTitleGenerationDraft({
    titleGeneration: {
      endpoint: {
        type: endpoint.type,
        url: endpoint.url,
        httpHeaders,
      },
      model: explicitTitleModel({ modelId: effectiveTitleModelId.value })
      },
  });
}

function addLocalTitleHeader(): void {
  const headers = localTitleEndpointHttpHeaders.value;
  if (headers === undefined) return;
  setLocalTitleEndpointHttpHeaders({ httpHeaders: [...headers, ['', '']] });
}

function updateLocalTitleHeader({
  index,
  field,
  value,
}: {
  index: number,
  field: 0 | 1,
  value: string,
}): void {
  const headers = localTitleEndpointHttpHeaders.value;
  if (headers === undefined) return;
  setLocalTitleEndpointHttpHeaders({
    httpHeaders: headers.map((header, headerIndex) => headerIndex === index
      ? ([field === 0 ? value : header[0], field === 1 ? value : header[1]] as [string, string])
      : header),
  });
}

async function removeLocalTitleHeader({ index }: { index: number }): Promise<void> {
  const headers = localTitleEndpointHttpHeaders.value;
  if (headers !== undefined) {
    setLocalTitleEndpointHttpHeaders({ httpHeaders: headers.filter((_, headerIndex) => headerIndex !== index) });
  }
  await saveChangesFromUi();
}
const titleModelOptions = computed(() => {
  return localTitleEndpointUsesSameScope.value
    ? sortedAvailableModels.value
    : sortedTitleEndpointModels.value;
});
const titleModelLoading = computed(() => {
  return localTitleEndpointUsesSameScope.value
    ? isFetchingModels.value
    : isFetchingTitleEndpointModels.value;
});
const effectiveModelId = computed(() => localSettings.value.modelId || inheritedSettings.value?.modelId || settings.value.defaultModelId);
const inheritedTitleModelOptionLabel = computed(() => formatSettingsSourceLabel({
  value: inheritedSettings.value?.titleGeneration === 'disabled'
    ? lazyStrings.ChatSettingsPanel__disabled()
    : inheritedSettings.value?.titleGeneration?.modelId,
  source: 'chat_group',
}));
const sameScopeTitleModelOptionLabel = computed(() => formatSettingsSourceLabel({
  value: effectiveModelId.value,
  source: 'chat',
}));

function reasoningEffortFromTitleReasoningValue({
  value,
}: {
  value: TitleReasoningSelectValue,
}): Reasoning['effort'] {
  switch (value) {
  case 'inherit':
  case 'same_scope':
  case undefined:
    return undefined;
  case 'none':
  case 'low':
  case 'medium':
  case 'high':
    return value;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled title reasoning value: ${_ex}`);
  }
  }
}

const sameScopeReasoningEffort = computed<Reasoning['effort']>(() => (
  localSettings.value.lmParameters?.reasoning?.effort
  ?? inheritedSettings.value?.lmParameters?.reasoning?.effort
  ?? settings.value.lmParameters?.reasoning?.effort
));

const inheritedTitleReasoningOptionLabel = computed(() => formatSettingsSourceLabel({
  value: inheritedSettings.value?.titleGeneration === 'disabled'
    ? lazyStrings.ChatSettingsPanel__disabled()
    : titleReasoningLabel({ lmParameters: inheritedLmParameters(), sameScopeEffort: undefined }),
  source: inheritedSettings.value?.sources.titleGeneration,
}));
const sameScopeTitleReasoningOptionLabel = computed(() => formatSettingsSourceLabel({
  value: reasoningEffortLabel({ effort: sameScopeReasoningEffort.value }),
  source: 'chat',
}));
const titleReasoningLeadingOptions = computed(() => ([
  {
    value: 'inherit' as const,
    label: inheritedTitleReasoningOptionLabel.value,
    shortLabel: inheritedTitleReasoningOptionLabel.value,
    testId: 'inherit',
  },
  {
    value: 'same_scope' as const,
    label: localTitleEndpointUsesSameScope.value ? sameScopeTitleReasoningOptionLabel.value : undefined,
    shortLabel: localTitleEndpointUsesSameScope.value ? sameScopeTitleReasoningOptionLabel.value : undefined,
    testId: 'same-scope',
  },
]));
const effectiveTitleModelId = computed(() => {
  if (localTitleEndpointUsesInheritance.value) {
    return inheritedSettings.value?.titleGeneration === 'disabled'
      ? undefined
      : inheritedSettings.value?.titleGeneration?.modelId;
  }
  if (localTitleEndpointUsesSameScope.value) return effectiveModelId.value;
  return localTitleModelId.value;
});

const localTitleReasoningSelectValue = computed<TitleReasoningSelectValue>(() => {
  const titleGeneration = localTitleGeneration.value;
  if (titleGeneration === 'inherit') return 'inherit';
  if (titleGeneration === 'disabled') return undefined;
  return titleReasoningSelectValueFromLmParameters({
    endpoint: titleGeneration.endpoint,
    lmParameters: titleGeneration.lmParameters,
  });
});

function setLocalTitleReasoningSelectValue({
  value,
}: {
  value: TitleReasoningSelectValue,
}): void {
  switch (value) {
  case 'inherit':
    setLocalTitleGeneration({ titleGeneration: 'inherit' });
    return;
  case 'same_scope':
  case undefined:
  case 'none':
  case 'low':
  case 'medium':
  case 'high':
    break;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled title reasoning value: ${_ex}`);
  }
  }

  const current = localTitleGeneration.value;
  if (current === 'disabled') return;

  switch (value) {
  case 'same_scope': {
    const base = current === 'inherit'
      ? materializedLocalTitleGeneration()
      : current;
    if (typeof base === 'string') return;
    setLocalTitleGeneration({
      titleGeneration: {
        ...base,
        lmParameters: titleLmParametersForEndpoint({
          endpoint: base.endpoint,
          lmParameters: 'same_scope',
        }),
      } as ScopedTitleGeneration,
    });
    return;
  }
  case undefined:
  case 'none':
  case 'low':
  case 'medium':
  case 'high':
    break;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled title reasoning value: ${_ex}`);
  }
  }

  const base = materializedLocalTitleGeneration();
  const nextLmParameters = titleLmParametersFromReasoningSelectValue({
    value,
    current: base.lmParameters,
  });

  setLocalTitleGeneration({
    titleGeneration: {
      ...base,
      lmParameters: nextLmParameters === 'same_scope'
        ? emptyLmParameters()
        : nextLmParameters,
    },
  });
}


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
        model: sameScopeTitleModel({ modelId })
      },
    });
    return;
  }
  case 'browser_provided_lm':
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: { type: 'browser_provided_lm' },
        model: { id: BROWSER_PROVIDED_LM_MODEL_ID }
      },
    });
    return;
  case 'transformers_js': {
    const nextEndpoint: Endpoint = { type: 'transformers_js' };
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: nextEndpoint,
        model: explicitTitleModel({ modelId: preservedTitleModelIdForEndpoint({ nextEndpoint }) })
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
      preferred: currentTitleEndpoint === 'same_scope' || currentTitleEndpoint === 'inherit' ? activeTitleEndpoint.value : currentTitleEndpoint,
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
        model: explicitTitleModel({ modelId: preservedTitleModelIdForEndpoint({ nextEndpoint }) })
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
    titleEndpointModels.value = models ?? [];
    const titleGeneration = localTitleGeneration.value;
    if (typeof titleGeneration === 'string' || titleGeneration.endpoint === 'same_scope') return;
    if (!titleEndpointModels.value.includes(titleGeneration.model.id) && titleEndpointModels.value[0] !== undefined) {
      setLocalTitleGeneration({
        titleGeneration: {
          endpoint: cloneEndpoint({ endpoint: titleGeneration.endpoint }),
          model: { id: titleEndpointModels.value[0] }
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
  titleGeneration: ScopedTitleGenerationDraft,
}): void {
  localSettings.value.titleGeneration = cloneScopedTitleGeneration({
    titleGeneration: titleGenerationWithLmParameters({ titleGeneration }),
  });
}

function setLocalTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGenerationDraft,
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
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
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
  return { id: modelId || titleModelOptions.value[0] || effectiveModelId.value || BROWSER_PROVIDED_LM_MODEL_ID };
}

function setLocalTitleModelId({
  modelId,
}: {
  modelId: string | undefined,
}): void {
  const titleGeneration = localTitleGeneration.value;
  if (titleGeneration === 'inherit') {
    if (modelId === undefined || modelId === '') {
      setLocalTitleGeneration({ titleGeneration: 'inherit' });
      return;
    }
    const endpoint = activeTitleEndpoint.value;
    if (endpoint === undefined) {
      setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: { id: modelId }  } });
      return;
    }
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: cloneEndpoint({ endpoint }),
        model: { id: modelId }
      },
    });
    return;
  }
  const endpoint = typeof titleGeneration === 'string' ? 'same_scope' : titleGeneration.endpoint;
  if (endpoint === 'same_scope') {
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: sameScopeTitleModel({ modelId })  } });
    return;
  }
  setLocalTitleGeneration({
    titleGeneration: {
      endpoint: cloneEndpoint({ endpoint }),
      model: explicitTitleModel({ modelId })
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
    const endpoint = localSettings.value.endpoint ?? inheritedSettings.value?.endpoint;
    if (!endpoint || !isHttpEndpoint(endpoint)) return;
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
  const titleGeneration = localSettings.value.titleGeneration;
  if (typeof titleGeneration !== 'string' && titleGeneration?.model !== 'same_scope' && titleGeneration?.model.id === BROWSER_PROVIDED_LM_MODEL_ID) {
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
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
  setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
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
    setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
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
      ? { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() }
      : { endpoint: 'same_scope', model: { id: providerProfile.titleModelId }, lmParameters: emptyLmParameters() };
    localSettings.value.systemPrompt = providerProfile.systemPrompt
      ? { content: providerProfile.systemPrompt, behavior: 'override' }
      : undefined;
    localSettings.value.lmParameters = clonePlainLmParameters({ lmParameters: providerProfile.lmParameters });
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
      updateLocalTitleGenerationDraft({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
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

watch(
  [localTitleEndpointUrl, effectiveTitleEndpointType, localTitleEndpointUsesInheritance, localTitleEndpointUsesSameScope],
  ([url, type]) => {
    error.value = null;
    if (localTitleGenerationMode.value !== 'disabled' && !localTitleEndpointUsesSameScope.value) {
      if (type === 'transformers_js' || type === 'browser_provided_lm' || (url && isLocalhost({ url }))) void fetchTitleEndpointModels();
    }
  },
  { immediate: true },
);


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
                  @click="setLocalTitleGenerationMode({ mode: 'override' })"
                  :tw-class="['px-3 py-1 text-[9px] font-bold rounded transition-all', localTitleGenerationMode === 'override' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
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

            <div v-if="localTitleGenerationMode === 'override'" tw-class="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-gray-50 dark:border-gray-800/50">
              <div tw-class="space-y-2">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__title_endpoint_type() }}</label>
                <select
                  :value="localTitleEndpointSelectValue"
                  @change="handleTitleEndpointTypeChange({ event: $event })"
                  tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                  data-testid="chat-setting-title-endpoint-type-select"
                >
                  <option value="inherit">{{ inheritedTitleEndpointTypeOptionLabel }}</option>
                  <option value="same_scope">{{ sameScopeTitleEndpointTypeOptionLabel }}</option>
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

              <div tw-class="space-y-2">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__endpoint_url() }}</label>
                <input
                  v-model="localTitleEndpointUrl"
                  @blur="saveChangesFromUi"
                  @keyup.enter="(e) => (e.target as HTMLInputElement).blur()"
                  type="text"
                  tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  :placeholder="isHttpEndpoint(effectiveEndpoint) ? effectiveEndpoint.url : undefined"
                  :disabled="activeTitleEndpoint === undefined || !isHttpEndpoint(activeTitleEndpoint)"
                  data-testid="chat-setting-title-endpoint-url-input"
                />
              </div>

              <div v-if="activeTitleEndpoint !== undefined && isHttpEndpoint(activeTitleEndpoint)" tw-class="space-y-3 md:col-span-2">
                <div tw-class="flex items-center justify-between ml-1">
                  <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatSettingsPanel__custom_http_headers() }}</label>
                  <button
                    @click="addLocalTitleHeader"
                    type="button"
                    tw-class="text-[10px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1"
                  >
                    <PlusIcon tw-class="w-3 h-3" />
                    {{ lazyStrings.ChatSettingsPanel__add_header() }}
                  </button>
                </div>

                <div v-if="localTitleEndpointHttpHeaders && localTitleEndpointHttpHeaders.length > 0" tw-class="space-y-2">
                  <div
                    v-for="(header, index) in localTitleEndpointHttpHeaders"
                    :key="index"
                    class="animate-in fade-in slide-in-from-left-1" tw-class="flex gap-2 duration-200"
                  >
                    <input
                      :value="header[0]"
                      @input="updateLocalTitleHeader({ index, field: 0, value: ($event.target as HTMLInputElement).value })"
                      @blur="saveChangesFromUi"
                      type="text"
                      tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      :placeholder="lazyStrings.ChatSettingsPanel__name()"
                      data-testid="chat-setting-title-http-header-name-input"
                    />
                    <input
                      :value="header[1]"
                      @input="updateLocalTitleHeader({ index, field: 1, value: ($event.target as HTMLInputElement).value })"
                      @blur="saveChangesFromUi"
                      type="text"
                      tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      :placeholder="lazyStrings.ChatSettingsPanel__value()"
                      data-testid="chat-setting-title-http-header-value-input"
                    />
                    <button
                      @click="removeLocalTitleHeader({ index })"
                      tw-class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                      data-testid="chat-setting-title-http-header-remove-button"
                    >
                      <Trash2Icon tw-class="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div v-else tw-class="text-[10px] text-gray-400 italic ml-1">{{ lazyStrings.ChatSettingsPanel__no_custom_headers() }}</div>
              </div>

              <div tw-class="space-y-2">
                <label tw-class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.ChatSettingsPanel__title_model_override() }}</label>
                <ModelSelector
                  :model-value="localTitleEndpointUsesInheritance ? undefined : localTitleModelId"
                  @update:model-value="val => setLocalTitleModelId({ modelId: val })"
                  :models="titleModelOptions"
                  :loading="titleModelLoading"
                  :placeholder="localTitleEndpointUsesInheritance ? inheritedTitleModelOptionLabel : (localTitleEndpointUsesSameScope ? sameScopeTitleModelOptionLabel : undefined)"
                  :allow-clear="localTitleEndpointUsesInheritance || localTitleEndpointUsesSameScope"
                  :clear-label="localTitleEndpointUsesInheritance ? inheritedTitleModelOptionLabel : sameScopeTitleModelOptionLabel"
                  :disabled="effectiveTitleEndpoint.type === 'browser_provided_lm'"
                  @refresh="fetchTitleEndpointModels"
                  data-testid="chat-setting-title-model-select"
                />
              </div>
              <div tw-class="md:col-span-2">
                <ReasoningSettings
                  :selected-effort="reasoningEffortFromTitleReasoningValue({ value: localTitleReasoningSelectValue })"
                  :selected-value="localTitleReasoningSelectValue"
                  :leading-options="titleReasoningLeadingOptions"
                  :heading="lazyStrings.ChatSettingsPanel__title_reasoning()"
                  surface="card"
                  @update:value="value => setLocalTitleReasoningSelectValue({ value: value as TitleReasoningSelectValue })"
                  data-testid="chat-setting-title-reasoning-select"
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
                      data-testid="chat-setting-system-prompt-override-button"
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
