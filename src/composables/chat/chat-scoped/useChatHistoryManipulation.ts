import type { SystemPrompt } from '@/models/types';
import type { HistoryItem } from '@/utils/chat-tree';
import { useChat } from '@/composables/useChat';
import { useCurrentChatState } from './useCurrentChatState';

export type ChatHistoryManipulationAdapter = {
  currentChat: ReturnType<typeof useCurrentChatState>['currentChat'];
  activeMessages: ReturnType<typeof useCurrentChatState>['activeMessages'];
  inheritedSettings: ReturnType<typeof useCurrentChatState>['inheritedSettings'];

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

export function useChatHistoryManipulation(): ChatHistoryManipulationAdapter {
  const chatStore = useChat();
  const currentChatState = useCurrentChatState();

  async function commit({
    chatId,
    messages,
    systemPrompt,
  }: {
    chatId: string;
    messages: HistoryItem[];
    systemPrompt: SystemPrompt | undefined;
  }) {
    await chatStore.commitFullHistoryManipulation({
      chatId,
      messages,
      systemPrompt,
    });
  }

  return {
    currentChat: currentChatState.currentChat,
    activeMessages: currentChatState.activeMessages,
    inheritedSettings: currentChatState.inheritedSettings,
    commit,
    TEST_ONLY: {},
  };
}
