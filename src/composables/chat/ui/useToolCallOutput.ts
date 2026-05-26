import { computed, type ComputedRef } from 'vue';
import { useChat } from '@/composables/useChat';

export type ToolCallOutputAdapter = {
  getOutput({
    toolCallId,
    status,
  }: {
    toolCallId: string;
    status: 'executing' | 'success' | 'error';
  }): ComputedRef<string | undefined>;

  TEST_ONLY: Record<string, never>;
};

export function useToolCallOutput(): ToolCallOutputAdapter {
  const chatStore = useChat();

  function getOutput({
    toolCallId,
    status,
  }: {
    toolCallId: string;
    status: 'executing' | 'success' | 'error';
  }) {
    return computed(() => {
      switch (status) {
      case 'executing':
        return chatStore.getVolatileToolOutput({ toolCallId }) || undefined;
      case 'success':
      case 'error':
        return undefined;
      default: {
        const _ex: never = status;
        throw new Error(`Unhandled tool result status: ${_ex}`);
      }
      }
    });
  }

  return {
    getOutput,
    TEST_ONLY: {},
  };
}
