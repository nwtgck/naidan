import type { Reasoning } from '@/models/types';
import { createChatCurrentBridge } from '@/composables/chat/chat-current-bridge';
import {
  currentChatGroupRef,
  currentChatRef,
  getLiveChat,
  liveChatRegistry,
  loadData,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import { createChatMetadataService } from '@/composables/chat/services/chat-metadata-service';

export type ReasoningStoreAdapter = {
  getReasoningEffort({
    chatId,
  }: {
    chatId: string;
  }): Reasoning['effort'] | undefined;

  updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string;
    effort: Reasoning['effort'];
  }): Promise<void> | void;

  TEST_ONLY: Record<string, never>;
};

export function useReasoningStore(): ReasoningStoreAdapter {
  const chatCurrentBridge = createChatCurrentBridge({
    currentChatRef,
    currentChatGroupRef,
    liveChatRegistry,
    getLiveChat,
  });
  const chatMetadataService = createChatMetadataService({
    getChatTarget: ({ id }) => chatCurrentBridge.getChatTargetById({ id }),
    getCurrentChat: () => chatCurrentBridge.getCurrentChat({}),
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    updateChatMeta,
    loadData,
  });

  return {
    getReasoningEffort: chatMetadataService.getReasoningEffort,
    updateReasoningEffort: chatMetadataService.updateReasoningEffort,
    TEST_ONLY: {},
  };
}
