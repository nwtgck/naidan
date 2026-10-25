import { computed, type ComputedRef } from 'vue';
import type { Chat } from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';
import type { GenerationMetricsPresentation } from '@/01-models/generation-metrics';
import type { ChatFlowItem } from './useChatDisplayFlow';
import { generationMetricsState } from './chat/global/generation-metrics-state';

function containsLastPart({ item, messageId }: { item: ChatFlowItem, messageId: MessageId }): boolean {
  switch (item.type) {
  case 'message': return item.node.id === messageId && item.isLastInNode;
  case 'process_sequence': return item.items.some(child => containsLastPart({ item: child, messageId }));
  case 'tool_group': return false;
  default: {
    const exhaustive: never = item;
    throw new Error(String(exhaustive));
  }
  }
}

/** Only top-level items own a display. Expanding a process sequence cannot duplicate it. */
export function resolveGenerationMetricsHosts({ flow, presentations }: { flow: readonly ChatFlowItem[], presentations: readonly { messageId: MessageId, presentation: GenerationMetricsPresentation }[] }): Map<string, GenerationMetricsPresentation> {
  const hosts = new Map<string, GenerationMetricsPresentation>();
  for (const { messageId, presentation } of presentations) {
    const host = flow.findLast(item => containsLastPart({ item, messageId }));
    if (host === undefined) {
      continue;
    }
    switch (host.type) {
    case 'message': hosts.set(host.key, presentation);
      break;
    case 'process_sequence': hosts.set(host.id, presentation);
      break;
    case 'tool_group': break;
    default: {
      const exhaustive: never = host;
      throw new Error(String(exhaustive));
    }
    }
  }
  return hosts;
}

export function useGenerationMetrics({ chat, chatFlow }: { chat: ComputedRef<Chat | null>, chatFlow: ComputedRef<ChatFlowItem[]> }) {
  const generationMetrics = computed(() => resolveGenerationMetricsHosts({ flow: chatFlow.value, presentations: chat.value === null ? [] : generationMetricsState.presentations({ chat: chat.value }) }));
  return { generationMetrics, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
