import { computed, type ComputedRef, type Ref } from 'vue';
import type { ScopedSettingChange } from '@/models/scoped-setting-change';
import type { Chat, Endpoint, Reasoning } from '@/models/types';
import {
  getLiveChatById,
  loadData,
  triggerCurrentChat,
  updateChatMeta,
  updateChatScopedSettings,
} from '@/composables/chat/global/chat-core-singletons';
import {
  createLmParameterSettingChanges,
  createSystemPromptSettingChange,
} from '@/utils/scoped-setting-changes';
import type { ChatGroupId, ChatId } from '@/models/ids';
import { storageService } from '@/services/storage';

type ReasoningEffort = Reasoning['effort'];

type ChatSettingsUpdate = Partial<Pick<
  Chat,
  | 'endpointType'
  | 'endpointUrl'
  | 'endpointHttpHeaders'
  | 'modelId'
  | 'autoTitleEnabled'
  | 'titleModelId'
  | 'systemPrompt'
  | 'lmParameters'
>>;

const chatSettingsUpdateKeyRecord: Readonly<Record<keyof ChatSettingsUpdate, true>> = {
  endpointType: true,
  endpointUrl: true,
  endpointHttpHeaders: true,
  modelId: true,
  autoTitleEnabled: true,
  titleModelId: true,
  systemPrompt: true,
  lmParameters: true,
};

const CHAT_SETTINGS_UPDATE_KEYS = Object.keys(
  chatSettingsUpdateKeyRecord,
) as (keyof ChatSettingsUpdate)[];

