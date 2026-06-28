import type { Chat, ChatMessage, Endpoint } from '@/models/types';
import { isHttpEndpoint } from '@/models/endpoint';
import type { ChatId } from '@/models/ids';
import type { LmProvider } from '@/services/lm/types';
import { createLmProvider } from '@/services/lm/providerFactory';
import { getChatBranchIterator } from '@/utils/chat-tree';
import { stripNaidanSentinels } from '@/utils/image-generation';
import { cleanGeneratedTitle, detectLanguage, getTitleSystemPrompt } from '@/utils/title-generator';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { useSettings } from '@/composables/useSettings';
import {
  chatRuntimeStore,
  getLiveChatById,
  isGeneratingTitle,
  loadData,
  registerLiveInstance,
  rootItems,
  triggerCurrentChat,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';

export function isGeneratingChatTitle({
  chatId,
}: {
  chatId: ChatId,
}): boolean {
  return isGeneratingTitle({ chatId });
}

export function abortTitleGenerationForChat({
  chatId,
}: {
  chatId: ChatId,
}): void {
  if (!chatRuntimeStore.activeTitleGenerations.has(chatId)) {
    return;
  }

  chatRuntimeStore.getActiveTitleGeneration({ chatId })?.abort();
  chatRuntimeStore.deleteActiveTitleGeneration({ chatId });
}

export async function generateChatTitleForChat({
  chatId,
  titleModelIdOverride,
  signal,
}: {
  chatId: ChatId,
  titleModelIdOverride: string | undefined,
  signal: AbortSignal | undefined,
}): Promise<string | undefined> {
  const mutableChat = getLiveChatById({ chatId });
  if (mutableChat === null) {
    return undefined;
  }
  const taskId = mutableChat.id;
  const titleAtStart = mutableChat.title;

  if (chatRuntimeStore.activeTitleGenerations.has(taskId)) {
    chatRuntimeStore.getActiveTitleGeneration({ chatId: taskId })?.abort();
  }

  const controller = new AbortController();
  chatRuntimeStore.setActiveTitleGeneration({
    chatId: taskId,
    controller,
  });
  chatRuntimeStore.startTask({
    key: {
      kind: 'title',
      chatId: taskId,
    },
  });
  registerLiveInstance({ chat: mutableChat });

  try {
    const resolved = resolveTitleSettings({ chat: mutableChat });
    if (!resolved.hasReachableEndpoint) {
      return undefined;
    }

    const history = Array.from(getChatBranchIterator({ chat: mutableChat }));
    const content = stripNaidanSentinels({ content: history[0]?.content || '' });
    if (typeof content !== 'string' || content.length === 0) {
      return undefined;
    }

    const titleModelId = titleModelIdOverride || resolved.titleModelId || resolved.modelId;
    if (!titleModelId) {
      return undefined;
    }

    const provider = createTitleProvider({
      endpoint: resolved.endpoint,
    });

    const { language } = getTitleLanguage({ content });
    const systemPrompt = getTitleSystemPrompt({ language });
    const promptMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Message content to summarize: "${content.slice(0, 1000)}"` },
    ];
    const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    let generatedTitle = '';
    await provider.chat({
      messages: promptMessages,
      model: titleModelId,
      onChunk: ({ chunk }) => {
        generatedTitle += chunk;
      },
      parameters: undefined,
      signal: combinedSignal,
    });

    const finalTitle = cleanGeneratedTitle({ title: generatedTitle });
    if (!finalTitle) {
      return undefined;
    }

    if (mutableChat.title === titleAtStart) {
      await updateChatMeta({
        id: mutableChat.id,

        updater: ({ current }) => {
          if (current === null) {
            return mutableChat;
          }

          return {
            ...current,
            title: finalTitle,
            updatedAt: Date.now(),
          };
        },
      });
      await loadData();
      triggerCurrentChat({ chatId: mutableChat.id });
    }

    return finalTitle;
  } finally {
    chatRuntimeStore.finishTask({
      key: {
        kind: 'title',
        chatId: taskId,
      },
    });

    if (chatRuntimeStore.getActiveTitleGeneration({ chatId: taskId }) === controller) {
      chatRuntimeStore.deleteActiveTitleGeneration({ chatId: taskId });
    }
  }
}

function resolveTitleSettings({
  chat,
}: {
  chat: Chat,
}) {
  const { settings } = useSettings();
  const resolved = resolveChatSettings({
    chat,
    groups: collectChatGroups({ items: rootItems.value }),
    globalSettings: settings.value,
  });

  return {
    endpoint: resolved.endpoint,
    modelId: resolved.modelId,
    titleModelId: resolved.titleModelId,
    hasReachableEndpoint: !isHttpEndpoint(resolved.endpoint)
      || resolved.endpoint.url !== '',
  };
}

function collectChatGroups({
  items,
}: {
  items: typeof rootItems.value,
}) {
  return items.flatMap((item) => {
    switch (item.type) {
    case 'chat':
      return [];
    case 'chat_group':
      return [item.chatGroup];
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled sidebar item type: ${_ex}`);
    }
    }
  });
}

function getTitleLanguage({
  content,
}: {
  content: string,
}) {
  const typeOfNavigator = typeof navigator;
  switch (typeOfNavigator) {
  case 'undefined':
    return { language: detectLanguage({ content, fallbackLanguage: 'en' }) };
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return { language: detectLanguage({ content, fallbackLanguage: navigator.language }) };
  default: {
    const _ex: never = typeOfNavigator;
    throw new Error(`Unhandled navigator type: ${_ex}`);
  }
  }
}

function createTitleProvider({
  endpoint,
}: {
  endpoint: Endpoint,
}): LmProvider {
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    throw new Error(`${endpoint.type} title generation requires an endpoint URL`);
  }

  const { settings } = useSettings();
  return createLmProvider({
    endpoint,
    fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
  });
}
