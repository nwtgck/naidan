import { computed, type ComputedRef, toRaw } from 'vue';
import type { MessageNode, CombinedToolCall, ToolCall, AssistantMessageNode } from '../models/types';
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

export type MessageMode = 'thinking' | 'content' | 'tool_calls' | 'waiting';

export interface SequenceStats {
  thinkingSteps: number;
  toolCallCount: number;
  toolNames: string[];
  isCurrentlyThinking: boolean;
  isCurrentlyToolRunning: boolean;
  isWaiting: boolean;
}

export type ChatFlowItem =
  | {
      type: 'message';
      node: MessageNode;
      flow: FlowMetadata;
      mode: MessageMode;
      partContent?: string;
      isFirstInNode: boolean;
      isLastInNode: boolean;
      isFirstInTurn: boolean;
      isCompletedThinking?: boolean;
    }
  | { type: 'tool_group'; id: string; toolCalls: CombinedToolCall[]; flow: FlowMetadata; node: MessageNode; isFirstInTurn: boolean }
  | { type: 'process_sequence'; id: string; items: ChatFlowItem[]; flow: FlowMetadata; summary: string; stats: SequenceStats; isFirstInTurn: boolean };

/**
 * A "ChatFlowAtom" is an atomic unit of a message branch before grouping.
 */
export type ChatFlowAtom =
  | { type: 'thinking'; node: MessageNode; content: string; isCompleted: boolean; isFirstInNode: boolean; isLastInNode: boolean; isFirstInTurn: boolean }
  | { type: 'content'; node: MessageNode; content: string; isFirstInNode: boolean; isLastInNode: boolean; isFirstInTurn: boolean }
  | { type: 'tool_calls'; node: MessageNode; toolCalls: ToolCall[]; isFirstInNode: boolean; isLastInNode: boolean; isFirstInTurn: boolean }
  | { type: 'tool_group'; id: string; toolCalls: CombinedToolCall[]; node: MessageNode; isFirstInTurn: boolean }
  | { type: 'waiting'; node: MessageNode; isFirstInNode: boolean; isLastInNode: boolean; isFirstInTurn: boolean };

