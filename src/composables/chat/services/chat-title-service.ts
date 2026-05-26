import type { Chat, ChatMessage } from '@/models/types';
import type { LLMProvider } from '@/services/lm/types';
import { OpenAIProvider } from '@/services/lm/openai';
import { OllamaProvider } from '@/services/lm/ollama';
import { TransformersJsProvider } from '@/services/transformers-js/provider';
import { getChatBranchIterator } from '@/utils/chat-tree';
import { stripNaidanSentinels } from '@/utils/image-generation';
import { cleanGeneratedTitle, detectLanguage, getTitleSystemPrompt } from '@/utils/title-generator';
import type { ResolvableLmParameters, ResolvableSettings } from '@/utils/chat-settings-resolver';
import type { ChatRuntimeStore } from '@/composables/chat/global/chat-runtime-store';

type ResolvedTitleSettings = {
  endpointType: ResolvableSettings['endpointType'];
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
  modelId: string;
  titleModelId: string;
};

export type ChatTitleService = {
  generateChatTitle({
    chatId,
    signal,
    titleModelIdOverride,
  }: {
    chatId: string | undefined;
    signal: AbortSignal | undefined;
    titleModelIdOverride: string | undefined;
  }): Promise<string | undefined>;

  abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined;
  }): void;
};

export function createChatTitleService({
  getCurrentChatId,
  getChatTarget,
  getLiveChat,
  registerLiveInstance,
  resolveSettings,
  updateChatMeta,
  loadData,
  triggerCurrentChat,
  runtimeStore,
  getFallbackLanguage,
}: {
  getCurrentChatId: () => string | null;
  getChatTarget: ({ chatId }: { chatId: string | undefined }) => Chat | null;
  getLiveChat: ({ chat }: { chat: Chat }) => Chat;
  registerLiveInstance: ({ chat }: { chat: Chat }) => void;
  resolveSettings: ({ chat }: { chat: Chat }) => ResolvedTitleSettings & { lmParameters: ResolvableLmParameters };
  updateChatMeta: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) => Promise<void>;
  loadData: (_args: Record<never, never>) => Promise<void>;
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
  runtimeStore: ChatRuntimeStore;
  getFallbackLanguage: (_args: Record<never, never>) => string;
}): ChatTitleService {
  async function generateChatTitle({
    chatId,
    signal,
    titleModelIdOverride,
  }: {
    chatId: string | undefined;
    signal: AbortSignal | undefined;
    titleModelIdOverride: string | undefined;
  }) {
    const target = getChatTarget({ chatId });
    if (!target) return undefined;

    const mutableChat = getLiveChat({ chat: target });
    const taskId = mutableChat.id;
    const titleAtStart = mutableChat.title;

    if (runtimeStore.activeTitleGenerations.has(taskId)) {
      runtimeStore.getActiveTitleGeneration({ chatId: taskId })?.abort();
    }

    const controller = new AbortController();
    runtimeStore.setActiveTitleGeneration({
      chatId: taskId,
      controller,
    });
    runtimeStore.startTask({
      key: {
        kind: 'title',
        chatId: taskId,
      },
    });
    registerLiveInstance({ chat: mutableChat });

    try {
      const resolved = resolveSettings({ chat: mutableChat });
      if (!resolved.endpointUrl && resolved.endpointType !== 'transformers_js') {
        runtimeStore.finishTask({ key: { kind: 'title', chatId: taskId } });
        return undefined;
      }

      const history = Array.from(getChatBranchIterator({ chat: mutableChat }));
      const content = stripNaidanSentinels({ content: history[0]?.content || '' });
      if (!content || typeof content !== 'string') {
        runtimeStore.finishTask({ key: { kind: 'title', chatId: taskId } });
        return undefined;
      }

      const titleGenModel = titleModelIdOverride || resolved.titleModelId || resolved.modelId;
      if (!titleGenModel) return undefined;

      let generatedTitle = '';
      const titleProvider = createTitleProvider({
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
      });

      const lang = detectLanguage({
        content,
        fallbackLanguage: getFallbackLanguage({}),
      });
      const systemPrompt = getTitleSystemPrompt({ language: lang });
      const promptMsgs: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Message content to summarize: "${content.slice(0, 1000)}"` },
      ];
      const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

      await titleProvider.chat({
        messages: promptMsgs,
        model: titleGenModel,
        onChunk: (chunk: string) => {
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
          updater: (current) => {
            if (!current) return mutableChat;
            return {
              ...current,
              title: finalTitle,
              updatedAt: Date.now(),
            };
          },
        });
        await loadData({});
        triggerCurrentChat({ chatId: mutableChat.id });
      }
      return finalTitle;
    } finally {
      runtimeStore.finishTask({
        key: {
          kind: 'title',
          chatId: taskId,
        },
      });
      if (runtimeStore.getActiveTitleGeneration({ chatId: taskId }) === controller) {
        runtimeStore.deleteActiveTitleGeneration({ chatId: taskId });
      }
    }
  }

  function abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    const id = chatId || getCurrentChatId();
    if (id && runtimeStore.activeTitleGenerations.has(id)) {
      runtimeStore.getActiveTitleGeneration({ chatId: id })?.abort();
      runtimeStore.deleteActiveTitleGeneration({ chatId: id });
    }
  }

  return {
    generateChatTitle,
    abortTitleGeneration,
  };
}

function createTitleProvider({
  endpointType,
  endpointUrl,
  endpointHttpHeaders,
}: {
  endpointType: ResolvableSettings['endpointType'];
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
}): LLMProvider {
  switch (endpointType) {
  case 'openai':
    if (!endpointUrl) {
      throw new Error('OpenAI title generation requires an endpoint URL');
    }
    return new OpenAIProvider({ endpoint: endpointUrl, headers: endpointHttpHeaders });
  case 'ollama':
    if (!endpointUrl) {
      throw new Error('Ollama title generation requires an endpoint URL');
    }
    return new OllamaProvider({ endpoint: endpointUrl, headers: endpointHttpHeaders });
  case 'transformers_js':
    return new TransformersJsProvider();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unsupported endpoint type for title generation: ${_ex}`);
  }
  }
}
