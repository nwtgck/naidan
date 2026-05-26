import { computed, type ComputedRef, type Ref } from 'vue';
import type { ContextCompactProgress } from '@/services/context-compact';
import { contextCompactRuntime } from '@/composables/chat/global/chat-core-singletons';
import {
  abortContextCompactForChat,
  runCompactCurrentBranchForChat,
} from '@/composables/chat/chat-scoped/chat-compact-flow';

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

    const result = await runCompactCurrentBranchForChat({
      chatId: id,
      keepRecentMessages,
      instructionOverride,
    });
    return result.status === 'compacted';
  }

  function abort(_args: Record<never, never>) {
    abortContextCompactForChat({ chatId: chatId.value });
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
