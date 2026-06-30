import type { MessageNode } from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';
import { findParentInBranch } from '@/logic/chat-tree';

export function getSiblingsInChatBranch({
  root,
  messageId,
}: {
    root: {
      items: MessageNode[],
    },
  messageId: MessageId,
}): readonly MessageNode[] {
  const parent = findParentInBranch({
    items: root.items,
    childId: messageId,
  });
  return parent ? parent.replies.items : root.items;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
