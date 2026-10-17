<script setup lang="ts">
import RpcRegistrationSelect from '@/features/naidan-rpc-integration/components/RpcRegistrationSelect.vue';
import type { NaidanRpcRegistrationId } from '@/01-models/ids';
import { getEndpointBuildAvailability } from '@/logic/endpoint-build-availability';
import { ensureStrings, lazyStrings } from '@/strings';
import { computed, onBeforeUnmount, onMounted, ref, watch, useId } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { useChatGroups, type ToolConfigsUpdater } from '@/composables/chat/useChatGroups';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { ChevronDownIcon, FolderOpenIcon, MoreHorizontalIcon, RotateCcwIcon, ChefHatIcon, SearchIcon, SlidersHorizontalIcon, TypeIcon, WrenchIcon, FolderIcon } from 'lucide-vue-next';
import { SCOPED_SETTING_FIELDS, type LmParameterSettingField, type ScopedSettingChange } from '@/01-models/scoped-setting-change';
import type { Endpoint, EndpointType, LmParameters, Reasoning, ScopedTitleGeneration, SystemPrompt } from '@/01-models/types';
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
import type { ChatGroupId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import ModelSelector from './ModelSelector.vue';
import SettingsSelect from './SettingsSelect.vue';
import EndpointPresetButtons from './EndpointPresetButtons.vue';
import SettingsSourceBadge from './SettingsSourceBadge.vue';
import SettingsDisclosure from './SettingsDisclosure.vue';
import SettingsCollapse from './SettingsCollapse.vue';
import HttpHeadersEditor from './HttpHeadersEditor.vue';
import ScopedMountSettings from './ScopedMountSettings.vue';
import SystemPromptSettingsEditor from './SystemPromptSettingsEditor.vue';
import ReasoningSettings from './ReasoningSettings.vue';
import { ENDPOINT_PRESETS } from '@/constants';
import { naturalSort } from '@/utils/string';
import { settingsSourcePresentation, formatSettingsSourceLabel } from '@/logic/settings-labels';
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
import { endpointTypeLabel, endpointTypeDescription, endpointUrlPlaceholder } from './endpoint-type-label';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api';

const LmParametersEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmParametersEditor.vue') });
const RecipeExportModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/recipes/components/RecipeExportModal.vue') });
const ChatGroupToolsSettings = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/tools/components/ChatGroupToolsSettings.vue') });

const { currentChatGroup } = useCurrentChatState();
const { settings } = useSettings();
const rpcEnabled = computed(() => settings.value.experimental?.naidanRpc === 'enabled');
const { setActiveFocusArea } = useLayout();
const chatGroups = useChatGroups();
const chatModels = useChatModels();
const isFetchingModels = ref(false);

const selectedProviderProfileId = ref('');
const error = ref<string | null>(null);
const groupModels = ref<string[]>([]);
const sortedGroupModels = computed(() => naturalSort({ values: groupModels.value || [] }));
let modelRequest = 0;
let titleModelRequest = 0;
const titleEndpointModels = ref<string[]>([]);
const isFetchingTitleEndpointModels = ref(false);
const sortedTitleEndpointModels = computed(() => naturalSort({ values: titleEndpointModels.value }));

const showExportModal = ref(false);

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
    lmParameters: clonePlainLmParameters({ lmParameters: draft.lmParameters }),
  };
}

