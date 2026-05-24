import type { Chat, MessageNode } from '@/models/types'

export function renderLeafMetadataJson({
  chat,
  leafId,
  nodes,
}: {
  chat: Chat;
  leafId: string;
  nodes: MessageNode[];
}): string {
  return JSON.stringify({
    chatId: chat.id,
    leafId,
    isCurrentLeaf: chat.currentLeafId === leafId,
    messageCount: nodes.length,
    messageIds: nodes.map(({ id }) => id),
    roles: nodes.map(({ role }) => role),
    currentLeafId: chat.currentLeafId,
  }, null, 2)
}
