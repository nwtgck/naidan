import type {
  ChatContent,
  ChatMessage,
  MultimodalContent,
  ToolMessageNode,
  UserMessageNode,
} from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';
import { getChatBranchIterator } from '@/logic/chat-tree';

/**
 * Projects Naidan chat history into the exact ChatMessage shape passed to LM providers.
 * Storage/blob access stays with the caller so this projection remains reusable by
 * production Chat and deterministic investigation fixtures.
 */
export async function buildChatGenerationMessages({
  chat,
  excludedMessageId,
  systemPromptMessages,
  resolveUserContent,
  resolveToolResultText,
}: {
  chat: ChatContent | Readonly<ChatContent>,
  excludedMessageId: MessageId | undefined,
  systemPromptMessages: string[],
  resolveUserContent: ({ message }: { message: UserMessageNode }) => Promise<string | MultimodalContent[]>,
  resolveToolResultText: ({ result }: { result: ToolMessageNode['results'][number] }) => Promise<string>,
}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  systemPromptMessages.forEach((content) => {
    messages.push({ role: 'system', content });
  });

  const history = Array.from(getChatBranchIterator({ chat })).filter(message => message.id !== excludedMessageId);
  for (const message of history) {
    switch (message.role) {
    case 'tool':
      for (const result of message.results) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: await resolveToolResultText({ result }),
        });
      }
      break;
    case 'user': {
      const content = await resolveUserContent({ message });
      if (typeof content === 'string') {
        messages.push({
          role: message.role,
          content,
          tool_calls: undefined,
        });
      } else {
        messages.push({ role: message.role, content });
      }
      break;
    }
    case 'assistant':
      messages.push({
        role: message.role,
        content: message.content || '',
        tool_calls: message.toolCalls,
      });
      break;
    case 'system':
      messages.push({
        role: message.role,
        content: message.content || '',
        tool_calls: undefined,
      });
      break;
    default: {
      const _ex: never = message;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  }

  return messages;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
