import type { Chat, MessageNode } from '@/models/types'

export function renderLeafMetadataMarkdown({
  chat,
  leafId,
  nodes,
}: {
  chat: Chat;
  leafId: string;
  nodes: MessageNode[];
}): string {
  return `# Leaf Metadata

chatId: ${chat.id}
leafId: ${leafId}
isCurrentLeaf: ${chat.currentLeafId === leafId}
messageCount: ${nodes.length}
messageIds:
${nodes.map(({ id }) => `- ${id}`).join('\n')}
roles:
${nodes.map(({ role }) => `- ${role}`).join('\n')}
currentLeafId: ${chat.currentLeafId ?? 'undefined'}
`
}
