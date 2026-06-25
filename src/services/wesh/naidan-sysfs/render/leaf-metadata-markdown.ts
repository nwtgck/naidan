import { idToRaw } from '@/models/ids';
import type { Chat, MessageNode } from '@/models/types';
import type { MessageId } from '@/models/ids';

export function renderLeafMetadataMarkdown({
  chat,
  leafId,
  nodes,
}: {
  chat: Chat,
  leafId: MessageId,
  nodes: MessageNode[],
}): string {
  return `# Leaf Metadata

chatId: ${idToRaw({ id: chat.id })}
leafId: ${idToRaw({ id: leafId })}
isCurrentLeaf: ${chat.currentLeafId === leafId}
messageCount: ${nodes.length}
messageIds:
${nodes.map(({ id }) => `- ${idToRaw({ id })}`).join('\n')}
roles:
${nodes.map(({ role }) => `- ${role}`).join('\n')}
currentLeafId: ${chat.currentLeafId === undefined ? 'undefined' : idToRaw({ id: chat.currentLeafId })}
`;
}
