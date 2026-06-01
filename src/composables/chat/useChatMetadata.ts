import { computed, type ComputedRef, type Ref } from 'vue';
import type { Chat, Reasoning } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import {
  getLiveChatById,
  loadData,
  triggerCurrentChat,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';

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

export type ChatMetadataAdapter = {
  rename({
    chatId,
    title,
  }: {
    chatId: string;
    title: string;
  }): Promise<void>;

  toggleDebug({
    chatId,
  }: {
    chatId: string;
  }): Promise<void>;

  updateModel({
    chatId,
    modelId,
  }: {
    chatId: string;
    modelId: string | undefined;
  }): Promise<void>;

  updateSettings({
    chatId,
    updates,
  }: {
    chatId: string;
    updates: ChatSettingsUpdate;
  }): Promise<void>;

  reasoningEffort({
    chatId,
  }: {
    chatId: Readonly<Ref<string>>;
  }): ComputedRef<ReasoningEffort | undefined>;

  updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string;
    effort: ReasoningEffort | undefined;
  }): Promise<void>;

  TEST_ONLY: Record<never, never>;
};

export function useChatMetadata(_args: Record<never, never>): ChatMetadataAdapter {
  async function rename({
    chatId,
    title,
  }: {
    chatId: string;
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
      updater: (current) => {
        if (current === null) {
          throw new Error('Chat not found');
        }

        return {
          ...current,
          title,
          updatedAt: Date.now(),
        };
      },
    });
    await loadData({});
  }

  async function toggleDebug({
    chatId,
  }: {
    chatId: string;
  }): Promise<void> {
    const targetChat = getLiveChatById({ chatId });
    if (targetChat === null) {
      return;
    }

    const debugEnabled = !targetChat.debugEnabled;
    targetChat.debugEnabled = debugEnabled;
    targetChat.updatedAt = Date.now();
    triggerCurrentChat({ chatId });

    await updateChatMeta({
      id: chatId,
      updater: (current) => {
        if (current === null) {
          throw new Error('Chat not found');
        }

        return {
          ...current,
          debugEnabled,
          updatedAt: Date.now(),
        };
      },
    });
  }

  async function updateModel({
    chatId,
    modelId,
  }: {
    chatId: string;
    modelId: string | undefined;
  }): Promise<void> {
    const liveChat = getLiveChatById({ chatId });
    if (liveChat !== null) {
      liveChat.modelId = modelId;
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId });
    }

    await updateChatMeta({
      id: chatId,
      updater: (current) => {
        if (current === null) {
          throw new Error('Chat not found');
        }

        return {
          ...current,
          modelId,
          updatedAt: Date.now(),
        };
      },
    });
  }

  async function updateSettings({
    chatId,
    updates,
  }: {
    chatId: string;
    updates: ChatSettingsUpdate;
  }): Promise<void> {
    const liveChat = getLiveChatById({ chatId });
    if (liveChat !== null) {
      Object.assign(liveChat, updates);
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId });
    }

    await updateChatMeta({
      id: chatId,
      updater: (current) => {
        if (current === null) {
          throw new Error('Chat not found');
        }

        type _NoFlatEndpoint = Omit<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders'> & {
          endpointType?: never;
          endpointUrl?: never;
          endpointHttpHeaders?: never;
        };

        const {
          endpointType: currentEndpointType,
          endpointUrl: currentEndpointUrl,
          endpointHttpHeaders: currentEndpointHttpHeaders,
          ...currentRest
        } = current;
        const {
          endpointType,
          endpointUrl,
          endpointHttpHeaders,
          ...rest
        } = updates;
        const resolvedEndpointType = endpointType !== undefined ? endpointType : currentEndpointType;

        const metaUpdates: Partial<_NoFlatEndpoint> = {
          ...rest,
          ...(resolvedEndpointType !== undefined && {
            endpoint: {
              type: resolvedEndpointType,
              url: endpointUrl !== undefined ? endpointUrl : currentEndpointUrl,
              httpHeaders: endpointHttpHeaders !== undefined ? endpointHttpHeaders : currentEndpointHttpHeaders,
            },
          }),
        };
        return { ...currentRest, ...metaUpdates, updatedAt: Date.now() };
      },
    });
  }

  function reasoningEffort({
    chatId,
  }: {
    chatId: Readonly<Ref<string>>;
  }): ComputedRef<ReasoningEffort | undefined> {
    return computed(() => getLiveChatById({
      chatId: chatId.value,
    })?.lmParameters?.reasoning?.effort);
  }

  async function updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string;
    effort: ReasoningEffort | undefined;
  }): Promise<void> {
    const liveChat = getLiveChatById({ chatId });
    if (liveChat === null) {
      return;
    }

    const lmParameters = {
      ...(liveChat.lmParameters || EMPTY_LM_PARAMETERS),
      reasoning: { effort },
    };

    liveChat.lmParameters = lmParameters;
    liveChat.updatedAt = Date.now();
    triggerCurrentChat({ chatId });

    await updateChatMeta({
      id: chatId,
      updater: (current) => {
        if (current === null) {
          throw new Error('Chat not found');
        }

        return {
          ...current,
          lmParameters,
          updatedAt: Date.now(),
        };
      },
    });
  }

  return {
    rename,
    toggleDebug,
    updateModel,
    updateSettings,
    reasoningEffort,
    updateReasoningEffort,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
