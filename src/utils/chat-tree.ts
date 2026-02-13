import { generateId } from './id';
import { toRaw } from 'vue';
import type { MessageNode, SidebarItem, Chat } from '../models/types';

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

export function getChatBranch(chat: Chat | Readonly<Chat>): MessageNode[] {
  if (chat.root.items.length === 0) return [];
  const path: MessageNode[] = [];
  const targetId = chat.currentLeafId;
  const items = chat.root.items as MessageNode[];
  let curr: MessageNode | null = items.find(item => 
    toRaw(item).id === targetId || findNodeInBranch(item.replies.items, targetId || ''),
  ) || (items[items.length - 1] as MessageNode) || null;

  while (curr) {
    path.push(curr);
    if (toRaw(curr).id === targetId) break;
    const next: MessageNode | undefined = curr.replies.items.find(item => 
      toRaw(item).id === targetId || findNodeInBranch(item.replies.items, targetId || ''),
    ) || curr.replies.items[curr.replies.items.length - 1];
    curr = next || null;
  }
  return path;
}

export function findDeepestLeaf(node: MessageNode | Readonly<MessageNode>): MessageNode {
  if (node.replies.items.length === 0) return node as MessageNode;
  return findDeepestLeaf(node.replies.items[node.replies.items.length - 1]!);
}

export function processThinking(node: MessageNode) {
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
  const nodes: MessageNode[] = messages.map(m => ({
    id: generateId(),
    role: m.role,
    content: m.content,
    timestamp: Date.now(),
    modelId: m.modelId,
    thinking: m.thinking,
    attachments: m.attachments,
    replies: { items: [] },
  }));

  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i]!.replies.items.push(nodes[i + 1]!);
  }

  return nodes;
}