function draftFromCurrent(): GroupSettingsDraft | undefined {
  const group = currentChatGroup.value;
  if (group === null || group === undefined) {
    return undefined;
  }
  return {
    endpoint: cloneOptionalEndpoint({ endpoint: group.endpoint }),
    modelId: group.modelId,
    titleGeneration: cloneScopedTitleGeneration({ titleGeneration: group.titleGeneration }),
    systemPrompt: group.systemPrompt === undefined ? undefined : { ...group.systemPrompt },
    lmParameters: clonePlainLmParameters({ lmParameters: group.lmParameters }),
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
  if (titleGeneration === undefined) {
    return undefined;
  }
  if (typeof titleGeneration === 'string') {
    return titleGeneration;
  }

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
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  if (typeof left === 'string' || typeof right === 'string') {
    return left === right;
  }
  if (left.model !== right.model) {
    if (left.model === 'same_scope' || right.model === 'same_scope') {
      return false;
    }
    if (left.model.id !== right.model.id) {
      return false;
    }
  }
  if (!areLmParametersEqual({ left: left.lmParameters, right: right.lmParameters })) {
    return false;
  }
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

type MaterializedTitleGeneration = {
  endpoint: Endpoint,
  model: { id: string },
  lmParameters: LmParameters,
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
  if (typeof titleGeneration === 'string' || titleGeneration.model === 'same_scope') {
    return undefined;
  }
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
  if (lmParameters === undefined) {
    return undefined;
  }
  if (lmParameters === 'same_scope') {
    return 'same_scope';
  }
  return clonePlainLmParameters({ lmParameters }) ?? emptyLmParameters();
}

function titleLmParametersForEndpoint({
  endpoint,
  lmParameters,
}: {
  endpoint: Endpoint | 'same_scope',
  lmParameters: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters {
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') {
    return 'same_scope';
  }
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
  if (typeof titleGeneration === 'string') {
    return titleGeneration;
  }

  const current = localTitleGeneration.value;
  const currentLmParameters = current === 'inherit'
    ? materializedGlobalLmParameters()
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
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') {
    return 'same_scope';
  }
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
  naidan_rpc: true,
  llama_cpp_browser: true,
  transformers_js: true,
  browser_provided_lm: true,
};

function endpointTypeFromSelectValue({ value }: { value: string }): EndpointType | undefined {
  if (value === 'global') {
    return undefined;
  }
  if (Object.hasOwn(endpointTypeSelectValueRecord, value)) {
    return value as EndpointType;
  }
  throw new Error(`Unhandled endpoint type value: ${value}`);
}


type TitleEndpointTypeSelectValue = 'inherit' | 'same_scope' | Endpoint['type'];

function titleEndpointTypeFromSelectValue({ value }: { value: string }): TitleEndpointTypeSelectValue {
  if (value === 'inherit') {
    return 'inherit';
  }
  if (value === 'same_scope') {
    return 'same_scope';
  }
  if (value === 'unsupported_experimental_endpoint') {
    return 'unsupported_experimental_endpoint';
  }
  if (Object.hasOwn(endpointTypeSelectValueRecord, value)) {
    return value as EndpointType;
  }
  throw new Error(`Unhandled title endpoint type value: ${value}`);
}

function globalTitleEndpoint(): Endpoint | undefined {
  const titleGeneration = settings.value.titleGeneration;
  if (titleGeneration === 'disabled') {
    return undefined;
  }
  return titleGeneration.endpoint === 'same_scope'
    ? settings.value.endpoint
    : titleGeneration.endpoint;
}

function globalTitleModelId(): string | undefined {
  const titleGeneration = settings.value.titleGeneration;
  if (titleGeneration === 'disabled') {
    return undefined;
  }
  return titleGeneration.model === 'same_scope'
    ? settings.value.defaultModelId
    : titleGeneration.model.id;
}

function globalLmParameters(): 'same_scope' | LmParameters | undefined {
  const titleGeneration = settings.value.titleGeneration;
  if (titleGeneration === 'disabled') {
    return undefined;
  }
  return titleGeneration.lmParameters;
}

function materializedGlobalLmParameters(): LmParameters | undefined {
  const titleGeneration = settings.value.titleGeneration;
  if (titleGeneration === 'disabled') {
    return undefined;
  }
  if (titleGeneration.lmParameters === 'same_scope') {
    return clonePlainLmParameters({ lmParameters: settings.value.lmParameters });
  }
  return clonePlainLmParameters({ lmParameters: titleGeneration.lmParameters });
}

function mergedLmParameters({
  base,
  overrides,
}: {
  base: LmParameters | undefined,
  overrides: LmParameters | undefined,
}): LmParameters | undefined {
  const lmParameters = clonePlainLmParameters({ lmParameters: base }) ?? emptyLmParameters();
  if (overrides === undefined) {
    return normalizeLmParameters({ lmParameters });
  }

  if (overrides.temperature !== undefined) {
    lmParameters.temperature = overrides.temperature;
  }
  if (overrides.topP !== undefined) {
    lmParameters.topP = overrides.topP;
  }
  if (overrides.maxCompletionTokens !== undefined) {
    lmParameters.maxCompletionTokens = overrides.maxCompletionTokens;
  }
  if (overrides.presencePenalty !== undefined) {
    lmParameters.presencePenalty = overrides.presencePenalty;
  }
  if (overrides.frequencyPenalty !== undefined) {
    lmParameters.frequencyPenalty = overrides.frequencyPenalty;
  }
  if (overrides.stop !== undefined) {
    lmParameters.stop = [...overrides.stop];
  }
  if (overrides.reasoning?.effort !== undefined) {
    lmParameters.reasoning.effort = overrides.reasoning.effort;
  }

  return normalizeLmParameters({ lmParameters });
}

function localSameScopeLmParameters(): LmParameters | undefined {
  return mergedLmParameters({
    base: settings.value.lmParameters,
    overrides: localSettings.value.lmParameters,
  });
}

function materializedLocalLmParameters(): LmParameters | undefined {
  const titleGeneration = localTitleGeneration.value;
  if (titleGeneration === 'disabled') {
    return undefined;
  }
  if (titleGeneration === 'inherit') {
    return clonePlainLmParameters({ lmParameters: materializedGlobalLmParameters() });
  }
  if (titleGeneration.lmParameters === 'same_scope') {
    return localSameScopeLmParameters();
  }
  return clonePlainLmParameters({ lmParameters: titleGeneration.lmParameters });
}

function materializedLocalTitleGeneration(): MaterializedTitleGeneration {
  return {
    endpoint: cloneEndpoint({ endpoint: effectiveTitleEndpoint.value }),
    model: explicitTitleModel({ modelId: effectiveTitleModelId.value }),
    lmParameters: clonePlainLmParameters({ lmParameters: materializedLocalLmParameters() }) ?? emptyLmParameters(),
  };
}

function materializedLocalTitleGenerationOverride(): Exclude<ScopedTitleGeneration, 'inherit' | 'disabled'> {
  const resolved = materializedLocalTitleGeneration();
  const sameScopeEndpoint = effectiveEndpoint.value;
  const sameScopeModelId = effectiveModelId.value;
  const sameScopeLmParameters = localSameScopeLmParameters();

  // UX: switching from inherited title settings to a local override should
  // preserve the currently visible effective endpoint/model/parameters. Prefer
  // `same_scope` only when it resolves to the same values; otherwise write the
  // resolved values explicitly so the mode switch itself does not surprise the
  // user by changing the title generation target.
  if (areEndpointsEqual({ left: resolved.endpoint, right: sameScopeEndpoint })) {
    return {
      endpoint: 'same_scope',
      model: resolved.model.id === sameScopeModelId ? 'same_scope' : { id: resolved.model.id },
      lmParameters: areLmParametersEqual({ left: resolved.lmParameters, right: sameScopeLmParameters })
        ? 'same_scope'
        : clonePlainLmParameters({ lmParameters: resolved.lmParameters }) ?? emptyLmParameters(),
    };
  }

  return {
    endpoint: cloneEndpoint({ endpoint: resolved.endpoint }),
    model: { ...resolved.model },
    lmParameters: clonePlainLmParameters({ lmParameters: resolved.lmParameters }) ?? emptyLmParameters(),
  };
}

const effectiveModelId = computed(() => localSettings.value.modelId || settings.value.defaultModelId);

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
  localSettings.value.lmParameters?.reasoning?.effort ?? settings.value.lmParameters?.reasoning?.effort
));

