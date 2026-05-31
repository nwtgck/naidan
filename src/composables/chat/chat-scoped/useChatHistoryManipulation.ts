import type { SystemPrompt } from '@/models/types';
import type { Ref } from 'vue';
import type { HistoryItem } from '@/utils/chat-tree';
import {
  commitFullHistoryManipulationForChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';
import { useChatReadModel } from './useChatReadModel';

export type ChatHistoryManipulationAdapter = {
  currentChat: ReturnType<typeof useChatReadModel>['currentChat'];
  activeMessages: ReturnType<typeof useChatReadModel>['activeMessages'];
  inheritedSettings: ReturnType<typeof useChatReadModel>['inheritedSettings'];

  commit({
    chatId,
    messages,
    systemPrompt,
  }: {
    chatId: string;
    messages: HistoryItem[];
    systemPrompt: SystemPrompt | undefined;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatHistoryManipulation({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatHistoryManipulationAdapter {
  const chatReadModel = useChatReadModel({ chatId });

  async function commit({
    chatId,
    messages,
    systemPrompt,
  }: {
    chatId: string;
    messages: HistoryItem[];
    systemPrompt: SystemPrompt | undefined;
  }) {
    await commitFullHistoryManipulationForChat({
      chatId,
      messages,
      systemPrompt,
    });
  }

  return {
    currentChat: chatReadModel.currentChat,
    activeMessages: chatReadModel.activeMessages,
    inheritedSettings: chatReadModel.inheritedSettings,
    commit,
    TEST_ONLY: {},
  };
}
