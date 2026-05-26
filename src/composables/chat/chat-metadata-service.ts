import type { Chat, LmParameters, Reasoning } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';

export type ChatMetadataService = {
  renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }): Promise<void>;

  updateChatModel({
    id,
    modelId,
  }: {
    id: string;
    modelId: string;
  }): Promise<void>;

  updateChatGroupOverride({
    id,
    groupId,
  }: {
    id: string;
    groupId: string | null;
  }): Promise<void>;

  updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void>;

  toggleDebug(_args: Record<never, never>): Promise<void>;

  updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string;
    effort: Reasoning['effort'];
  }): Promise<void>;

  getReasoningEffort({
    chatId,
  }: {
    chatId: string;
  }): Reasoning['effort'] | undefined;
};

export function createChatMetadataService({
  getChatTarget,
  getCurrentChat,
  triggerCurrentChat,
  updateChatMeta,
  loadData,
}: {
  getChatTarget: ({ id }: { id: string }) => Chat | null;
  getCurrentChat: () => Chat | null;
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
  updateChatMeta: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) => Promise<void>;
  loadData: (_args: Record<never, never>) => Promise<void>;
}): ChatMetadataService {
  async function renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }) {
    const liveChat = getChatTarget({ id });
    if (liveChat) {
      liveChat.title = newTitle;
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId: id });
    }

    await updateChatMeta({
      id,
      updater: (current) => {
        if (!current) throw new Error('Chat not found');
        return { ...current, title: newTitle, updatedAt: Date.now() };
      },
    });
    await loadData({});
  }

  async function updateChatModel({
    id,
    modelId,
  }: {
    id: string;
    modelId: string;
  }) {
    const liveChat = getChatTarget({ id });
    if (liveChat) {
      liveChat.modelId = modelId;
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId: id });
    }

    await updateChatMeta({
      id,
      updater: (current) => {
        if (!current) throw new Error('Chat not found');
        return { ...current, modelId, updatedAt: Date.now() };
      },
    });
  }

  async function updateChatGroupOverride({
    id,
    groupId,
  }: {
    id: string;
    groupId: string | null;
  }) {
    const liveChat = getChatTarget({ id });
    if (liveChat) {
      liveChat.groupId = groupId;
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId: id });
    }

    await updateChatMeta({
      id,
      updater: (current) => {
        if (!current) throw new Error('Chat not found');
        return { ...current, groupId, updatedAt: Date.now() };
      },
    });
    await loadData({});
  }

  async function updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    const liveChat = getChatTarget({ id });
    if (liveChat) {
      Object.assign(liveChat, updates);
      liveChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId: id });
    }

    await updateChatMeta({
      id,
      updater: (current) => {
        if (!current) throw new Error('Chat not found');

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

  async function toggleDebug(_args: Record<never, never>) {
    const currentChat = getCurrentChat();
    if (!currentChat) return;

    const newValue = !currentChat.debugEnabled;
    currentChat.debugEnabled = newValue;
    triggerCurrentChat({ chatId: currentChat.id });

    await updateChatMeta({
      id: currentChat.id,
      updater: (current) => {
        if (!current) throw new Error('Chat not found');
        return { ...current, debugEnabled: newValue, updatedAt: Date.now() };
      },
    });
  }

  async function updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string;
    effort: Reasoning['effort'];
  }) {
    const chat = getChatTarget({ id: chatId });
    if (!chat) return;

    const lmParameters: LmParameters = {
      ...(chat.lmParameters || EMPTY_LM_PARAMETERS),
      reasoning: { effort },
    };

    await updateChatSettings({
      id: chatId,
      updates: { lmParameters },
    });
  }

  function getReasoningEffort({
    chatId,
  }: {
    chatId: string;
  }) {
    const chat = getChatTarget({ id: chatId });
    return chat?.lmParameters?.reasoning?.effort;
  }

  return {
    renameChat,
    updateChatModel,
    updateChatGroupOverride,
    updateChatSettings,
    toggleDebug,
    updateReasoningEffort,
    getReasoningEffort,
  };
}
