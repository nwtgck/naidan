import { generateId } from './id';
import { toRaw } from 'vue';
import type { MessageNode, AssistantMessageNode, UserMessageNode, SystemMessageNode, SidebarItem, Chat } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';

export function fileToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function findNodeInBranch(items: MessageNode[], targetId: string): MessageNode | null {
  for (const item of items) {
    if (toRaw(item).id === targetId) return item;
    const found = findNodeInBranch(item.replies.items, targetId);
    if (found) return found;
  }
  return null;
}

export function findParentInBranch(items: MessageNode[], childId: string): MessageNode | null {
  for (const item of items) {
    if (toRaw(item).replies.items.some(child => toRaw(child).id === childId)) return item;
    const found = findParentInBranch(item.replies.items, childId);
    if (found) return found;
  }
  return null;
}

export function* getChatBranchIterator({ chat }: { chat: Chat | Readonly<Chat> }): Generator<MessageNode> {
  const items = chat.root.items as MessageNode[];
  if (items.length === 0) return;

  const targetId = chat.currentLeafId;
  const path: MessageNode[] = [];

  function findPath(nodes: MessageNode[], target: string): boolean {
    for (const node of nodes) {
      path.push(node);
      if (toRaw(node).id === target) return true;
      if (findPath(node.replies.items, target)) return true;
      path.pop();
    }
    return false;
  }

  const found = targetId ? findPath(items, targetId) : false;

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


export function findDeepestLeaf(node: MessageNode | Readonly<MessageNode>): MessageNode {
  if (node.replies.items.length === 0) return node as MessageNode;
  return findDeepestLeaf(node.replies.items[node.replies.items.length - 1]!);
}

/**
 * Retrieves all messages in the entire chat tree (all branches).
 */
export function getAllMessages(chat: Chat | Readonly<Chat>): MessageNode[] {
  const all: MessageNode[] = [];
  const collect = (items: MessageNode[]) => {
    for (const item of items) {
      all.push(item);
      collect(item.replies.items);
    }
  };
  collect(chat.root.items);
  return all;
}

export function processThinking(node: MessageNode) {
  if (node.content === undefined) return;
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const matches = [...node.content.matchAll(thinkRegex)];
  if (matches.length > 0) {
    const thoughts = matches.map(m => m[1]?.trim()).filter(Boolean).join('\n\n---\n\n');
    node.thinking = node.thinking ? `${node.thinking}\n\n---\n\n${thoughts}` : thoughts;
    node.content = node.content.replace(thinkRegex, '').trim();
  }
}

export function findRestorationIndex(items: SidebarItem[], prevId: string | null, nextId: string | null): number {
  if (items.length === 0) return 0;
  const prevIdx = prevId ? items.findIndex(item => item.id === prevId) : -1;
  if (prevIdx !== -1) return prevIdx + 1;
  const nextIdx = nextId ? items.findIndex(item => item.id === nextId) : -1;
  if (nextIdx !== -1) return nextIdx;
  return 0;
}

export interface HistoryItem {
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelId?: string;
  thinking?: string;
  attachments?: import('../models/types').Attachment[];
}

export function createBranchFromMessages(messages: HistoryItem[]): MessageNode[] {
  const nodes: MessageNode[] = messages.map(m => {
    const common = {
      id: generateId(),
      content: m.content,
      timestamp: Date.now(),
      replies: { items: [] }
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