async function legacyUpdatesToChanges({
  chatId,
  updates,
}: {
  chatId: ChatId;
  updates: ChatSettingsUpdate;
}): Promise<ScopedSettingChange[]> {
  const changes: ScopedSettingChange[] = [];
  const liveChat = getLiveChatById({ chatId });
  const hasEndpointUpdate = Object.hasOwn(updates, 'endpointType')
    || Object.hasOwn(updates, 'endpointUrl')
    || Object.hasOwn(updates, 'endpointHttpHeaders');

  if (hasEndpointUpdate) {
    if (Object.hasOwn(updates, 'endpointType') && updates.endpointType === undefined) {
      changes.push({ field: 'endpoint', behavior: 'inherit' });
    } else {
      let currentEndpoint: Endpoint | undefined = liveChat?.endpointType === undefined
        ? undefined
        : {
          type: liveChat.endpointType,
          url: liveChat.endpointUrl,
          httpHeaders: liveChat.endpointHttpHeaders,
        };

      // A compatibility update may target a chat that is not currently live.
      // Read metadata only when an omitted endpoint type cannot be recovered
      // from memory; explicit endpoint updates stay on the fast path.
      if (
        !Object.hasOwn(updates, 'endpointType')
        && currentEndpoint === undefined
      ) {
        currentEndpoint = (await storageService.loadChatMeta({ id: chatId }))?.endpoint;
      }

      const endpointType = Object.hasOwn(updates, 'endpointType')
        ? updates.endpointType
        : currentEndpoint?.type;
      if (endpointType === undefined) {
        throw new Error('Endpoint override requires an endpoint type');
      }

      const endpoint: Endpoint = (() => {
        switch (endpointType) {
        case 'transformers_js':
          return { type: endpointType };
        case 'openai':
        case 'ollama':
          return {
            type: endpointType,
            url: Object.hasOwn(updates, 'endpointUrl')
              ? updates.endpointUrl
              : currentEndpoint?.url,
            httpHeaders: Object.hasOwn(updates, 'endpointHttpHeaders')
              ? updates.endpointHttpHeaders
              : currentEndpoint?.httpHeaders,
          };
        default: {
          const _ex: never = endpointType;
          throw new Error(`Unhandled endpoint type: ${_ex}`);
        }
        }
      })();
      changes.push({ field: 'endpoint', behavior: 'override', value: endpoint });
    }
  }

  // Keep the compatibility surface exhaustive. If another legacy update key is
  // introduced, Record<> and the `never` branch force its conversion semantics
  // to be reviewed instead of silently dropping the update.
  for (const key of CHAT_SETTINGS_UPDATE_KEYS) {
    if (!Object.hasOwn(updates, key)) continue;

    switch (key) {
    case 'endpointType':
    case 'endpointUrl':
    case 'endpointHttpHeaders':
      // Endpoint subfields are converted atomically above.
      break;
    case 'modelId':
      changes.push(updates.modelId === undefined
        ? { field: 'model_id', behavior: 'inherit' }
        : { field: 'model_id', behavior: 'override', value: updates.modelId });
      break;
    case 'autoTitleEnabled':
      changes.push(updates.autoTitleEnabled === undefined
        ? { field: 'auto_title_enabled', behavior: 'inherit' }
        : { field: 'auto_title_enabled', behavior: 'override', value: updates.autoTitleEnabled });
      break;
    case 'titleModelId':
      changes.push(updates.titleModelId === undefined
        ? { field: 'title_model_id', behavior: 'inherit' }
        : { field: 'title_model_id', behavior: 'override', value: updates.titleModelId });
      break;
    case 'systemPrompt':
      changes.push(createSystemPromptSettingChange({ systemPrompt: updates.systemPrompt }));
      break;
    case 'lmParameters':
      changes.push(...createLmParameterSettingChanges({ lmParameters: updates.lmParameters }));
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled chat settings update key: ${_ex}`);
    }
    }
  }

  return changes;
}


export type ChatMetadataAdapter = {
  rename({
    chatId,
    title,
  }: {
    chatId: ChatId;
    title: string;
  }): Promise<void>;

  toggleDebug({
    chatId,
  }: {
    chatId: ChatId;
  }): Promise<void>;

  updateModel({
    chatId,
    modelId,
  }: {
    chatId: ChatId;
    modelId: string | undefined;
  }): Promise<void>;

  updateGroupOverride({
    chatId,
    chatGroupId,
  }: {
    chatId: ChatId;
    chatGroupId: ChatGroupId | undefined;
  }): Promise<void>;

  updateScopedSettings({
    chatId,
    changes,
  }: {
    chatId: ChatId;
    changes: readonly ScopedSettingChange[];
  }): Promise<void>;

  updateSettings({
    chatId,
    updates,
  }: {
    chatId: ChatId;
    updates: ChatSettingsUpdate;
  }): Promise<void>;

  reasoningEffort({
    chatId,
  }: {
    chatId: Readonly<Ref<ChatId>>;
  }): ComputedRef<ReasoningEffort | undefined>;

  updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: ChatId;
    effort: ReasoningEffort | undefined;
  }): Promise<void>;

  TEST_ONLY: Record<never, never>;
};

export function useChatMetadata(): ChatMetadataAdapter {
  async function rename({
    chatId,
    title,
  }: {
    chatId: ChatId;
    title: string;
  }): Promise<void> {
    const liveChat = getLiveChatById({ chatId });
    if (liveChat !== null) {
      liveChat.title = title;
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId });
    }

    await updateChatMeta({
      id: chatId,
      updater: ({ current }) => {
        if (current === null) {
          throw new Error('Chat not found');
        }
        return { ...current, title, updatedAt: Date.now() };
      },
    });
    await loadData();
  }

  async function toggleDebug({ chatId }: { chatId: ChatId }): Promise<void> {
    const targetChat = getLiveChatById({ chatId });
    if (targetChat === null) return;

    const debugEnabled = !targetChat.debugEnabled;
    targetChat.debugEnabled = debugEnabled;
    targetChat.updatedAt = Date.now();
    triggerCurrentChat({ chatId });

    await updateChatMeta({
      id: chatId,
      updater: ({ current }) => {
        if (current === null) throw new Error('Chat not found');
        return { ...current, debugEnabled, updatedAt: Date.now() };
      },
    });
  }

  async function updateScopedSettings({
    chatId,
    changes,
  }: {
    chatId: ChatId;
    changes: readonly ScopedSettingChange[];
  }): Promise<void> {
    await updateChatScopedSettings({ chatId, changes });
  }

  async function updateModel({
    chatId,
    modelId,
  }: {
    chatId: ChatId;
    modelId: string | undefined;
  }): Promise<void> {
    await updateScopedSettings({
      chatId,
      changes: [modelId === undefined
        ? { field: 'model_id', behavior: 'inherit' }
        : { field: 'model_id', behavior: 'override', value: modelId }],
    });
  }

  async function updateGroupOverride({
    chatId,
    chatGroupId,
  }: {
    chatId: ChatId;
    chatGroupId: ChatGroupId | undefined;
  }): Promise<void> {
    const liveChat = getLiveChatById({ chatId });
    if (liveChat !== null) {
      liveChat.groupId = chatGroupId;
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId });
    }

    await updateChatMeta({
      id: chatId,
      updater: ({ current }) => {
        if (current === null) throw new Error('Chat not found');
        return { ...current, groupId: chatGroupId, updatedAt: Date.now() };
      },
    });
    await loadData();
  }

  async function updateSettings({
    chatId,
    updates,
  }: {
    chatId: ChatId;
    updates: ChatSettingsUpdate;
  }): Promise<void> {
    await updateScopedSettings({
      chatId,
      changes: await legacyUpdatesToChanges({ chatId, updates }),
    });
  }

  function reasoningEffort({
    chatId,
  }: {
    chatId: Readonly<Ref<ChatId>>;
  }): ComputedRef<ReasoningEffort | undefined> {
    return computed(() => getLiveChatById({
      chatId: chatId.value,
    })?.lmParameters?.reasoning?.effort);
  }

  async function updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: ChatId;
    effort: ReasoningEffort | undefined;
  }): Promise<void> {
    await updateScopedSettings({
      chatId,
      changes: [effort === undefined
        ? { field: 'lm_param_reasoning_effort', behavior: 'inherit' }
        : { field: 'lm_param_reasoning_effort', behavior: 'override', value: effort }],
    });
  }

  return {
    rename,
    toggleDebug,
    updateModel,
    updateGroupOverride,
    updateScopedSettings,
    updateSettings,
    reasoningEffort,
    updateReasoningEffort,
    TEST_ONLY: {},
  };
}
