import type { MessageNode, UserMessageNode } from '@/01-models/types';

/** Visits attachment parts in every branch without copying the mutable attachments. */
export function* iterateAttachmentParts({ nodes }: {
  nodes: readonly MessageNode[],
}): Generator<Extract<UserMessageNode['parts'][number], { type: 'attachment' }>> {
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    switch (node.role) {
    case 'user':
      for (const part of node.parts) {
        switch (part.type) {
        case 'attachment': yield part; break;
        case 'text': break;
        default: {
          const _ex: never = part;
          throw new Error(`Unhandled user part: ${_ex}`);
        }
        }
      }
      break;
    case 'assistant':
    case 'system':
    case 'tool':
      break;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled message: ${_ex}`);
    }
    }
    for (let index = node.replies.items.length - 1; index >= 0; index--) {
      const child = node.replies.items[index];
      if (child) pending.push(child);
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
