import type { Chat, MessageNode } from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';

export function renderLeafMetadataJson({
  chat,
  leafId,
  nodes,
}: {
  chat: Chat,
  leafId: MessageId,
  nodes: MessageNode[],
}): string {
  return JSON.stringify({
    chatId: chat.id,
    leafId,
    isCurrentLeaf: chat.currentLeafId === leafId,
    messageCount: nodes.length,
    messageIds: nodes.map(({ id }) => id),
    roles: nodes.map(({ role }) => role),
    currentLeafId: chat.currentLeafId,
  }, null, 2);
}