export function useChatDisplayFlow({
  activeMessages,
  isProcessing
}: {
  activeMessages: ComputedRef<MessageNode[]>,
  isProcessing: ComputedRef<boolean>
}) {

  /**
   * Generator that splits a branch of MessageNodes into atoms.
   */
  function* yieldAtoms({ nodes }: { nodes: MessageNode[] }): Generator<ChatFlowAtom> {
    for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
      const node = nodes[nodeIdx]!;
      const rawNode = toRaw(node);
      const isFirstInTurn = nodeIdx === 0 || nodes[nodeIdx - 1]?.role !== rawNode.role;

      const role = rawNode.role;
      switch (role) {
      case 'user':
      case 'system':
        yield {
          type: 'content',
          node,
          content: rawNode.content || '',
          isFirstInNode: true,
          isLastInNode: true,
          isFirstInTurn
        };
        break;

      case 'assistant': {
        const nodeAtoms: (Exclude<ChatFlowAtom, { type: 'tool_group' }>)[] = [];
        const content = rawNode.content || '';

        // 1. Completed thinking from node property
        if (rawNode.thinking) {
          nodeAtoms.push({
            type: 'thinking',
            node,
            content: rawNode.thinking,
            isCompleted: true,
            isFirstInNode: false, // will be set later
            isLastInNode: false,
            isFirstInTurn: false
          });
        }

        // 2. Parse inline tags in content (streaming support)
        const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
        let lastIdx = 0;
        let match;
        while ((match = thinkRegex.exec(content)) !== null) {
          // Content BEFORE the think block
          const before = content.slice(lastIdx, match.index).trim();
          if (before) {
            nodeAtoms.push({ type: 'content', node, content: before, isFirstInNode: false, isLastInNode: false, isFirstInTurn: false });
          }
          // The think block itself
          const thinkContent = match[1]?.trim();
          if (thinkContent) {
            nodeAtoms.push({ type: 'thinking', node, content: thinkContent, isCompleted: true, isFirstInNode: false, isLastInNode: false, isFirstInTurn: false });
          }
          lastIdx = thinkRegex.lastIndex;
        }

        const remaining = content.slice(lastIdx);
        const lastOpen = remaining.lastIndexOf('<think>');
        const lastClose = remaining.lastIndexOf('</think>');
        const isActiveThinking = lastOpen > -1 && lastClose < lastOpen && isProcessing.value;

        if (isActiveThinking) {
          const bodyBefore = remaining.slice(0, lastOpen).trim();
          if (bodyBefore) {
            nodeAtoms.push({ type: 'content', node, content: bodyBefore, isFirstInNode: false, isLastInNode: false, isFirstInTurn: false });
          }
          const activeThink = remaining.slice(lastOpen + 7).trim();
          nodeAtoms.push({ type: 'thinking', node, content: activeThink, isCompleted: false, isFirstInNode: false, isLastInNode: false, isFirstInTurn: false });
        } else {
          const cleanBody = stripNaidanSentinels(remaining).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          if (cleanBody) {
            nodeAtoms.push({ type: 'content', node, content: cleanBody, isFirstInNode: false, isLastInNode: false, isFirstInTurn: false });
          }
        }

        // 3. Tool Calls (Internal)
        if (rawNode.toolCalls && rawNode.toolCalls.length > 0) {
          nodeAtoms.push({ type: 'tool_calls', node, toolCalls: rawNode.toolCalls, isFirstInNode: false, isLastInNode: false, isFirstInTurn: false });
        }

        // 4. Waiting indicator
        if (nodeAtoms.length === 0 && isProcessing.value && nodeIdx === nodes.length - 1) {
          nodeAtoms.push({ type: 'waiting', node, isFirstInNode: false, isLastInNode: false, isFirstInTurn: false });
        }

        // Finalize node atoms
        if (nodeAtoms.length > 0) {
          nodeAtoms[0]!.isFirstInNode = true;
          nodeAtoms[0]!.isFirstInTurn = isFirstInTurn;
          nodeAtoms[nodeAtoms.length - 1]!.isLastInNode = true;
          for (const atom of nodeAtoms) yield atom;
        }
        break;
      }

      case 'tool': {
        const isFirstInTurn = nodeIdx === 0 || nodes[nodeIdx - 1]?.role !== rawNode.role;
        let triggeringAssistant: AssistantMessageNode | null = null;
        for (let j = nodeIdx - 1; j >= 0; j--) {
          const prev = nodes[j];
          if (prev?.role === 'assistant' && prev.toolCalls?.some(tc => rawNode.results.some(er => er.toolCallId === tc.id))) {
            triggeringAssistant = prev;
            break;
          }
        }
        if (triggeringAssistant) {
          const toolCalls: CombinedToolCall[] = rawNode.results.map(er => ({
            id: er.toolCallId, nodeId: rawNode.id, call: triggeringAssistant!.toolCalls!.find(tc => tc.id === er.toolCallId)!, result: er
          }));
          yield { type: 'tool_group', id: rawNode.id, toolCalls, node, isFirstInTurn };
        } else {
          yield { type: 'content', node, content: '[Tool Results]', isFirstInNode: true, isLastInNode: true, isFirstInTurn };
        }
        break;
      }
      default: { const _ex: never = role; throw new Error(`Unhandled role: ${_ex}`); }
      }
    }
  }

  /**
   * Generator that groups internal atoms into sequences.
   */
  function* yieldGroupedItems({ atomIterator }: { atomIterator: Iterable<ChatFlowAtom> }): Generator<ChatFlowItem> {
    let buffer: ChatFlowItem[] = [];

    const isInternal = ({ atom }: { atom: ChatFlowAtom }): boolean => {
      switch (atom.type) {
      case 'thinking': return atom.isCompleted; // Only completed thinking is hidden
      case 'tool_calls':
      case 'tool_group': return true; // Tools are always hidden
      case 'content':
      case 'waiting': return false; // Body and waiting are always exposed
      default: { const _ex: never = atom; return _ex; }
      }
    };

    const flush = function* (): Generator<ChatFlowItem> {
      if (buffer.length > 1) {
        const stats = calculateStats({ items: buffer });
        const first = buffer[0]!;
        const firstType = first.type;
        const id = (() => {
          switch (firstType) {
          case 'message': return `seq-${first.node.id}-${first.mode}`;
          case 'tool_group': return `seq-${first.id}`;
          case 'process_sequence': return `seq-${first.id}`;
          default: {
            const _ex: never = firstType;
            return _ex;
          }
          }
        })();

        // Mark all items in the sequence as nested
        const nestedItems = buffer.map(item => ({
          ...item,
          flow: { ...item.flow, nesting: 'inside-group' as const }
        }));

        yield { type: 'process_sequence', id, items: nestedItems, flow: { position: 'standalone', nesting: 'none' }, summary: calculateSummary({ stats }), stats, isFirstInTurn: first.isFirstInTurn };
      } else if (buffer.length === 1) {
        yield buffer[0]!;
      }
      buffer = [];
    };

    for (const atom of atomIterator) {
      const item = atomToFlowItem({ atom });
      if (isInternal({ atom })) {
        buffer.push(item);
      } else {
        yield* flush();
        yield item;
      }
    }
    yield* flush();
  }

  const atomToFlowItem = ({ atom }: { atom: ChatFlowAtom }): ChatFlowItem => {
    const type = atom.type;
    switch (type) {
    case 'tool_group':
      return { type: 'tool_group', id: atom.id, toolCalls: atom.toolCalls, node: atom.node, flow: { position: 'standalone', nesting: 'none' }, isFirstInTurn: atom.isFirstInTurn };
    case 'thinking':
    case 'content':
    case 'waiting':
    case 'tool_calls': {
      const mode: MessageMode = (() => {
        switch (type) {
        case 'thinking': return 'thinking';
        case 'content': return 'content';
        case 'waiting': return 'waiting';
        case 'tool_calls': return 'tool_calls';
        default: {
          const _ex: never = type;
          return _ex;
        }
        }
      })();
      const isCompletedThinking = (() => {
        switch (type) {
        case 'thinking': return atom.isCompleted;
        case 'content':
        case 'waiting':
        case 'tool_calls': return undefined;
        default: {
          const _ex: never = type;
          return _ex;
        }
        }
      })();
      return {
        type: 'message', node: atom.node, mode, partContent: (type === 'thinking' || type === 'content') ? atom.content : undefined,
        isFirstInNode: atom.isFirstInNode, isLastInNode: atom.isLastInNode, isFirstInTurn: atom.isFirstInTurn,
        isCompletedThinking,
        flow: { position: 'standalone', nesting: 'none' }
      };
    }
    default: { const _ex: never = type; return _ex; }
    }
  };

  const calculateStats = ({ items }: { items: ChatFlowItem[] }): SequenceStats => {
    let thinkingSteps = 0;
    const seenToolIds = new Set<string>();
    const toolNames: string[] = [];
    items.forEach(item => {
      const type = item.type;
      switch (type) {
      case 'message': {
        const mode = item.mode;
        switch (mode) {
        case 'thinking':
          thinkingSteps++;
          break;
        case 'tool_calls': {
          const node = item.node;
          if (node.role === 'assistant' && node.toolCalls) {
            node.toolCalls.forEach(tc => {
              if (!seenToolIds.has(tc.id)) {
                seenToolIds.add(tc.id);
                toolNames.push(tc.function.name);
              }
            });
          }
          break;
        }
        case 'content':
        case 'waiting':
          break;
        default: {
          const _ex: never = mode;
          return _ex;
        }
        }
        break;
      }
      case 'tool_group':
        item.toolCalls.forEach(tc => {
          if (!seenToolIds.has(tc.id)) {
            seenToolIds.add(tc.id);
            toolNames.push(tc.call.function.name);
          }
        });
        break;
      case 'process_sequence':
        break;
      default: { const _ex: never = type; return _ex; }
      }
    });
    return { thinkingSteps, toolCallCount: seenToolIds.size, toolNames: [...new Set(toolNames)], isCurrentlyThinking: false, isCurrentlyToolRunning: false, isWaiting: false };
  };

  const calculateSummary = ({ stats }: { stats: SequenceStats }): string => {
    const parts: string[] = [];
    if (stats.thinkingSteps > 0) parts.push(`${stats.thinkingSteps} thinking step${stats.thinkingSteps > 1 ? 's' : ''}`);
    if (stats.toolCallCount > 0) parts.push(`${stats.toolCallCount} tool execution${stats.toolCallCount > 1 ? 's' : ''}`);
    if (stats.toolNames.length > 0) {
      const limit = 2;
      const displayed = stats.toolNames.slice(0, limit);
      let toolStr = `Used ${displayed.join(', ')}`;
      if (stats.toolNames.length > limit) toolStr += ` and ${stats.toolNames.length - limit} more`;
      parts.push(toolStr);
    }
    return parts.join(' • ') || 'Process Details';
  };

  const chatFlow = computed<ChatFlowItem[]>(() => {
    const items = Array.from(yieldGroupedItems({ atomIterator: { [Symbol.iterator]: () => yieldAtoms({ nodes: activeMessages.value }) } }));

    return items.map((item, idx) => {
      const prev = items[idx - 1] || null;
      const next = items[idx + 1] || null;
      const isAI = (i: ChatFlowItem | null) => i?.type === 'process_sequence' || i?.type === 'tool_group' || (i?.type === 'message' && i.node.role === 'assistant');

      let position: SequencePosition = 'standalone';
      if (isAI(item)) {
        if (isAI(prev) && isAI(next)) position = 'middle';
        else if (isAI(prev)) position = 'end';
        else if (isAI(next)) position = 'start';
      }
      return { ...item, flow: { position, nesting: 'none' } };
    });
  });

  return {
    chatFlow,
    isThinkingActive: ({ item }: { item: ChatFlowItem }) => item.type === 'message' && item.mode === 'thinking' && item.isCompletedThinking === false,
    isWaitingResponse: ({ item }: { item: ChatFlowItem }) => item.type === 'message' && item.mode === 'waiting',
    __testOnly: {}
  };
}
