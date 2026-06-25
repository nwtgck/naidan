import type { MessageNode } from '@/models/types';
import type { MessageId } from '@/models/ids';
import { findParentInBranch } from '@/utils/chat-tree';

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
