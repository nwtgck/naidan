import { computed, type ComputedRef } from 'vue';
import type { Chat, ChatGroup, MessageNode } from '@/models/types';
import { useChat } from '@/composables/useChat';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';

export type CurrentChatStateAdapter = {
  currentChat: ComputedRef<Readonly<Chat> | null>;
  currentChatGroup: ComputedRef<Readonly<ChatGroup> | null>;
  currentChatId: ComputedRef<string | undefined>;
  activeMessages: ComputedRef<MessageNode[]>;
  allMessages: ComputedRef<MessageNode[]>;
  resolvedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>;
  inheritedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>;
  chatGroups: ComputedRef<ChatGroup[]>;

  TEST_ONLY: Record<string, never>;
};

export function useCurrentChatState(): CurrentChatStateAdapter {
  const chatStore = useChat();

  const currentChat = computed(() => chatStore.currentChat.value);
  const currentChatGroup = computed(() => chatStore.currentChatGroup.value);
  const currentChatId = computed(() => currentChat.value?.id);
  const activeMessages = computed(() => chatStore.activeMessages.value);
  const allMessages = computed(() => chatStore.allMessages.value);
  const resolvedSettings = computed(() => chatStore.resolvedSettings?.value ?? null);
  const inheritedSettings = computed(() => chatStore.inheritedSettings?.value ?? null);
  const chatGroups = computed(() => chatStore.chatGroups?.value ?? []);

  return {
    currentChat,
    currentChatGroup,
    currentChatId,
    activeMessages,
    allMessages,
    resolvedSettings,
    inheritedSettings,
    chatGroups,
    TEST_ONLY: {},
  };
}
