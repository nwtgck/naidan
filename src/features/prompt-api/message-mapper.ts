import type { ChatMessage } from '@/01-models/types';

import { PromptApiError } from './errors';
import type { PromptApiMessage } from './language-model';

export type PromptApiMappedConversation = {
  initialPrompts: PromptApiMessage[],
  prompt: string,
};

function unsupported({ message }: { message: string }): never {
  throw new PromptApiError({
    code: 'unsupported_input',
    message,
  });
}

export function mapChatMessagesToPromptApi({
  messages,
}: {
  messages: ChatMessage[],
}): PromptApiMappedConversation {
  if (messages.length === 0) {
    return unsupported({ message: 'Prompt API requires at least one message.' });
  }

  const systemContents: string[] = [];
  const conversation: PromptApiMessage[] = [];
  let encounteredConversationMessage = false;

  for (const message of messages) {
    if (typeof message.content !== 'string') {
      return unsupported({ message: 'Prompt API multimodal input is not supported yet.' });
    }
    if ((message.tool_calls?.length ?? 0) > 0 || message.tool_call_id !== undefined) {
      return unsupported({ message: 'Prompt API tool history is not supported yet.' });
    }

    switch (message.role) {
    case 'system':
      if (encounteredConversationMessage) {
        return unsupported({ message: 'Prompt API system messages must precede the conversation.' });
      }
      systemContents.push(message.content);
      break;
    case 'user':
    case 'assistant':
      encounteredConversationMessage = true;
      conversation.push({
        role: message.role,
        content: message.content,
      });
      break;
    case 'tool':
      return unsupported({ message: 'Prompt API tool history is not supported yet.' });
    default:
      return unsupported({ message: `Prompt API does not support role: ${message.role}` });
    }
  }

  const finalMessage = conversation.at(-1);
  if (finalMessage === undefined) {
    return unsupported({ message: 'Prompt API requires the final message to be from the user.' });
  }

  switch (finalMessage.role) {
  case 'user':
    break;
  case 'assistant':
  case 'system':
    return unsupported({ message: 'Prompt API requires the final message to be from the user.' });
  default: {
    const _ex: never = finalMessage.role;
    throw new Error(`Unhandled Prompt API role: ${_ex}`);
  }
  }

  const initialPrompts: PromptApiMessage[] = [];
  if (systemContents.length > 0) {
    initialPrompts.push({
      role: 'system',
      content: systemContents.join('\n\n'),
    });
  }
  initialPrompts.push(...conversation.slice(0, -1));

  return {
    initialPrompts,
    prompt: finalMessage.content,
  };
}

export const TEST_ONLY = {};
