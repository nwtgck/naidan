import { computed, type ComputedRef } from 'vue';
import type { MessageNode, DisplayMessage, CombinedToolCall } from '../models/types';
import { stripNaidanSentinels } from '../utils/image-generation';

/**
 * Position within a continuous sequence of AI-related items.
 */
export type SequencePosition = 'standalone' | 'start' | 'middle' | 'end';

/**
 * Nesting state of the item.
 */
export type NestingLevel = 'none' | 'inside-group';

export interface FlowMetadata {
  readonly position: SequencePosition;
  readonly nesting: NestingLevel;
}

export interface SequenceStats {
  thinkingSteps: number;
  toolCallCount: number;
  toolNames: string[];
  isCurrentlyThinking: boolean;
  isCurrentlyToolRunning: boolean;
  isWaiting: boolean;
}

export type ChatFlowItem =
  | { type: 'message'; node: MessageNode; flow: FlowMetadata }
  | { type: 'tool_group'; id: string; toolCalls: CombinedToolCall[]; flow: FlowMetadata }
  | { type: 'process_sequence'; id: string; items: ChatFlowItem[]; flow: FlowMetadata; summary: string; stats: SequenceStats };

export function useChatDisplayFlow({
  activeDisplayMessages,
  isProcessing
}: {
  activeDisplayMessages: ComputedRef<DisplayMessage[]>,
  isProcessing: ComputedRef<boolean>
}) {

  const isThinkingActive = ({ item }: { item: ChatFlowItem | DisplayMessage }): boolean => {
    const node = (() => {
      switch (item.type) {
      case 'message': return item.node;
      case 'tool_group': return null;
      case 'process_sequence': return null;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    })();
    if (!node) return false;

    const role = node.role;
    switch (role) {
    case 'assistant': {
      if (node.thinking) return false;
      const content = node.content || '';
      const lastOpen = content.lastIndexOf('<think>');
      const lastClose = content.lastIndexOf('</think>');
      return lastOpen > -1 && lastClose < lastOpen && isProcessing.value;
    }
    case 'user':
    case 'system':
    case 'tool':
      return false;
    default: {
      const _ex: never = role;
      return _ex;
    }
    }
  };

  const isWaitingResponse = ({ item }: { item: ChatFlowItem | DisplayMessage }): boolean => {
    const node = (() => {
      switch (item.type) {
      case 'message': return item.node;
      case 'tool_group': return null;
      case 'process_sequence': return null;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    })();
    if (!node) return false;

    const role = node.role;
    switch (role) {
    case 'assistant': {
      const content = stripNaidanSentinels(node.content || '').trim();
      return content.length === 0 && !node.thinking && !isThinkingActive({ item }) && isProcessing.value;
    }
    case 'user':
    case 'system':
    case 'tool':
      return false;
    default: {
      const _ex: never = role;
      return _ex;
    }
    }
  };

  const isInternal = ({ item }: { item: DisplayMessage }): boolean => {
    switch (item.type) {
    case 'tool_group': return true;
    case 'message': {
      const node = item.node;
      const role = node.role;
      switch (role) {
      case 'assistant': {
        const content = item.node.content || '';
        const cleanContent = stripNaidanSentinels(content)
          .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
          .trim();
        return cleanContent.length === 0;
      }
      case 'user':
      case 'system':
      case 'tool':
        return false;
      default: {
        const _ex: never = role;
        return _ex;
      }
      }
    }
    default: {
      const _ex: never = item;
      return _ex;
    }
    }
  };

  const isAI = ({ item }: { item: DisplayMessage | { type: 'process_sequence', items: DisplayMessage[] } }): boolean => {
    const type = item.type;
    switch (type) {
    case 'process_sequence':
    case 'tool_group':
      return true;
    case 'message': {
      const role = item.node.role;
      switch (role) {
      case 'assistant': return true;
      case 'user':
      case 'system':
      case 'tool':
        return false;
      default: {
        const _ex: never = role;
        return _ex;
      }
      }
    }
    default: {
      const _ex: never = type;
      return _ex;
    }
    }
  };

  const getStats = ({ items }: { items: DisplayMessage[] }): SequenceStats => {
    let thinkingSteps = 0;
    let toolCallCount = 0;
    const toolNames: string[] = [];
    let isCurrentlyThinking = false;
    let isCurrentlyToolRunning = false;
    let isWaiting = false;

    items.forEach((item, idx) => {
      switch (item.type) {
      case 'message': {
        const node = item.node;
        const role = node.role;
        switch (role) {
        case 'assistant': {
          const hasThink = node.thinking || /<think>/i.test(node.content || '');
          if (hasThink) {
            thinkingSteps++;
            if (isThinkingActive({ item })) isCurrentlyThinking = true;
          }
          if (idx === items.length - 1 && isWaitingResponse({ item })) {
            isWaiting = true;
          }
          break;
        }
        case 'user':
        case 'system':
        case 'tool':
          break;
        default: {
          const _ex: never = role;
          throw new Error(`Unhandled role: ${_ex}`);
        }
        }
        break;
      }
      case 'tool_group': {
        toolCallCount += item.toolCalls.length;
        item.toolCalls.forEach((tc) => {
          toolNames.push(tc.call.function.name);
          const status = tc.result.status;
          switch (status) {
          case 'running':
            isCurrentlyToolRunning = true;
            break;
          case 'success':
          case 'error':
            break;
          default: {
            const _ex: never = status;
            throw new Error(`Unhandled status: ${_ex}`);
          }
          }
        });
        break;
      }
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled type: ${(_ex as { type: string }).type}`);
      }
      }
    });

    return { thinkingSteps, toolCallCount, toolNames, isCurrentlyThinking, isCurrentlyToolRunning, isWaiting };
  };

  const calculateSummary = ({ stats }: { stats: SequenceStats }): string => {
    const parts: string[] = [];

    if (stats.thinkingSteps > 0) {
      parts.push(`${stats.thinkingSteps} thinking step${stats.thinkingSteps > 1 ? 's' : ''}`);
    }

    if (stats.toolCallCount > 0) {
      parts.push(`${stats.toolCallCount} tool execution${stats.toolCallCount > 1 ? 's' : ''}`);
    }

    if (stats.toolNames.length > 0) {
      const limit = 2;
      const unique = stats.toolNames;
      const displayed = unique.slice(0, limit);
      let toolStr = `Used ${displayed.join(', ')}`;
      if (unique.length > limit) toolStr += ` and ${unique.length - limit} more`;
      parts.push(toolStr);
    }

    if (stats.isCurrentlyThinking) parts.push('Thinking...');
    else if (stats.isCurrentlyToolRunning) parts.push('Executing tools...');
    else if (stats.isWaiting) parts.push('Waiting for response...');

    return parts.join(' • ') || 'Processing...';
  };

  const chatFlow = computed<ChatFlowItem[]>(() => {
    const source = activeDisplayMessages.value;

    // 1. Group internal processes
    const grouped: (DisplayMessage | { type: 'process_sequence', items: DisplayMessage[] })[] = [];
    let currentGroup: DisplayMessage[] = [];

    source.forEach(item => {
      if (isInternal({ item })) {
        currentGroup.push(item);
      } else {
        if (currentGroup.length > 1) {
          grouped.push({ type: 'process_sequence', items: [...currentGroup] });
        } else if (currentGroup.length === 1) {
          const first = currentGroup[0];
          if (first) grouped.push(first);
        }
        currentGroup = [];
        grouped.push(item);
      }
    });
    if (currentGroup.length > 1) {
      grouped.push({ type: 'process_sequence', items: currentGroup });
    } else if (currentGroup.length === 1) {
      const first = currentGroup[0];
      if (first) grouped.push(first);
    }

    // 2. Calculate Flow Metadata
    const result: ChatFlowItem[] = [];
    for (let i = 0; i < grouped.length; i++) {
      const item = grouped[i];
      if (!item) continue;

      const prev = i > 0 ? grouped[i - 1] : null;
      const next = i < grouped.length - 1 ? grouped[i + 1] : null;

      let position: SequencePosition = 'standalone';
      if (isAI({ item })) {
        const hasPrevAI = prev && isAI({ item: prev });
        const hasNextAI = next && isAI({ item: next });
        if (hasPrevAI && hasNextAI) position = 'middle';
        else if (hasPrevAI) position = 'end';
        else if (hasNextAI) position = 'start';
      }

      const type = item.type;
      switch (type) {
      case 'process_sequence': {
        const subItems: ChatFlowItem[] = item.items.map(sub => ({
          ...sub,
          flow: { position: 'middle', nesting: 'inside-group' }
        } as ChatFlowItem));

        const stats = getStats({ items: item.items });
        const first = subItems[0];
        let id = 'seq-unknown';
        if (first) {
          const firstType = first.type;
          switch (firstType) {
          case 'message':
            id = 'seq-' + first.node.id;
            break;
          case 'tool_group':
          case 'process_sequence':
            id = 'seq-' + first.id;
            break;
          default: {
            const _ex: never = firstType;
            id = 'seq-' + (_ex as { id: string }).id;
          }
          }
        }

        result.push({
          type: 'process_sequence',
          id,
          items: subItems,
          flow: { position, nesting: 'none' },
          summary: calculateSummary({ stats }),
          stats
        });
        break;
      }
      case 'message':
      case 'tool_group': {
        result.push({
          ...item,
          flow: { position, nesting: 'none' }
        } as ChatFlowItem);
        break;
      }
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled type: ${(_ex as { type: string }).type}`);
      }
      }
    }

    return result;
  });

  return {
    chatFlow,
    isThinkingActive,
    isWaitingResponse,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