const globalTitleReasoningOptionLabel = computed(() => formatSettingsSourceLabel({
  value: settings.value.titleGeneration === 'disabled'
    ? lazyStrings.ChatGroupSettingsPanel__disabled()
    : titleReasoningLabel({
      lmParameters: globalLmParameters(),
      sameScopeEffort: settings.value.lmParameters?.reasoning?.effort,
    }),
  source: 'global',
}));
const sameScopeTitleReasoningOptionLabel = computed(() => formatSettingsSourceLabel({
  value: reasoningEffortLabel({ effort: sameScopeReasoningEffort.value }),
  source: 'chat_group',
}));
const titleReasoningLeadingOptions = computed(() => ([
  {
    value: 'inherit' as const,
    label: globalTitleReasoningOptionLabel.value,
    shortLabel: globalTitleReasoningOptionLabel.value,
    testId: 'inherit',
  },
  {
    value: 'same_scope' as const,
    label: localTitleEndpointUsesSameScope.value ? sameScopeTitleReasoningOptionLabel.value : undefined,
    shortLabel: localTitleEndpointUsesSameScope.value ? sameScopeTitleReasoningOptionLabel.value : undefined,
    testId: 'same-scope',
  },
]));

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
      if (change !== undefined) {
        changes.push(change);
      }
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
  if (titleGeneration === 'inherit') {
    return 'inherit';
  }
  if (titleGeneration === 'disabled') {
    return 'same_scope';
  }
  return titleGeneration.endpoint;
});
const localTitleEndpointSelectValue = computed<TitleEndpointTypeSelectValue>(() => {
  const endpoint = localTitleEndpoint.value;
  if (endpoint === 'inherit' || endpoint === 'same_scope') {
    return endpoint;
  }
  return endpoint.type;
});
const localTitleEndpointUsesInheritance = computed(() => localTitleEndpoint.value === 'inherit');
const localTitleEndpointUsesSameScope = computed(() => localTitleEndpoint.value === 'same_scope');
const activeTitleEndpoint = computed<Endpoint | undefined>(() => {
  if (localTitleEndpoint.value === 'inherit') {
    return globalTitleEndpoint();
  }
  if (localTitleEndpoint.value === 'same_scope') {
    return effectiveEndpoint.value;
  }
  return localTitleEndpoint.value;
});
const effectiveTitleEndpoint = computed<Endpoint>(() => activeTitleEndpoint.value ?? effectiveEndpoint.value);
const effectiveTitleEndpointType = computed(() => effectiveTitleEndpoint.value.type);
const localTitleEndpointUrl = computed({
  get: () => (activeTitleEndpoint.value !== undefined && isHttpEndpoint(activeTitleEndpoint.value) ? activeTitleEndpoint.value.url : ''),
  set: (url: string) => {
    const endpoint = activeTitleEndpoint.value;
    if (endpoint === undefined || !isHttpEndpoint(endpoint)) {
      return;
    }
    updateLocalTitleGenerationDraft({
      titleGeneration: {
        endpoint: {
          type: endpoint.type,
          url,
          httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
        },
        model: explicitTitleModel({ modelId: effectiveTitleModelId.value }),
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
  if (endpoint === undefined || !isHttpEndpoint(endpoint)) {
    return;
  }
  updateLocalTitleGenerationDraft({
    titleGeneration: {
      endpoint: {
        type: endpoint.type,
        url: endpoint.url,
        httpHeaders,
      },
      model: explicitTitleModel({ modelId: effectiveTitleModelId.value }),
    },
  });
}

const titleModelOptions = computed(() => {
  return localTitleEndpointUsesSameScope.value
    ? sortedGroupModels.value
    : sortedTitleEndpointModels.value;
});
const titleModelLoading = computed(() => {
  return localTitleEndpointUsesSameScope.value
    ? isFetchingModels.value
    : isFetchingTitleEndpointModels.value;
});
const effectiveTitleModelId = computed(() => {
  if (localTitleEndpointUsesInheritance.value) {
    return globalTitleModelId();
  }
  if (localTitleEndpointUsesSameScope.value) {
    return localTitleModelId.value ?? effectiveModelId.value;
  }
  return localTitleModelId.value;
});

const localTitleReasoningSelectValue = computed<TitleReasoningSelectValue>(() => {
  const titleGeneration = localTitleGeneration.value;
  if (titleGeneration === 'inherit') {
    return 'inherit';
  }
  if (titleGeneration === 'disabled') {
    return undefined;
  }
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
  if (current === 'disabled') {
    return;
  }

  switch (value) {
  case 'same_scope': {
    const base = current === 'inherit'
      ? materializedLocalTitleGenerationOverride()
      : current;
    if (typeof base === 'string') {
      return;
    }
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

  const base = current === 'inherit'
    ? materializedLocalTitleGenerationOverride()
    : materializedLocalTitleGeneration();
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
  case 'naidan_rpc': {
    const nextEndpoint: Endpoint = { type: endpointType, registrationId: undefined };
    setLocalTitleGeneration({
      titleGeneration: {
        endpoint: nextEndpoint,
        model: explicitTitleModel({ modelId: preservedTitleModelIdForEndpoint({ nextEndpoint }) }),
      },
    });
    return;
  }
  case 'llama_cpp_browser':
  case 'transformers_js': {
    const nextEndpoint: Endpoint = { type: endpointType };
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

async function fetchTitleEndpointModels(): Promise<void> {
  if (localTitleEndpointUsesSameScope.value) {
    await fetchModels();
    return;
  }
  if (activeTitleEndpoint.value === undefined) {
    titleModelRequest++;
    isFetchingTitleEndpointModels.value = false;
    titleEndpointModels.value = [];
    return;
  }
  const ownerId = currentChatGroup.value?.id;
  const request = ++titleModelRequest;
  const isCurrent = () => request === titleModelRequest && currentChatGroup.value?.id === ownerId && areEndpointsEqual({ left: endpoint, right: effectiveTitleEndpoint.value });
  const endpoint = cloneEndpoint({ endpoint: effectiveTitleEndpoint.value });
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    titleEndpointModels.value = [];
    isFetchingTitleEndpointModels.value = false;
    return;
  }

  isFetchingTitleEndpointModels.value = true;
  try {
    const models = await chatModels.fetchForEndpoint({ endpoint });
    if (!isCurrent()) {
      return;
    }
    titleEndpointModels.value = models ?? [];
    const titleGeneration = localTitleGeneration.value;
    if (typeof titleGeneration === 'string' || titleGeneration.endpoint === 'same_scope') {
      return;
    }
    if (!titleEndpointModels.value.includes(titleGeneration.model.id) && !preservesUnlistedModel({ endpoint, modelId: titleGeneration.model.id }) && titleEndpointModels.value[0] !== undefined) {
      setLocalTitleGeneration({
        titleGeneration: {
          endpoint: cloneEndpoint({ endpoint: titleGeneration.endpoint }),
          model: { id: titleEndpointModels.value[0] },
        },
      });
    }
  } catch (caught) {
    if (!isCurrent()) {
      return;
    }
    error.value = caught instanceof Error
      ? caught.message
      : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
  } finally {
    if (isCurrent()) {
      isFetchingTitleEndpointModels.value = false;
    }
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
    setLocalTitleGeneration({ titleGeneration: materializedLocalTitleGenerationOverride() });
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
    const base = materializedLocalTitleGenerationOverride();
    if (base.endpoint === 'same_scope') {
      setLocalTitleGeneration({
        titleGeneration: {
          ...base,
          model: sameScopeTitleModel({ modelId }),
        },
      });
      return;
    }
    setLocalTitleGeneration({
      titleGeneration: {
        ...base,
        model: { id: modelId },
      },
    });
    return;
  }
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

const localEndpointUrl = computed({
  get: () => {
    const endpoint = localSettings.value.endpoint ?? settings.value.endpoint;
    return endpoint !== undefined && isHttpEndpoint(endpoint)
      ? endpoint.url
      : '';
  },
  set: (url: string) => {
    const previousEndpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
    const endpoint = localSettings.value.endpoint ?? settings.value.endpoint;
    if (!isHttpEndpoint(endpoint)) {
      return;
    }
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
    const endpoint = localSettings.value.endpoint ?? settings.value.endpoint;
    return endpoint !== undefined && isHttpEndpoint(endpoint)
      ? endpoint.httpHeaders
      : undefined;
  },
  set: (httpHeaders) => {
    const endpoint = localSettings.value.endpoint ?? settings.value.endpoint;
    if (!isHttpEndpoint(endpoint)) {
      return;
    }
    localSettings.value.endpoint = {
      type: endpoint.type,
      url: endpoint.url,
      httpHeaders,
    };
  },
});

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
  if (current === undefined || groupId === undefined) {
    return;
  }

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
    if (dirtyFields.has(field)) {
      continue;
    }
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
  if (chatGroupId === undefined) {
    return Promise.resolve();
  }

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
      if (changes.length === 0 && !hasToolConfigUpdate) {
        return;
      }

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
          if (pendingFieldRevisions.get(change.field) !== revision) {
            continue;
          }
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
    if ((type === 'transformers_js' || type === 'llama_cpp_browser') || type === 'browser_provided_lm' || isLocalhost({ url })) {
      void fetchModels();
    }
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
  if (!url) {
    return false;
  }
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
  if (areEndpointModelNamespacesEqual({ left: previousEndpoint, right: nextEndpoint })) {
    return;
  }
  const titleGeneration = localSettings.value.titleGeneration;
  if (titleGeneration === undefined || typeof titleGeneration === 'string' || titleGeneration.endpoint !== 'same_scope' || titleGeneration.model === 'same_scope') {
    return;
  }
  setLocalTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
}

function resetLocalModelsWhenEndpointNamespaceChanges({
  previousEndpoint,
  nextEndpoint,
}: {
  previousEndpoint: Endpoint,
  nextEndpoint: Endpoint,
}): void {
  if (areEndpointModelNamespacesEqual({ left: previousEndpoint, right: nextEndpoint })) {
    return;
  }
  localSettings.value.modelId = undefined;
  resetSameScopeTitleModelWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint });
}


async function changeRpcRegistration({ registrationId, title }: { registrationId: NaidanRpcRegistrationId | undefined, title: boolean }): Promise<void> {
  const nextEndpoint: Endpoint = { type: 'naidan_rpc', registrationId };
  if (title) {
    setLocalTitleGeneration({ titleGeneration: { endpoint: nextEndpoint, model: explicitTitleModel({ modelId: undefined }) } });
  } else {
    const previousEndpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
    localSettings.value.endpoint = nextEndpoint;
    resetLocalModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint });
  }
  await saveChangesFromUi();
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
  case 'naidan_rpc':
    localSettings.value.endpoint = { type: endpointType, registrationId: undefined };
    clearBrowserProvidedLmModelOverrides();
    resetLocalModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: effectiveEndpoint.value });
    break;
  case 'llama_cpp_browser':
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
    const titleLmParameters = materializedLocalLmParameters() ?? emptyLmParameters();
    localSettings.value.endpoint = cloneEndpoint({ endpoint: providerProfile.endpoint });
    localSettings.value.modelId = providerProfile.defaultModelId;
    localSettings.value.titleGeneration = providerProfile.titleModelId === undefined
      ? { endpoint: 'same_scope', model: 'same_scope', lmParameters: titleLmParameters }
      : { endpoint: 'same_scope', model: { id: providerProfile.titleModelId }, lmParameters: titleLmParameters };
    localSettings.value.systemPrompt = providerProfile.systemPrompt
      ? { content: providerProfile.systemPrompt, behavior: 'override' }
      : undefined;
    localSettings.value.lmParameters = clonePlainLmParameters({ lmParameters: providerProfile.lmParameters });
    await saveChangesFromUi();
  }
  error.value = null;
  selectedProviderProfileId.value = '';
}

async function fetchModels() {
  const chatGroupId = currentChatGroup.value?.id;
  if (!chatGroupId) {
    return;
  }
  error.value = null;
  const endpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
  const request = ++modelRequest;
  const isCurrent = () => request === modelRequest && currentChatGroup.value?.id === chatGroupId && areEndpointsEqual({ left: endpoint, right: effectiveEndpoint.value });
  isFetchingModels.value = true;
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    groupModels.value = [];
    isFetchingModels.value = false;
    return;
  }

  try {
    const models = await chatModels.fetchForEndpoint({ endpoint });
    if (!isCurrent()) {
      return;
    }
    groupModels.value = models;
    if (models.length === 0) {
      error.value = await ensureStrings.SHARED__no_models_found_at_this_endpoint();
    }
    let changed = false;
    if (localSettings.value.modelId && !models.includes(localSettings.value.modelId) && !preservesUnlistedModel({ endpoint: endpoint, modelId: localSettings.value.modelId })) {
      localSettings.value.modelId = undefined;
      changed = true;
    }
    const titleGeneration = localTitleGeneration.value;
    if (
      typeof titleGeneration !== 'string'
      && titleGeneration.endpoint === 'same_scope'
      && titleGeneration.model !== 'same_scope'
      && !models.includes(titleGeneration.model.id)
      && !preservesUnlistedModel({ endpoint: endpoint, modelId: titleGeneration.model.id })
    ) {
      updateLocalTitleGenerationDraft({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
      changed = true;
    }
    if (changed) {
      await saveChangesFromUi();
    }
  } catch (caught) {
    if (!isCurrent()) {
      return;
    }
    error.value = caught instanceof Error
      ? caught.message
      : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
  } finally {
    if (isCurrent()) {
      isFetchingModels.value = false;
    }
  }
}

watch([localEndpointUrl, effectiveEndpointType], ([url, type]) => {
  error.value = null;
  if ((type === 'transformers_js' || type === 'llama_cpp_browser') || type === 'browser_provided_lm' || (url && isLocalhost({ url }))) {
    void fetchModels();
  }
});

watch(
  [localTitleEndpointUrl, effectiveTitleEndpointType, localTitleEndpointUsesInheritance, localTitleEndpointUsesSameScope],
  ([url, type]) => {
    error.value = null;
    if (localTitleGenerationMode.value !== 'disabled' && !localTitleEndpointUsesSameScope.value) {
      if ((type === 'transformers_js' || type === 'llama_cpp_browser') || type === 'browser_provided_lm' || (url && isLocalhost({ url }))) {
        void fetchTitleEndpointModels();
      }
    }
  },
  { immediate: true },
);


// Compare captured values rather than draft object identity: an unrelated save
// can echo an equivalent cloned endpoint while a model refresh is in progress.
let observedEndpoint = cloneEndpoint({ endpoint: effectiveEndpoint.value });
let observedTitleEndpoint = cloneOptionalEndpoint({ endpoint: activeTitleEndpoint.value });
watch(effectiveEndpoint, endpoint => {
  if (areEndpointsEqual({ left: endpoint, right: observedEndpoint })) {
    return;
  }
  const previous = observedEndpoint;
  observedEndpoint = cloneEndpoint({ endpoint });
  modelRequest++;
  isFetchingModels.value = false;
  if (!areEndpointModelNamespacesEqual({ left: endpoint, right: previous })) {
    groupModels.value = [];
  }
}, { deep: true, flush: 'sync' });
watch(activeTitleEndpoint, endpoint => {
  if (areOptionalEndpointsEqual({ left: endpoint, right: observedTitleEndpoint })) {
    return;
  }
  const previous = observedTitleEndpoint;
  observedTitleEndpoint = cloneOptionalEndpoint({ endpoint });
  titleModelRequest++;
  isFetchingTitleEndpointModels.value = false;
  if (endpoint === undefined || previous === undefined || !areEndpointModelNamespacesEqual({ left: endpoint, right: previous })) {
    titleEndpointModels.value = [];
  }
}, { deep: true, flush: 'sync' });

function preservesUnlistedModel({ endpoint, modelId }: { endpoint: Endpoint, modelId: string }): boolean {
  return (endpoint.type === 'llama_cpp_browser' && /^(?:hf\.co|host)\//.test(modelId)) || (endpoint.type === 'naidan_rpc' && modelId.startsWith('host/'));
}

watch(() => currentChatGroup.value?.id, () => {
  modelRequest++;
  titleModelRequest++;
  // The endpoint watchers clear only when the model namespace changes; cached
  // candidates for an unchanged endpoint remain usable when selecting another owner.
  isFetchingModels.value = false;
  isFetchingTitleEndpointModels.value = false;
}, { flush: 'sync' });

const parentSystemPromptText = computed(() => settings.value.systemPrompt ?? '');


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
  if (!modelId || !chatGroupId) {
    return;
  }
  const newName = modelId.split('/').pop() || modelId;
  await chatGroups.updateChatGroupMetadata({
    chatGroupId,
    updates: { name: newName },
  });
}


// Presentation stays separate from raw draft values and the existing save commands.
const connectionOpen = ref(false);
const connectionTrigger = ref<HTMLButtonElement | null>(null);
const connectionDetailsId = useId();
const toolsStatus = ref<{ pending: boolean, error: string | undefined, enabledCount: number }>({ pending: false, error: undefined, enabledCount: 0 });
const foldersStatus = ref<{ pending: boolean, error: string | undefined }>({ pending: false, error: undefined });
const ownMounts = computed(() => currentChatGroup.value?.mounts ?? []);
const upstreamMounts = computed(() => (settings.value.mounts ?? []).map(mount => ({ mount, source: 'global' as const })));
const inheritedEndpoint = computed(() => settings.value.endpoint);
const inheritedEndpointSource = computed(() => settingsSourcePresentation({ source: 'global' as const }));
const inheritedModelPresentation = computed(() => ({ id: settings.value.defaultModelId, source: settingsSourcePresentation({ source: 'global' as const }) }));
const titleInheritedEndpoint = computed(() => globalTitleEndpoint());
const titleInheritedSource = computed(() => settingsSourcePresentation({ source: 'global' as const }));
const titleModelPresentation = computed(() => ({
  id: localTitleEndpointUsesInheritance.value ? effectiveTitleModelId.value : effectiveModelId.value,
  source: localTitleEndpointUsesInheritance.value ? titleInheritedSource.value : settingsSourcePresentation({ source: 'chat_group' }),
}));
const mainReasoningSource = computed(() => settingsSourcePresentation({ source: localSettings.value.lmParameters?.reasoning?.effort !== undefined ? undefined : 'global' }));

function scopedEndpointTypeLabel({ endpointType }: { endpointType: Endpoint['type'] }): string | undefined {
  switch (endpointType) {
  case 'openai': return lazyStrings.ChatGroupSettingsPanel__openai_compatible();
  case 'naidan_rpc': return rpcEnabled.value ? lazyStrings.naidanRpc__title() : lazyStrings.naidanRpc__disabled();
  case 'llama_cpp_browser': return lazyStrings.llamaCppBrowser__endpoint_label();
  case 'transformers_js': return lazyStrings.ChatGroupSettingsPanel__transformers_js_experimental();
  case 'ollama': case 'browser_provided_lm': case 'unsupported_experimental_endpoint': return endpointTypeLabel({ endpointType });
  default: {
    const _ex: never = endpointType;
    return _ex;
  }
  }
}

function endpointDetail({ endpoint }: { endpoint: Endpoint | undefined }): string | undefined {
  if (endpoint === undefined) {
    return undefined;
  }
  return isHttpEndpoint(endpoint) && endpoint.url ? endpoint.url : endpointTypeDescription({ endpointType: endpoint.type });
}

function endpointChoices({ title }: { title: boolean }) {
  const current = title ? localTitleEndpointSelectValue.value : localSettings.value.endpoint?.type;
  const choices = (Object.keys(endpointTypeSelectValueRecord) as EndpointType[]).filter(type => type !== 'naidan_rpc' || rpcEnabled.value || current === 'naidan_rpc').map(type => ({
    value: type as string,
    label: scopedEndpointTypeLabel({ endpointType: type }),
    detail: endpointTypeDescription({ endpointType: type }),
    disabled: (() => {
      switch (type) {
      case 'naidan_rpc': return !rpcEnabled.value;
      case 'browser_provided_lm': return false;
      case 'openai': case 'ollama': case 'llama_cpp_browser': case 'transformers_js': return getEndpointBuildAvailability({ type }) !== 'available';
      default: {
        const _ex: never = type;
        return _ex;
      }
      }
    })(),
  }));
  // Prompt API remains selectable even when the current browser cannot initialize it.
  for (const choice of choices) {
    if (choice.value === 'browser_provided_lm') {
      choice.disabled = false;
    }
  }
  switch (current) {
  case 'unsupported_experimental_endpoint': choices.push({ value: current, label: lazyStrings.SHARED__unsupported_experimental_endpoint(), detail: undefined, disabled: true });
    break;
  case undefined: case 'inherit': case 'same_scope': case 'naidan_rpc': case 'openai': case 'ollama': case 'llama_cpp_browser': case 'transformers_js': case 'browser_provided_lm': break;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled current endpoint: ${_ex}`);
  }
  }
  return choices;
}

const mainEndpointChoices = computed(() => [{ value: 'global', label: scopedEndpointTypeLabel({ endpointType: inheritedEndpoint.value.type }), detail: endpointDetail({ endpoint: inheritedEndpoint.value }), source: inheritedEndpointSource.value }, ...endpointChoices({ title: false })]);
const titleEndpointChoices = computed(() => [
  { value: 'inherit', label: titleInheritedEndpoint.value ? scopedEndpointTypeLabel({ endpointType: titleInheritedEndpoint.value.type }) : lazyStrings.ChatGroupSettingsPanel__disabled(), detail: endpointDetail({ endpoint: titleInheritedEndpoint.value }), source: titleInheritedSource.value },
  { value: 'same_scope', label: scopedEndpointTypeLabel({ endpointType: effectiveEndpoint.value.type }), detail: endpointDetail({ endpoint: effectiveEndpoint.value }), source: settingsSourcePresentation({ source: 'chat_group' }) },
  ...endpointChoices({ title: true }),
]);
const profileChoices = computed(() => [{ value: '', label: lazyStrings.ChatGroupSettingsPanel__load_from_saved_profiles() }, ...(settings.value.providerProfiles ?? []).map(profile => ({ value: idToRaw({ id: profile.id }), label: profile.name, detail: endpointTypeLabel({ endpointType: profile.endpoint.type }) }))]);

function changeTitleType({ value }: { value: string }) {
  setLocalTitleEndpointType({ endpointType: titleEndpointTypeFromSelectValue({ value }) });
}

function changeMainType({ value }: { value: string }) {
  void updateEndpointType({ endpointType: endpointTypeFromSelectValue({ value }) });
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
  <div v-if="currentChatGroup" tw-class="relative flex h-full flex-col overflow-hidden bg-white outline-none dark:bg-gray-900" tabindex="-1" @click="setActiveFocusArea({ area: 'chat-group-settings' })" @focusin="setActiveFocusArea({ area: 'chat-group-settings' })">
    <header tw-class="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200/70 px-5 py-3 dark:border-gray-800"><h2 :title="currentChatGroup.name" tw-class="min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{{ currentChatGroup.name }}</h2><details tw-class="relative shrink-0"><summary :aria-label="lazyStrings.ChatGroupSettingsPanel__group_actions()" tw-class="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-gray-800"><MoreHorizontalIcon tw-class="h-5 w-5" /></summary><div tw-class="absolute right-0 top-full z-20 w-60 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl dark:border-gray-700 dark:bg-gray-900"><button type="button" class="scoped-menu-action" @click="useGlobalSearch().openSearch({ groupIds: [idToRaw({ id: currentChatGroup.id })] })"><SearchIcon tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.ChatGroupSettingsPanel__search_messages() }}</button><button type="button" class="scoped-menu-action" @click="handleCreateRecipe"><ChefHatIcon tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.ChatGroupSettingsPanel__create_recipe() }}</button><button type="button" class="scoped-menu-action" :disabled="!localSettings.modelId" @click="setGroupNameFromModelId" data-testid="group-setting-set-name-from-model">{{ lazyStrings.ChatGroupSettingsPanel__set_group_name() }}</button></div></details></header>
    <p v-if="saveError" role="alert" tw-class="mx-5 mt-3 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300" data-testid="chat-group-settings-save-error">{{ saveError }}</p>
    <RecipeExportModal :is-open="showExportModal" :group-name="currentChatGroup.name" :system-prompt="localSettings.systemPrompt" :lm-parameters="localSettings.lmParameters" :initial-model-id="localSettings.modelId" @close="showExportModal = false" />
    <div tw-class="flex-1 overflow-y-auto overscroll-contain"><div tw-class="mx-auto max-w-4xl p-5 sm:p-6">
      <div class="scoped-settings-form" tw-class="space-y-6">
        <div class="scoped-settings-main">
          <div tw-class="min-w-0 space-y-2">
            <span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_type() }}</span>
            <button type="button" :aria-expanded="connectionOpen" :aria-controls="connectionDetailsId" ref="connectionTrigger" data-testid="group-setting-connection-trigger" class="scoped-connection-trigger" tw-class="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-left transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:border-gray-700/60 dark:bg-gray-800/55 dark:hover:bg-gray-800" @click="connectionOpen = !connectionOpen">
              <span tw-class="block min-w-0 flex-1"><span tw-class="block truncate text-sm font-medium text-gray-800 dark:text-gray-100">{{ scopedEndpointTypeLabel({ endpointType: effectiveEndpointType }) }}</span><span tw-class="mt-0.5 flex h-4 min-w-0 items-center gap-1.5"><SettingsSourceBadge :source="localSettings.endpoint ? undefined : inheritedEndpointSource" /><span tw-class="min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400">{{ endpointDetail({ endpoint: effectiveEndpoint }) }}</span></span></span><ChevronDownIcon :tw-class="['h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200', connectionOpen && 'rotate-180']" />
            </button>
          </div>
          <div tw-class="min-w-0 space-y-4">
            <div tw-class="min-w-0 space-y-2"><span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__model_id_override() }}</span>
              <div tw-class="flex min-w-0 items-stretch overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/55">
                <ModelSelector surface="settings" frame="embedded" :model-value="localSettings.modelId" :inherited-model="inheritedModelPresentation" :models="sortedGroupModels" :loading="isFetchingModels" :disabled="effectiveEndpointType === 'browser_provided_lm'" :allow-clear="true" @update:model-value="value => { localSettings.modelId = value; saveChangesFromUi(); }" @refresh="fetchModels" data-testid="group-setting-model-select" />
                <router-link v-if="effectiveEndpointType === 'llama_cpp_browser' || effectiveEndpointType === 'transformers_js'" :to="{ query: { ...$route?.query, settings: effectiveEndpointType === 'llama_cpp_browser' ? 'llama-cpp-browser' : 'transformers-js' } }" :title="lazyStrings.ChatGroupSettingsPanel__model_management()" :aria-label="lazyStrings.ChatGroupSettingsPanel__model_management()" tw-class="flex shrink-0 items-center justify-center gap-2 border-l border-gray-200 px-3 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30 dark:border-gray-700/60 dark:text-blue-400 dark:hover:bg-blue-500/5"><FolderOpenIcon tw-class="h-4 w-4 shrink-0" /><span class="scoped-management-label">{{ lazyStrings.ChatGroupSettingsPanel__model_management() }}</span></router-link>
              </div>
            </div>
            <fieldset :disabled="effectiveEndpointType === 'browser_provided_lm'" :tw-class="['min-w-0', effectiveEndpointType === 'browser_provided_lm' && 'opacity-50']"><ReasoningSettings :selected-effort="localSettings.lmParameters?.reasoning?.effort" :default-label="lazyStrings.ChatGroupSettingsPanel__inherited()" :disabled="effectiveEndpointType === 'browser_provided_lm'" surface="plain" notice="inline-help" @update:effort="effort => { localSettings.lmParameters = { ...(localSettings.lmParameters || EMPTY_LM_PARAMETERS), reasoning: { effort } }; saveChangesFromUi(); }"><template #heading-extra><SettingsSourceBadge :source="mainReasoningSource" /></template></ReasoningSettings></fieldset>
          </div>
        </div>
        <SettingsCollapse :id="connectionDetailsId" :open="connectionOpen" :return-focus="connectionTrigger ?? undefined"><div tw-class="space-y-4 rounded-xl bg-gray-50/70 p-4 dark:bg-gray-800/25">
          <div tw-class="max-w-sm space-y-2"><span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_type() }}</span><SettingsSelect :model-value="localSettings.endpoint?.type || 'global'" :options="mainEndpointChoices" :label="lazyStrings.ChatGroupSettingsPanel__endpoint_type()" @update:model-value="value => changeMainType({ value })" data-testid="group-setting-endpoint-type-select" /></div>
          <RpcRegistrationSelect surface="settings" v-if="localSettings.endpoint?.type === 'naidan_rpc'" :model-value="localSettings.endpoint.registrationId" @update:model-value="registrationId => changeRpcRegistration({ registrationId, title: false })" />
          <PromptApiStatus v-if="effectiveEndpointType === 'browser_provided_lm'" show-ready />
          <template v-if="isHttpEndpoint(effectiveEndpoint)">
            <label tw-class="block space-y-2"><span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_url() }}</span><input v-model="localEndpointUrl" :placeholder="endpointUrlPlaceholder({ endpointType: effectiveEndpoint.type })" class="scoped-input" type="url" @blur="saveChangesFromUi" @keyup.enter="($event.target as HTMLInputElement).blur()" data-testid="group-setting-url-input" /></label>
            <HttpHeadersEditor :model-value="localEndpointHttpHeaders ?? []" @update:model-value="value => localEndpointHttpHeaders = value" @save="saveChangesFromUi" test-id-prefix="group-setting-http-header" />
            <p tw-class="text-xs leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.ChatGroupSettingsPanel__connection_check_is_automatically_performed_only_for_localhost_urls() }}</p>
          </template>
          <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>
          <div v-if="settings.providerProfiles?.length" tw-class="max-w-sm space-y-2"><span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__quick_profile_switcher() }}</span><SettingsSelect data-testid="group-setting-profile-select" v-model="selectedProviderProfileId" :options="profileChoices" :label="lazyStrings.ChatGroupSettingsPanel__quick_profile_switcher()" @update:model-value="handleQuickProviderProfileChange" /></div>
          <EndpointPresetButtons :endpoint="effectiveEndpoint" test-id-prefix="group-endpoint-preset" @apply="preset => applyPreset({ preset })" />
        </div></SettingsCollapse>
        <section><SystemPromptSettingsEditor
          v-model="localSettings.systemPrompt"
          :title="lazyStrings.ChatGroupSettingsPanel__group_system_prompt()"
          :parent-mode-label="lazyStrings.ChatGroupSettingsPanel__global()"
          :no-prompt-mode-label="lazyStrings.ChatGroupSettingsPanel__no_prompt()"
          :replace-mode-label="lazyStrings.ChatGroupSettingsPanel__replace()"
          :append-mode-label="lazyStrings.ChatGroupSettingsPanel__append()"
          :parent-prompt-text="parentSystemPromptText"
          :parent-prompt-set-caption="lazyStrings.ChatGroupSettingsPanel__system_prompt_global_set()"
          :parent-prompt-not-set-caption="lazyStrings.ChatGroupSettingsPanel__system_prompt_global_not_set()"
          :no-prompt-caption="lazyStrings.ChatGroupSettingsPanel__system_prompt_no_prompt()"
          :replace-caption="lazyStrings.ChatGroupSettingsPanel__instructions_for_this_chat_group()"
          :append-caption="lazyStrings.ChatGroupSettingsPanel__instructions_to_append()"
          :type-to-replace-placeholder="lazyStrings.ChatGroupSettingsPanel__start_typing_to_replace()"
          :replace-placeholder="lazyStrings.ChatGroupSettingsPanel__enter_instructions_for_this_chat_group()"
          :append-placeholder="lazyStrings.ChatGroupSettingsPanel__enter_instructions_to_append()"
          :reset-key="currentChatGroup ? idToRaw({ id: currentChatGroup.id }) : ''"
          test-id-prefix="group-setting-system-prompt"
          :rows="6"
          @save="saveChangesFromUi"
        /></section>
        <div tw-class="space-y-0">
          <SettingsDisclosure :title="lazyStrings.ChatGroupSettingsPanel__parameters()" test-id="group-setting-parameters-disclosure"><template #icon><SlidersHorizontalIcon tw-class="h-4 w-4" /></template><template #summary><span data-testid="resolution-status-lm-parameters">{{ hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? lazyStrings.ChatGroupSettingsPanel__override() : lazyStrings.ChatGroupSettingsPanel__inherited() }}</span></template><LmParametersEditor :inheritance-label="lazyStrings.ChatGroupSettingsPanel__inherited()" :inheritance-hint="lazyStrings.LmParametersEditor__empty_fields_use_parent_settings()" :model-value="localSettings.lmParameters" @update:model-value="value => { localSettings.lmParameters = value; saveChangesFromUi(); }" /></SettingsDisclosure>
          <SettingsDisclosure :title="lazyStrings.ChatGroupSettingsPanel__automatic_title()" :summary="localTitleGenerationMode === 'disabled' ? lazyStrings.ChatGroupSettingsPanel__disabled() : localTitleGenerationMode === 'inherit' ? lazyStrings.ChatGroupSettingsPanel__inherited() : lazyStrings.ChatGroupSettingsPanel__override()" test-id="group-setting-title-disclosure"><template #icon><TypeIcon tw-class="h-4 w-4" /></template>
            <div tw-class="space-y-4">
              <div role="group" :aria-label="lazyStrings.ChatGroupSettingsPanel__automatic_title()" tw-class="inline-flex max-w-full rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800 inset-ring-1 inset-ring-gray-200/50 dark:inset-ring-gray-700/50"><button v-for="mode in ['inherit', 'override', 'disabled'] as const" :key="mode" type="button" :aria-pressed="localTitleGenerationMode === mode" :tw-class="['min-h-8 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30', localTitleGenerationMode === mode ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 inset-ring-1 inset-ring-gray-200 dark:inset-ring-gray-600' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/40 hover:text-gray-700 dark:hover:text-gray-200']" @click="setLocalTitleGenerationMode({ mode })">{{ mode === 'inherit' ? lazyStrings.ChatGroupSettingsPanel__inherited() : mode === 'override' ? lazyStrings.ChatGroupSettingsPanel__override() : lazyStrings.ChatGroupSettingsPanel__disabled() }}</button></div>
              <div v-if="localTitleGenerationMode !== 'disabled'" tw-class="space-y-4">
                <div tw-class="grid min-w-0 grid-cols-1 items-start gap-4 sm:grid-cols-2">
                  <div tw-class="min-w-0 space-y-2"><span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__title_endpoint_type() }}</span><SettingsSelect :model-value="localTitleEndpointSelectValue" :options="titleEndpointChoices" :label="lazyStrings.ChatGroupSettingsPanel__title_endpoint_type()" @update:model-value="value => changeTitleType({ value })" data-testid="group-setting-title-endpoint-type-select" /></div>
                  <div tw-class="min-w-0 space-y-2"><span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__title_model_override() }}</span><ModelSelector surface="settings" :placeholder="localTitleEndpointUsesInheritance && titleInheritedEndpoint === undefined ? lazyStrings.ChatGroupSettingsPanel__disabled() : undefined" :clear-label="localTitleEndpointUsesInheritance && titleInheritedEndpoint === undefined ? lazyStrings.ChatGroupSettingsPanel__disabled() : undefined" :model-value="localTitleEndpointUsesInheritance ? undefined : localTitleModelId" :inherited-model="titleModelPresentation" :models="titleModelOptions" :loading="titleModelLoading" :allow-clear="localTitleEndpointUsesInheritance || localTitleEndpointUsesSameScope" :disabled="effectiveTitleEndpoint.type === 'browser_provided_lm'" @update:model-value="value => setLocalTitleModelId({ modelId: value })" @refresh="fetchTitleEndpointModels" data-testid="group-setting-title-model-select" /></div>
                </div>
                <ReasoningSettings :selected-effort="reasoningEffortFromTitleReasoningValue({ value: localTitleReasoningSelectValue })" :selected-value="localTitleReasoningSelectValue" :leading-options="titleReasoningLeadingOptions" :heading="lazyStrings.ChatGroupSettingsPanel__title_reasoning()" surface="plain" notice="inline-help" @update:value="value => setLocalTitleReasoningSelectValue({ value: value as TitleReasoningSelectValue })" data-testid="group-setting-title-reasoning-select" />
                <RpcRegistrationSelect surface="settings" v-if="localTitleEndpoint !== 'inherit' && localTitleEndpoint !== 'same_scope' && localTitleEndpoint.type === 'naidan_rpc'" :model-value="localTitleEndpoint.registrationId" @update:model-value="registrationId => changeRpcRegistration({ registrationId, title: true })" />
                <template v-if="activeTitleEndpoint !== undefined && isHttpEndpoint(activeTitleEndpoint)"><p v-if="localTitleEndpointUsesInheritance || localTitleEndpointUsesSameScope" tw-class="text-xs leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.ChatGroupSettingsPanel__editing_connection_creates_a_local_title_override() }}</p><label tw-class="block space-y-2"><span class="scoped-field-label">{{ lazyStrings.ChatGroupSettingsPanel__endpoint_url() }}</span><input v-model="localTitleEndpointUrl" :placeholder="endpointUrlPlaceholder({ endpointType: activeTitleEndpoint?.type })" class="scoped-input" type="url" @blur="saveChangesFromUi" @keyup.enter="($event.target as HTMLInputElement).blur()" data-testid="group-setting-title-endpoint-url-input" /></label><HttpHeadersEditor :model-value="localTitleEndpointHttpHeaders ?? []" @update:model-value="value => setLocalTitleEndpointHttpHeaders({ httpHeaders: value })" @save="saveChangesFromUi" test-id-prefix="group-setting-title-http-header" /></template>
              </div>
            </div>
          </SettingsDisclosure>
          <SettingsDisclosure :title="lazyStrings.ChatGroupSettingsPanel__tools()" test-id="group-setting-tools-disclosure"><template #icon><WrenchIcon tw-class="h-4 w-4" /></template><template #summary><span v-if="toolsStatus.error" tw-class="text-red-500">{{ toolsStatus.error }}</span><span v-else-if="toolsStatus.pending">{{ lazyStrings.ChatGroupSettingsPanel__saving() }}</span><span v-else>{{ lazyStrings.ChatGroupSettingsPanel__enabled_tool_count({ count: toolsStatus.enabledCount }) }}</span></template><ChatGroupToolsSettings @status="toolsStatus = $event" /></SettingsDisclosure>
          <SettingsDisclosure :title="lazyStrings.ChatGroupSettingsPanel__folders()" test-id="group-setting-folders-disclosure"><template #icon><FolderIcon tw-class="h-4 w-4" /></template><template #summary><span :tw-class="foldersStatus.error ? 'text-red-500' : ''">{{ foldersStatus.error || (foldersStatus.pending ? lazyStrings.ChatGroupSettingsPanel__working() : lazyStrings.ChatGroupSettingsPanel__folder_counts({ own: ownMounts.length, inherited: upstreamMounts.length })) }}</span></template><ScopedMountSettings v-if="currentChatGroup.id" :owner="{ type: 'chat_group', id: currentChatGroup.id }" :mounts="ownMounts" :inherited-mounts="upstreamMounts" @status="foldersStatus = $event" data-testid="chat-group-mounts" /></SettingsDisclosure>
        </div>
        <footer tw-class="flex items-center justify-end border-t border-gray-200/70 pt-3 dark:border-gray-800"><button type="button" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-md text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-gray-400 dark:hover:text-gray-200" @click="restoreDefaults" data-testid="group-setting-restore-defaults"><RotateCcwIcon tw-class="h-3.5 w-3.5" />{{ lazyStrings.ChatGroupSettingsPanel__restore_defaults() }}</button></footer>
      </div>
    </div></div>
  </div>
</template>

<style scoped>
.scoped-settings-form {
  container-type: inline-size;
}
.scoped-settings-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1.5rem;
}
.scoped-field-label {
  display: block;
  min-height: 1rem;
  color: #6b7280;
  font-size: 0.75rem;
  line-height: 1rem;
}
.scoped-connection-trigger {
  min-height: 3.75rem;
}
.scoped-management-label {
  display: none;
}
.scoped-input {
  width: 100%;
  min-width: 0;
  min-height: 2.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  background: #fff;
  padding: 0.625rem 0.875rem;
  color: #1f2937;
  font-size: 0.875rem;
  line-height: 1.5rem;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.scoped-input:focus-visible {
  border-color: rgb(59 130 246 / 65%);
  box-shadow: 0 0 0 3px rgb(59 130 246 / 10%);
}
.scoped-menu-action {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 2.5rem;
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-size: 0.75rem;
  color: #6b7280;
}
.scoped-menu-action:hover {
  background: rgb(107 114 128 / 8%);
  color: #2563eb;
}
.scoped-menu-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dark .scoped-field-label {
  color: #9ca3af;
}
.dark .scoped-input {
  border-color: rgb(55 65 81 / 60%);
  background: rgb(31 41 55 / 55%);
  color: #e5e7eb;
}
.dark .scoped-menu-action {
  color: #9ca3af;
}
@container (min-width: 32rem) {
  .scoped-management-label {
    display: inline;
  }
}
@container (min-width: 43rem) {
  .scoped-settings-main {
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: 2rem;
  }
}
.modal-enter-active, .modal-leave-active {
  transition: opacity 150ms;
}
.modal-enter-active .modal-content-zoom, .modal-leave-active .modal-content-zoom {
  transition: transform 170ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.modal-enter-from, .modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-content-zoom, .modal-leave-to .modal-content-zoom {
  transform: translateY(0.25rem) scale(0.99);
}
@media (prefers-reduced-motion: reduce) {
  .modal-enter-active, .modal-leave-active, .modal-content-zoom {
    transition: none !important;
  }
}
</style>
