<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { SCOPED_SETTING_FIELDS, type LmParameterSettingField, type ScopedSettingChange } from '@/models/scoped-setting-change';
import type {
  Chat,
  Endpoint,
  EndpointType,
  LmParameters,
  SystemPrompt,
} from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import type { ChatId } from '@/models/ids';
import { idToRaw } from '@/models/ids';
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
import { ENDPOINT_PRESETS } from '@/models/constants';
import { naturalSort } from '@/utils/string';
import { hasChatOverrides } from '@/utils/chat-settings-resolver';
import {
  cloneLmParameters,
  hasLmParameterOverrides,
  normalizeLmParameters,
} from '@/utils/lm-parameters';
import {
  createChangedLmParameterSettingChanges,
  createSystemPromptSettingChange,
} from '@/utils/scoped-setting-changes';

import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';

const LmParametersEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmParametersEditor.vue') });
const TransformersJsUpsell = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./TransformersJsUpsell.vue') });

const props = defineProps<{
  show?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const { currentChatId, currentChat, resolvedSettings, inheritedSettings } = useCurrentChatState();
const chatMetadata = useChatMetadata();
const chatModels = useChatModels();
const isFetchingModels = computed(() => chatModels.fetchingModels.value);
const sortedAvailableModels = computed(() => naturalSort({ values: chatModels.availableModels.value || [] }));
const { settings } = useSettings();
const { setActiveFocusArea } = useLayout();

type ChatSettingsDraft = {
  endpointType: EndpointType | undefined;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
  modelId: string | undefined;
  autoTitleEnabled: boolean | undefined;
  titleModelId: string | undefined;
  systemPrompt: SystemPrompt | undefined;
  lmParameters: LmParameters | undefined;
};

function emptyDraft(): ChatSettingsDraft {
  return {
    endpointType: undefined,
    endpointUrl: undefined,
    endpointHttpHeaders: undefined,
    modelId: undefined,
    autoTitleEnabled: undefined,
    titleModelId: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
  };
}

function cloneDraft({ draft }: { draft: ChatSettingsDraft }): ChatSettingsDraft {
  return {
    endpointType: draft.endpointType,
    endpointUrl: draft.endpointUrl,
    endpointHttpHeaders: draft.endpointHttpHeaders?.map(([name, value]) => [name, value]),
    modelId: draft.modelId,
    autoTitleEnabled: draft.autoTitleEnabled,
    titleModelId: draft.titleModelId,
    systemPrompt: draft.systemPrompt === undefined ? undefined : { ...draft.systemPrompt },
    lmParameters: cloneLmParameters({ lmParameters: draft.lmParameters }),
  };
}

function draftFromChat({ chat }: { chat: Chat }): ChatSettingsDraft {
  return {
    endpointType: chat.endpointType,
    endpointUrl: chat.endpointUrl,
    endpointHttpHeaders: chat.endpointHttpHeaders?.map(([name, value]) => [name, value]),
    modelId: chat.modelId,
    autoTitleEnabled: chat.autoTitleEnabled,
    titleModelId: chat.titleModelId,
    systemPrompt: chat.systemPrompt === undefined ? undefined : { ...chat.systemPrompt },
    lmParameters: cloneLmParameters({ lmParameters: chat.lmParameters }),
  };
}

function areHeadersEqual({
  left,
  right,
}: {
  left: [string, string][] | undefined;
  right: [string, string][] | undefined;
}): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every(([name, value], index) => name === right[index]?.[0] && value === right[index]?.[1]);
}

