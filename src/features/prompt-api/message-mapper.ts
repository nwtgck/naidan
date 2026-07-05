import type { ChatMessage, MultimodalContent } from '@/01-models/types';

import { PromptApiError } from './errors';
import type {
  PromptApiInputMode,
  PromptApiMessage,
  PromptApiMessageContent,
  PromptApiPrompt,
} from './language-model';

export type PromptApiMappedConversation = {
  initialPrompts: PromptApiMessage[],
  prompt: PromptApiPrompt,
  inputMode: PromptApiInputMode,
};

function unsupported({ message }: { message: string }): never {
  throw new PromptApiError({
    code: 'unsupported_input',
    message,
  });
}

function imageDataUrlToBlob({ url }: { url: string }): Blob {
  if (!url.startsWith('data:')) {
    return unsupported({
      message: 'Prompt API image input requires an embedded data URL.',
    });
  }

  const separatorIndex = url.indexOf(',');
  if (separatorIndex < 0) {
    return unsupported({ message: 'Prompt API image data URL is invalid.' });
  }

  const metadata = url.slice('data:'.length, separatorIndex).split(';');
  const mimeType = metadata[0] ?? '';
  if (!mimeType.startsWith('image/')) {
    return unsupported({
      message: `Prompt API image input requires an image MIME type: ${mimeType || '(missing)'}`,
    });
  }
  if (!metadata.includes('base64')) {
    return unsupported({
      message: 'Prompt API image input requires a base64-encoded data URL.',
    });
  }

  let binary: string;
  try {
    binary = atob(url.slice(separatorIndex + 1));
  } catch (error) {
    throw new PromptApiError({
      code: 'unsupported_input',
      message: 'Prompt API image data URL contains invalid base64 data.',
      cause: error,
    });
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function mapUserContent({ content }: {
  content: string | MultimodalContent[],
}): {
  content: string | PromptApiMessageContent[],
  inputMode: PromptApiInputMode,
} {
  if (typeof content === 'string') {
    return {
      content,
      inputMode: 'text',
    };
  }

  const mapped: PromptApiMessageContent[] = [];
  let inputMode: PromptApiInputMode = 'text';

  for (const part of content) {
    switch (part.type) {
    case 'text':
      mapped.push({ type: 'text', value: part.text });
      break;
    case 'image_url':
      mapped.push({
        type: 'image',
        value: imageDataUrlToBlob({ url: part.image_url.url }),
      });
      inputMode = 'image';
      break;
    default: {
      const _ex: never = part;
      throw new Error(`Unhandled multimodal content type: ${String(_ex)}`);
    }
    }
  }

  return {
    content: mapped,
    inputMode,
  };
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
  let inputMode: PromptApiInputMode = 'text';

  for (const message of messages) {
    if ((message.tool_calls?.length ?? 0) > 0 || message.tool_call_id !== undefined) {
      return unsupported({ message: 'Prompt API tool history is not supported yet.' });
    }

    switch (message.role) {
    case 'system':
      if (encounteredConversationMessage) {
        return unsupported({ message: 'Prompt API system messages must precede the conversation.' });
      }
      if (typeof message.content !== 'string') {
        return unsupported({ message: 'Prompt API system messages must contain text only.' });
      }
      systemContents.push(message.content);
      break;
    case 'user': {
      encounteredConversationMessage = true;
      const mapped = mapUserContent({ content: message.content });
      conversation.push({
        role: 'user',
        content: mapped.content,
      });
      switch (mapped.inputMode) {
      case 'text':
        break;
      case 'image':
        inputMode = 'image';
        break;
      default: {
        const _ex: never = mapped.inputMode;
        throw new Error(`Unhandled Prompt API input mode: ${_ex}`);
      }
      }
      break;
    }
    case 'assistant':
      encounteredConversationMessage = true;
      if (typeof message.content !== 'string') {
        return unsupported({ message: 'Prompt API assistant messages must contain text only.' });
      }
      conversation.push({
        role: 'assistant',
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
    prompt: typeof finalMessage.content === 'string'
      ? finalMessage.content
      : [finalMessage],
    inputMode,
  };
}

export const TEST_ONLY = {
};
