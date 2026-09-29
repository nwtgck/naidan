import { generateId } from '@/01-models/id';
import { toRaw } from 'vue';
import type { MessageNode, SidebarItem, Chat, ChatContent } from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';
import { copyMessageWithoutReplies } from '@/logic/copy-message-node';

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

export function* getChatBranchIterator({ chat }: { chat: ChatContent | Readonly<ChatContent> }): Generator<MessageNode> {
  const items = chat.root.items as MessageNode[];
  if (items.length === 0) return;

  const targetId = chat.currentLeafId;
  const path: MessageNode[] = [];
  let targetNode: MessageNode | undefined;

  if (targetId !== undefined) {
    const parents = new Map<MessageNode, MessageNode | undefined>();
    const stack: Array<{ node: MessageNode, parent: MessageNode | undefined }> = [];
    for (let index = items.length - 1; index >= 0; index--) {
      const node = items[index];
      if (node !== undefined) stack.push({ node, parent: undefined });
    }

    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) continue;

      parents.set(entry.node, entry.parent);
      if (toRaw(entry.node).id === targetId) {
        targetNode = entry.node;
        break;
      }

      const replies = entry.node.replies.items;
      for (let index = replies.length - 1; index >= 0; index--) {
        const reply = replies[index];
        if (reply !== undefined) stack.push({ node: reply, parent: entry.node });
      }
    }

    for (let node = targetNode; node !== undefined; node = parents.get(node)) {
      path.push(node);
    }
    path.reverse();
  }

  if (targetNode === undefined) {
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

function findRestorationIndex({ items, prevId, nextId }: { items: SidebarItem[], prevId: string | null, nextId: string | null }): number {
  if (items.length === 0) return 0;
  const prevIdx = prevId ? items.findIndex(item => item.id === prevId) : -1;
  if (prevIdx !== -1) return prevIdx + 1;
  const nextIdx = nextId ? items.findIndex(item => item.id === nextId) : -1;
  if (nextIdx !== -1) return nextIdx;
  return 0;
}

/** Create an independent chain without flattening parts or importing other branches. */
export function createBranchFromMessages({ messages }: { messages: readonly MessageNode[] }): MessageNode[] {
  const nodes = messages.map(message => ({
    ...copyMessageWithoutReplies({ message }),
    id: generateId<MessageId>(),
  }));
  for (let index = 0; index < nodes.length - 1; index++) {
    nodes[index]!.replies.items.push(nodes[index + 1]!);
  }
  return nodes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  findRestorationIndex,
};
