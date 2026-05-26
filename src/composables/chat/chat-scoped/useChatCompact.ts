import { computed, type ComputedRef, type Ref } from 'vue';
import type { Settings } from '@/models/types';
import type { ContextCompactProgress, ContextCompactPromptMode } from '@/services/context-compact';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useSettings } from '@/composables/useSettings';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { createChatCurrentBridge } from '@/composables/chat/chat-current-bridge';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import {
  chatRuntimeStore,
  contextCompactRuntime,
  currentChatGroupRef,
  currentChatRef,
  getLiveChat,
  isProcessing,
  liveChatRegistry,
  registerLiveInstance,
  rootItems,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/chat-core-singletons';
import { createContextCompactService } from '@/composables/chat/context-compact-service';

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
};

export function useChatCompact({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatCompactAdapter {
  const { settings } = useSettings();
  const { addErrorEvent } = useGlobalEvents();
  const { getNaidanSysfsMountSelection } = useChatWeshPreferences();

  const chatCurrentBridge = createChatCurrentBridge({
    currentChatRef,
    currentChatGroupRef,
    liveChatRegistry,
    getLiveChat,
  });
  const chatDerivedState = createChatDerivedState({
    currentChatRef,
    rootItems,
    getSettings: () => settings.value as Settings,
  });
  const chatGroups = chatDerivedState.chatGroups;

  const contextCompactService = createContextCompactService({
    getCurrentChat: () => chatCurrentBridge.getCurrentChat({}),
    getChatTarget: ({ chatId: targetChatId }) => chatCurrentBridge.getChatTargetByOptionalId({ chatId: targetChatId }),
    getLiveChat,
    isProcessing,
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({
        chat,
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
    triggerCurrentChat: ({ chatId: targetChatId }) => chatCurrentBridge.triggerCurrentChat({ chatId: targetChatId }),
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
