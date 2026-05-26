import { computed, type ComputedRef, type Ref } from 'vue';
import type { ChatGroup, SidebarItem } from '@/models/types';
import type { ContextCompactProgress, ContextCompactPromptMode } from '@/services/context-compact';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useSettings } from '@/composables/useSettings';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import {
  chatRuntimeStore,
  contextCompactRuntime,
  getChatTargetByOptionalId,
  getLiveChat,
  getReadonlyChat,
  isProcessing,
  registerLiveInstance,
  rootItems,
  triggerCurrentChat,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import { createContextCompactService } from '@/composables/chat/services/context-compact-service';

export type ChatCompactAdapter = {
  progress: ComputedRef<ContextCompactProgress>;

  run({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<boolean>;

  abort(_args: Record<never, never>): void;

  TEST_ONLY: Record<string, never>;
};

export function useChatCompact({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatCompactAdapter {
  const { settings } = useSettings();
  const { addErrorEvent } = useGlobalEvents();
  const { getNaidanSysfsMountSelection } = useChatWeshPreferences();

  const chatGroups = computed(() => collectChatGroups({
    items: rootItems.value,
  }));

  const contextCompactService = createContextCompactService({
    getChatTarget: ({ chatId: targetChatId }) => getChatTargetByOptionalId({ chatId: targetChatId }),
    getLiveChat,
    isProcessing,
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const loadedChat = getReadonlyChat({ chatId: chat.id }) ?? chat;
      const resolved = resolveChatSettings({
        chat: loadedChat,
        groups: chatGroups.value,
        globalSettings: settings.value,
      });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        lmParameters: resolved.lmParameters,
      };
    },
    getPromptMode: ({ chatId: targetChatId }) => {
      return resolveCompactPromptMode({
        mountSelection: getNaidanSysfsMountSelection({ chatId: targetChatId }),
      });
    },
    runtime: contextCompactRuntime,
    updateChatContent,
    updateChatMeta,
    triggerCurrentChat,
    addErrorEvent,
    startProcessing: ({ chatId: processingChatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId: processingChatId } });
    },
    finishProcessing: ({ chatId: processingChatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId: processingChatId } });
    },
  });

  const progress = computed(() => contextCompactRuntime.getProgress({ chatId: chatId.value }));

  async function run({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<boolean> {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    const result = await contextCompactService.compactCurrentBranchForChat({
      chatId: id,
      keepRecentMessages,
      instructionOverride,
    });
    return result.status === 'compacted';
  }

  function abort(_args: Record<never, never>) {
    contextCompactService.abortContextCompact({ chatId: chatId.value });
  }

  return {
    progress,
    run,
    abort,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}

function resolveCompactPromptMode({
  mountSelection,
}: {
  mountSelection: ReturnType<ReturnType<typeof useChatWeshPreferences>['getNaidanSysfsMountSelection']>;
}): ContextCompactPromptMode {
  switch (mountSelection) {
  case 'none':
    return 'without_message_ids';
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'all_chats':
    return 'with_message_ids';
  default: {
    const _ex: never = mountSelection;
    throw new Error(`Unhandled naidan sysfs mount selection: ${_ex}`);
  }
  }
}

function collectChatGroups({
  items,
}: {
  items: SidebarItem[];
}): ChatGroup[] {
  const groups: ChatGroup[] = [];

  for (const item of items) {
    switch (item.type) {
    case 'chat':
      break;
    case 'chat_group':
      groups.push(item.chatGroup);
      break;
    default: {
      const _ex: never = item;
      return _ex;
    }
    }
  }

  return groups;
}