function areSystemPromptsEqual({
  left,
  right,
}: {
  left: SystemPrompt | undefined;
  right: SystemPrompt | undefined;
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

function endpointTypeLabel({ endpointType }: { endpointType: EndpointType }): string {
  switch (endpointType) {
  case 'openai':
    return 'OpenAI';
  case 'ollama':
    return 'Ollama';
  case 'transformers_js':
    return 'Transformers.js';
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

function endpointFromDraft({
  draft,
  inheritedEndpointType,
}: {
  draft: ChatSettingsDraft;
  inheritedEndpointType: EndpointType | undefined;
}): Endpoint | undefined {
  const endpointType = draft.endpointType ?? inheritedEndpointType;
  if (endpointType === undefined) return undefined;
  switch (endpointType) {
  case 'transformers_js':
    return { type: endpointType };
  case 'openai':
  case 'ollama':
    return {
      type: endpointType,
      url: draft.endpointUrl,
      httpHeaders: draft.endpointHttpHeaders?.map(([name, value]) => [name, value]),
    };
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

function createChanges({
  previous,
  next,
  inheritedEndpointType,
}: {
  previous: ChatSettingsDraft;
  next: ChatSettingsDraft;
  inheritedEndpointType: EndpointType | undefined;
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
    case 'endpoint': {
      const endpointChanged = previous.endpointType !== next.endpointType
        || previous.endpointUrl !== next.endpointUrl
        || !areHeadersEqual({ left: previous.endpointHttpHeaders, right: next.endpointHttpHeaders });
      if (!endpointChanged) break;

      // The persisted Chat model can contain legacy URL/header-only states.
      // Treat a fully empty next draft as an explicit return to inheritance even
      // when the previous endpoint type was already missing.
      const inheritsEndpoint = next.endpointType === undefined
        && next.endpointUrl === undefined
        && next.endpointHttpHeaders === undefined;
      const endpoint = inheritsEndpoint
        ? undefined
        : endpointFromDraft({ draft: next, inheritedEndpointType });
      changes.push(endpoint === undefined
        ? { field: 'endpoint', behavior: 'inherit' }
        : { field: 'endpoint', behavior: 'override', value: endpoint });
      break;
    }
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

const localSettings = ref<ChatSettingsDraft>(emptyDraft());
const baselineSettings = ref<ChatSettingsDraft>(emptyDraft());
const editingChatId = ref<ChatId | undefined>(undefined);
const editingInheritedEndpointType = ref<EndpointType | undefined>(undefined);
const pendingFieldRevisions = new Map<ScopedSettingChange['field'], number>();
const saveQueues = new Map<ChatId, Promise<void>>();
const saveError = ref<string | null>(null);
let nextSaveRevision = 0;

const hasActiveOverrides = computed(() => hasChatOverrides({ chat: localSettings.value }));
const effectiveEndpointType = computed(() => localSettings.value.endpointType || resolvedSettings?.value?.endpointType);

// Keep field synchronization exhaustive. A new LM setting command must
// fail typechecking here until clean/dirty draft merge semantics are defined.
function applyLmParameterFieldFromDraft({
  field,
  target,
  source,
}: {
  field: LmParameterSettingField;
  target: ChatSettingsDraft;
  source: ChatSettingsDraft;
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
  field: ScopedSettingChange['field'];
  target: ChatSettingsDraft;
  source: ChatSettingsDraft;
}): void {
  switch (field) {
  case 'endpoint':
    target.endpointType = source.endpointType;
    target.endpointUrl = source.endpointUrl;
    target.endpointHttpHeaders = source.endpointHttpHeaders?.map(([name, value]) => [name, value]);
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
  const chat = currentChat.value;
  if (chat === null || chat === undefined) return;
  const current = draftFromChat({ chat });

  if (!preserveDirty || editingChatId.value !== chat.id) {
    pendingFieldRevisions.clear();
    saveError.value = null;
    editingChatId.value = chat.id;
    editingInheritedEndpointType.value = inheritedSettings.value?.endpointType;
    localSettings.value = cloneDraft({ draft: current });
    baselineSettings.value = cloneDraft({ draft: current });
    return;
  }

  const dirtyFields = new Set<ScopedSettingChange['field']>([
    ...createChanges({
      previous: baselineSettings.value,
      next: localSettings.value,
      inheritedEndpointType: editingInheritedEndpointType.value,
    }).map(change => change.field),
    ...pendingFieldRevisions.keys(),
  ]);

  for (const field of SCOPED_SETTING_FIELDS) {
    if (dirtyFields.has(field)) continue;
    applyFieldFromDraft({ field, target: localSettings.value, source: current });
    applyFieldFromDraft({ field, target: baselineSettings.value, source: current });
  }
  if (!dirtyFields.has('endpoint')) {
    editingInheritedEndpointType.value = inheritedSettings.value?.endpointType;
  }
}

function saveChangesForChat({ chatId }: { chatId: ChatId | undefined }): Promise<void> {
  if (chatId === undefined) return Promise.resolve();

  // Capture the draft now, but calculate its changes only after earlier saves
  // for this chat settle. This lets a close or navigation wait for an in-flight
  // blur save and retry its draft if that earlier save failed.
  const snapshot = cloneDraft({ draft: localSettings.value });
  const inheritedEndpointType = editingInheritedEndpointType.value;
  const previous = saveQueues.get(chatId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const baselineBeforeSave = cloneDraft({ draft: baselineSettings.value });
      const changes = createChanges({
        previous: baselineSettings.value,
        next: snapshot,
        inheritedEndpointType,
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
            : 'Failed to save chat settings.';
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
    const url = currentChat.value.endpointUrl || settings.value.endpointUrl;
    const type = currentChat.value.endpointType || settings.value.endpointType;
    if (type === 'transformers_js' || isLocalhost({ url })) void fetchModels();
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

function formatLabel({ value, source }: { value: string | undefined, source: 'chat' | 'chat_group' | 'global' | undefined }) {
  if (!value) return 'Default';
  switch (source) {
  case 'chat_group':
    return `${value} (Group)`;
  case 'global':
    return `${value} (Global)`;
  case 'chat':
  case undefined:
    return value;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled source: ${_ex}`);
  }
  }
}

const selectedProviderProfileId = ref('');
const error = ref<string | null>(null);

function isLocalhost({ url }: { url: string | undefined }) {
  if (!url) return false;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

async function updateEndpointType({
  endpointType,
}: {
  endpointType: EndpointType | undefined;
}): Promise<void> {
  switch (endpointType) {
  case undefined:
    localSettings.value.endpointType = undefined;
    localSettings.value.endpointUrl = undefined;
    localSettings.value.endpointHttpHeaders = undefined;
    break;
  case 'transformers_js':
    localSettings.value.endpointType = endpointType;
    localSettings.value.endpointUrl = undefined;
    localSettings.value.endpointHttpHeaders = undefined;
    break;
  case 'openai':
  case 'ollama':
    localSettings.value.endpointType = endpointType;
    break;
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }

  await saveChangesFromUi();
}

async function applyPreset({ preset }: { preset: typeof ENDPOINT_PRESETS[number] }) {
  localSettings.value.endpointType = preset.type;
  localSettings.value.endpointUrl = preset.url;
  error.value = null;
  await saveChangesFromUi();
}

async function handleQuickProviderProfileChange() {
  const providerProfile = settings.value.providerProfiles?.find(p => idToRaw({ id: p.id }) === selectedProviderProfileId.value);
  if (providerProfile) {
    switch (providerProfile.endpointType) {
    case 'transformers_js':
      // Provider profiles share the EndpointType union, but Transformers.js is
      // in-process and must not leave HTTP-only draft fields behind on failure.
      localSettings.value.endpointType = providerProfile.endpointType;
      localSettings.value.endpointUrl = undefined;
      localSettings.value.endpointHttpHeaders = undefined;
      break;
    case 'openai':
    case 'ollama':
      localSettings.value.endpointType = providerProfile.endpointType;
      localSettings.value.endpointUrl = providerProfile.endpointUrl;
      localSettings.value.endpointHttpHeaders = providerProfile.endpointHttpHeaders?.map(([name, value]) => [name, value]);
      break;
    default: {
      const _ex: never = providerProfile.endpointType;
      throw new Error(`Unhandled provider profile endpoint type: ${_ex}`);
    }
    }
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
  if (!localSettings.value.endpointHttpHeaders) localSettings.value.endpointHttpHeaders = [];
  localSettings.value.endpointHttpHeaders.push(['', '']);
}

async function removeHeader({ index }: { index: number }) {
  localSettings.value.endpointHttpHeaders?.splice(index, 1);
  await saveChangesFromUi();
}

async function fetchModels() {
  const chatId = currentChatId.value;
  if (!chatId) return;
  error.value = null;
  try {
    const models = await chatModels.fetchForChat({ chatId });
    if (models.length === 0) error.value = 'No models found at this endpoint.';
    if (localSettings.value.modelId && !models.includes(localSettings.value.modelId)) {
      localSettings.value.modelId = undefined;
      await saveChangesFromUi();
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Connection failed. Check URL or provider.';
  }
}

watch([
  () => localSettings.value.endpointUrl,
  () => localSettings.value.endpointType,
], ([url, type]) => {
  error.value = null;
  if (type === 'transformers_js' || (url && isLocalhost({ url }))) void fetchModels();
});

async function updateSystemPromptBehavior({
  behavior,
}: {
  behavior: 'inherit' | 'clear' | 'replace' | 'append';
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
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-2 md:p-6" @click.self="closePanel">
      <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 relative overflow-hidden modal-content-zoom">
        <!-- Title & Close -->
        <div class="flex items-center justify-between p-6 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div class="flex items-center gap-2">
            <div class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
              <Settings2Icon class="w-4 h-4 text-blue-600" />
            </div>
            <h3 class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">Chat Specific Overrides</h3>
          </div>

          <div class="flex items-center gap-2">
            <div
              v-if="hasActiveOverrides"
              class="flex items-center gap-1.5 px-3 py-1 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-full"
            >
              <div class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></div>
              <span class="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">Active Overrides</span>
            </div>

            <button
              @click="closePanel"
              class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
              data-testid="close-button"
            >
              <XIcon class="w-5 h-5" />
            </button>
          </div>
        </div>

        <div
          v-if="saveError"
          class="mx-6 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
          data-testid="chat-settings-save-error"
        >
          {{ saveError }}
        </div>

        <!-- Scrollable Content -->
        <div class="flex-1 overflow-y-auto p-6 space-y-8 overscroll-contain">
          <div class="flex flex-col md:flex-row md:items-end justify-between border-b border-gray-200/50 dark:border-gray-800 pb-8 gap-6">
            <div class="flex flex-col md:flex-row gap-8 flex-1">
              <!-- Quick Switcher -->
              <div v-if="settings.providerProfiles && settings.providerProfiles.length > 0" class="w-full md:max-w-[240px] space-y-2">
                <label class="block text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider ml-1">Quick Profile Switcher</label>
                <select
                  v-model="selectedProviderProfileId"
                  @change="handleQuickProviderProfileChange"
                  class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                  style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                >
                  <option value="" disabled>Load from saved profiles...</option>
                  <option v-for="p in settings.providerProfiles" :key="idToRaw({ id: p.id })" :value="idToRaw({ id: p.id })">{{ p.name }} ({{ endpointTypeLabel({ endpointType: p.endpointType }) }})</option>
                </select>
              </div>

              <!-- Endpoint Presets -->
              <div class="space-y-2 flex-1">
                <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider ml-1">Quick Endpoint Presets</label>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="preset in ENDPOINT_PRESETS"
                    :key="preset.name"
                    @click="applyPreset({ preset })"
                    type="button"
                    class="px-4 py-2 text-[10px] font-bold rounded-xl border transition-all shadow-sm"
                    :class="localSettings.endpointUrl === preset.url && localSettings.endpointType === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600'"
                  >
                    {{ preset.name }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Endpoint Type</label>
              <select
                data-testid="chat-setting-endpoint-type-select"
                :value="localSettings.endpointType || 'global'"
                @change="async (e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  await updateEndpointType({ endpointType: endpointTypeFromSelectValue({ value }) });
                }"
                class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              >
                <option value="global">{{ formatLabel({ value: resolvedSettings?.endpointType === 'transformers_js' ? 'Transformers.js' : resolvedSettings?.endpointType, source: resolvedSettings?.sources.endpointType }) }}</option>
                <option value="openai">OpenAI Compatible</option>
                <option value="ollama">Ollama</option>
                <option value="transformers_js">Transformers.js (Experimental)</option>
              </select>
            </div>

            <div class="space-y-2" v-if="effectiveEndpointType !== 'transformers_js'">
              <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Endpoint URL</label>
              <input
                v-model="localSettings.endpointUrl"
                @blur="saveChangesFromUi"
                @keyup.enter="(e) => (e.target as HTMLInputElement).blur()"
                @input="error = null"
                type="text"
                class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                :placeholder="formatLabel({ value: resolvedSettings?.endpointUrl, source: resolvedSettings?.sources.endpointUrl })"
                data-testid="chat-setting-url-input"
              />
              <div v-if="error" class="mt-2">
                <p class="text-[10px] text-red-500 font-bold ml-1 leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200">{{ error }}</p>
              </div>
            </div>

            <div class="space-y-2" v-if="effectiveEndpointType !== 'transformers_js'">
              <div class="flex items-center justify-between ml-1">
                <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">Custom HTTP Headers</label>
                <button
                  @click="addHeader"
                  type="button"
                  class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
                >
                  <PlusIcon class="w-2.5 h-2.5" />
                  Add Header
                </button>
              </div>

              <div v-if="localSettings.endpointHttpHeaders && localSettings.endpointHttpHeaders.length > 0" class="space-y-2">
                <div
                  v-for="(header, index) in localSettings.endpointHttpHeaders"
                  :key="index"
                  class="flex gap-2"
                >
                  <input
                    v-model="header[0]"
                    @blur="saveChangesFromUi"
                    type="text"
                    class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                    placeholder="Name"
                  />
                  <input
                    v-model="header[1]"
                    @blur="saveChangesFromUi"
                    type="text"
                    class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                    placeholder="Value"
                  />
                  <button
                    @click="removeHeader({ index })"
                    class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2Icon class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div v-else class="text-[10px] text-gray-400 italic ml-1">No custom headers.</div>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Model Override</label>
                <ModelSelector
                  :model-value="localSettings.modelId"
                  @update:model-value="val => { localSettings.modelId = val; saveChangesFromUi(); }"
                  :models="sortedAvailableModels"
                  :loading="isFetchingModels"
                  :placeholder="formatLabel({ value: resolvedSettings?.modelId, source: resolvedSettings?.sources.modelId })"
                  :allow-clear="true"
                  @refresh="fetchModels"
                  data-testid="chat-setting-model-select"
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
          <div class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl space-y-6">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
                  <Settings2Icon class="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <h4 class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">Automatic Title</h4>
                  <p class="text-[10px] text-gray-500 dark:text-gray-400 font-medium">Configure how this chat is automatically named.</p>
                </div>
              </div>
              <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                <button
                  @click="localSettings.autoTitleEnabled = undefined; saveChangesFromUi();"
                  class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                  :class="localSettings.autoTitleEnabled === undefined ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                >
                  Inherit
                </button>
                <button
                  @click="localSettings.autoTitleEnabled = true; saveChangesFromUi();"
                  class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                  :class="localSettings.autoTitleEnabled === true ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                >
                  Enabled
                </button>
                <button
                  @click="localSettings.autoTitleEnabled = false; saveChangesFromUi();"
                  class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                  :class="localSettings.autoTitleEnabled === false ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                >
                  Disabled
                </button>
              </div>
            </div>

            <div v-if="localSettings.autoTitleEnabled !== false" class="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-gray-50 dark:border-gray-800/50">
              <div class="space-y-2">
                <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Title Model Override</label>
                <ModelSelector
                  :model-value="localSettings.titleModelId"
                  @update:model-value="val => { localSettings.titleModelId = val; saveChangesFromUi(); }"
                  :models="sortedAvailableModels"
                  :loading="isFetchingModels"
                  :placeholder="formatLabel({ value: resolvedSettings?.titleModelId, source: resolvedSettings?.sources.titleModelId })"
                  :allow-clear="true"
                  @refresh="fetchModels"
                  data-testid="chat-setting-title-model-select"
                />
              </div>
              <div class="flex items-center">
                <p class="text-[10px] text-gray-400 italic leading-relaxed">
                  The title model is used only once to summarize the first user message.
                  {{ localSettings.autoTitleEnabled === undefined ? ' Currently inheriting ' + (resolvedSettings?.autoTitleEnabled ? 'Enabled' : 'Disabled') + ' from ' + resolvedSettings?.sources.autoTitleEnabled + '.' : '' }}
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
                <p class="text-[10px] font-bold text-blue-900/70 dark:text-blue-300 uppercase tracking-widest">Auto-Check</p>
                <p class="text-[11px] text-gray-500 dark:text-blue-400/70 leading-relaxed font-medium">Connection check is automatically performed only for localhost URLs.</p>
              </div>
            </div>

            <div class="flex items-start gap-4 p-4 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm">
              <div class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700">
                <AlertCircleIcon class="w-4 h-4 text-gray-400" />
              </div>
              <div class="space-y-1">
                <p class="text-[10px] font-bold text-gray-400 dark:text-gray-400 uppercase tracking-widest">Local Overrides</p>
                <p class="text-[11px] text-gray-500/70 dark:text-gray-400/70 leading-relaxed font-medium">
                  These settings only apply to this chat.
                  <button
                    @click="handleRestoreDefaults"
                    class="font-bold underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    data-testid="chat-setting-restore-defaults"
                  >
                    Restore defaults
                  </button>.
                </p>
              </div>
            </div>
          </div>

          <!-- System Prompt and Parameters -->
          <div class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-8">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div class="md:col-span-2 space-y-4">
                <div class="flex items-center justify-between">
                  <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                    <MessageSquareQuoteIcon class="w-3 h-3" />
                    Chat System Prompt
                  </label>

                  <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'inherit' })"
                      class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                      :class="!localSettings.systemPrompt ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                    >
                      Inherit
                    </button>
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'clear' })"
                      class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                      :class="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                    >
                      Clear
                    </button>
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'replace' })"
                      class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                      :class="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content !== null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                    >
                      Override
                    </button>
                    <button
                      @click="updateSystemPromptBehavior({ behavior: 'append' })"
                      class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                      :class="localSettings.systemPrompt?.behavior === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                    >
                      Append
                    </button>
                  </div>
                </div>
                <div v-if="!localSettings.systemPrompt" class="w-full bg-gray-50/50 dark:bg-gray-800/30 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-left">
                  <p class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">Inherited Instructions</p>
                  <p class="text-xs text-gray-400 dark:text-gray-500 italic whitespace-pre-wrap line-clamp-6">
                    {{ inheritedSettings?.systemPromptMessages?.join('\n\n') || 'No instructions inherited.' }}
                  </p>
                </div>
                <div v-else-if="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null" class="w-full bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center">
                  <p class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">Parent Prompt Cleared</p>
                  <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-1">This chat will not use any system instructions.</p>
                </div>
                <textarea
                  v-else
                  :value="localSettings.systemPrompt?.content || ''"
                  @input="e => updateSystemPromptContent({ content: (e.target as HTMLTextAreaElement).value })"
                  @blur="saveChangesFromUi"
                  rows="4"
                  class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                  :placeholder="localSettings.systemPrompt?.behavior === 'append' ? 'Added after global instructions...' : 'Completely replaces global instructions...'"
                  data-testid="chat-setting-system-prompt-textarea"
                ></textarea>
              </div>

              <div class="space-y-4">
                <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <LayersIcon class="w-3 h-3" />
                  Settings Resolution
                </label>
                <div class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-3">
                  <div class="flex items-center justify-between text-[10px] font-bold">
                    <span class="text-gray-400">System Prompt</span>
                    <span :class="localSettings.systemPrompt ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-system-prompt">
                      {{ localSettings.systemPrompt ? (localSettings.systemPrompt.behavior === 'append' ? 'Appending' : (localSettings.systemPrompt.content === null ? 'Cleared' : 'Overriding')) : 'Group/Global Default' }}
                    </span>
                  </div>
                  <div class="flex items-center justify-between text-[10px] font-bold">
                    <span class="text-gray-400">Parameters</span>
                    <span :class="hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-lm-parameters">
                      {{ hasLmParameterOverrides({ lmParameters: localSettings.lmParameters }) ? 'Chat Overrides' : 'Inherited' }}
                    </span>
                  </div>
                  <div class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                    <p class="text-[9px] text-gray-400 leading-relaxed italic">Chat settings take precedence over Provider Profiles, which take precedence over Group settings, which take precedence over Global settings.</p>
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
