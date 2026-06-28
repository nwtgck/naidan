import { generateId } from './id';
import { toRaw } from 'vue';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import type { MessageNode, AssistantMessageNode, UserMessageNode, SystemMessageNode, SidebarItem, Chat } from '@/01-models/types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import type { MessageId } from '@/01-models/ids';

export function fileToDataUrl({ blob }: { blob: Blob }): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function findNodeInBranch({ items, targetId }: { items: MessageNode[], targetId: MessageId }): MessageNode | null {
  for (const item of items) {
    if (toRaw(item).id === targetId) return item;
    const found = findNodeInBranch({ items: item.replies.items, targetId });
    if (found) return found;
  }
  return null;
}

export function findParentInBranch({ items, childId }: { items: MessageNode[], childId: MessageId }): MessageNode | null {
  for (const item of items) {
    if (toRaw(item).replies.items.some(child => toRaw(child).id === childId)) return item;
    const found = findParentInBranch({ items: item.replies.items, childId });
    if (found) return found;
  }
  return null;
}

export function* getChatBranchIterator({ chat }: { chat: Chat | Readonly<Chat> }): Generator<MessageNode> {
  const items = chat.root.items as MessageNode[];
  if (items.length === 0) return;

  const targetId = chat.currentLeafId;
  const path: MessageNode[] = [];

  function findPath({ nodes, target }: { nodes: MessageNode[], target: MessageId }): boolean {
    for (const node of nodes) {
      path.push(node);
      if (toRaw(node).id === target) return true;
      if (findPath({ nodes: node.replies.items, target })) return true;
      path.pop();
    }
    return false;
  }

  const found = targetId ? findPath({ nodes: items, target: targetId }) : false;

  if (!found) {
    // Fallback: follow the last reply of each node starting from the root
    path.length = 0;
    let curr = items[items.length - 1];
    while (curr) {
      path.push(curr);
      const replies = toRaw(curr).replies.items;
      curr = replies.length > 0 ? replies[replies.length - 1] : undefined;
    }
  }

  for (const node of path) {
    yield node;
  }
}


export function findDeepestLeaf({ node }: { node: MessageNode | Readonly<MessageNode> }): MessageNode {
  if (node.replies.items.length === 0) return node as MessageNode;
  return findDeepestLeaf({ node: node.replies.items[node.replies.items.length - 1]! });
}

/**
 * Retrieves all messages in the entire chat tree (all branches).
 */
export function getAllMessages({ chat }: { chat: Chat | Readonly<Chat> }): MessageNode[] {
  const all: MessageNode[] = [];
  const collect = ({ items }: { items: MessageNode[] }) => {
    for (const item of items) {
      all.push(item);
      collect({ items: item.replies.items });
    }
  };
  collect({ items: chat.root.items });
  return all;
}

export function processThinking({ node }: { node: MessageNode }) {
  if (node.content === undefined) return;
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const matches = [...node.content.matchAll(thinkRegex)];
  if (matches.length > 0) {
    const thoughts = matches.map(m => m[1]?.trim()).filter(Boolean).join('\n\n---\n\n');
    node.thinking = node.thinking ? `${node.thinking}\n\n---\n\n${thoughts}` : thoughts;
    node.content = node.content.replace(thinkRegex, '').trim();
  }
}

export function findRestorationIndex({ items, prevId, nextId }: { items: SidebarItem[], prevId: string | null, nextId: string | null }): number {
  if (items.length === 0) return 0;
  const prevIdx = prevId ? items.findIndex(item => item.id === prevId) : -1;
  if (prevIdx !== -1) return prevIdx + 1;
  const nextIdx = nextId ? items.findIndex(item => item.id === nextId) : -1;
  if (nextIdx !== -1) return nextIdx;
  return 0;
}

export interface HistoryItem {
  role: 'user' | 'assistant' | 'system',
  content: string,
  modelId?: string,
  thinking?: string,
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
  attachments?: import('@/01-models/types').Attachment[],
}

export function createBranchFromMessages({ messages }: { messages: HistoryItem[] }): MessageNode[] {
  const nodes: MessageNode[] = messages.map(m => {
    const common = {
      id: generateId<MessageId>(),
      content: m.content,
      timestamp: Date.now(),
      replies: { items: [] },
    };
    switch (m.role) {
    case 'user':
      return {
        ...common,
        role: 'user',
        attachments: m.attachments || [],
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: EMPTY_LM_PARAMETERS,
        toolCalls: undefined,
        results: undefined,
      } as UserMessageNode;
    case 'assistant':
      return {
        ...common,
        role: 'assistant',
        attachments: undefined,
        thinking: m.thinking,
        error: undefined,
        modelId: m.modelId,
        lmParameters: EMPTY_LM_PARAMETERS,
        toolCalls: undefined,
        results: undefined,
      } as AssistantMessageNode;
    case 'system':
      return {
        ...common,
        role: 'system',
        attachments: undefined,
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: undefined,
        toolCalls: undefined,
        results: undefined,
      } as SystemMessageNode;
    default: {
      const _ex: never = m.role;
      throw new Error(`Unhandled role: ${_ex}`);
    }
    }
  });

  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i]!.replies.items.push(nodes[i + 1]!);
  }

  return nodes;
}
