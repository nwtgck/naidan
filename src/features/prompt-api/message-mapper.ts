import type { ChatMessage } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import { PromptApiError } from './errors';
import type { PromptApiInputMode, PromptApiMessage, PromptApiMessageContent, PromptApiPrompt } from './language-model';

export type PromptApiMappedConversation = {
  initialPrompts: PromptApiMessage[],
  prompt: PromptApiPrompt,
  inputMode: PromptApiInputMode,
};

function unsupported({ message }: { message: string }): never {
  throw new PromptApiError({ code: 'unsupported_input', message });
}

/** Project only content this browser API can represent; never reclassify literal tags. */
export async function mapChatMessagesToPromptApi({ messages, readBinaryObject, signal }: {
  messages: readonly ChatMessage[],
  readBinaryObject: Parameters<LmProvider['chat']>[0]['readBinaryObject'],
  signal: AbortSignal | undefined,
}): Promise<PromptApiMappedConversation> {
  signal?.throwIfAborted();
  if (messages.length === 0) return unsupported({ message: 'Prompt API requires at least one message.' });
  const systemContents: string[] = [];
  const conversation: PromptApiMessage[] = [];
  let inputMode: PromptApiInputMode = 'text';
  for (const message of messages) {
    signal?.throwIfAborted();
    const { id: _id, role: _role, parts: _parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    switch (message.role) {
    case 'system':
      if (conversation.length) return unsupported({ message: 'Prompt API system messages must precede the conversation.' });
      systemContents.push(message.parts.map(part => part.text).join(''));
      break;
    case 'user': {
      const content: PromptApiMessageContent[] = [];
      for (const part of message.parts) {
        switch (part.type) {
        case 'text':
          content.push({ type: 'text', value: part.text });
          break;
        case 'attachment': {
          const attachment = part.attachment;
          if (!attachment.mimeType.startsWith('image/')) {
            return unsupported({ message: `Prompt API requires an image attachment: ${attachment.originalName}` });
          }
          let blob: Blob;
          switch (attachment.status) {
          case 'memory': blob = attachment.blob; break;
          case 'persisted':
            if (!readBinaryObject) return unsupported({ message: 'Prompt API requires a binary reader for persisted images.' });
            blob = await readBinaryObject({ binaryObjectId: attachment.binaryObjectId, signal });
            break;
          case 'missing': return unsupported({ message: `Prompt API image attachment is missing: ${attachment.originalName}` });
          default: { const _ex: never = attachment; throw new Error(`Unhandled attachment: ${_ex}`); }
          }
          signal?.throwIfAborted();
          // Metadata is authoritative; a stored Blob can have an empty MIME type.
          content.push({ type: 'image', value: blob.slice(0, blob.size, attachment.mimeType) });
          inputMode = 'image';
          break;
        }
        default: { const _ex: never = part; throw new Error(`Unhandled user part: ${_ex}`); }
        }
      }
      const hasImage = content.some(part => part.type === 'image');
      conversation.push({ role: 'user', content: hasImage ? content : content.map(part => {
        switch (part.type) {
        case 'text': return part.value;
        case 'image': throw new Error('Expected text-only content.');
        default: { const _ex: never = part; throw new Error(`Unhandled content: ${_ex}`); }
        }
      }).join('') });
      break;
    }
    case 'assistant': {
      const content: string[] = [];
      for (const part of message.parts) {
        switch (part.type) {
        case 'text': content.push(part.text); break;
        case 'reasoning': return unsupported({ message: 'Prompt API structured reasoning history is not supported yet.' });
        case 'tool_call': return unsupported({ message: 'Prompt API tool history is not supported yet.' });
        default: { const _ex: never = part; throw new Error(`Unhandled assistant part: ${_ex}`); }
        }
      }
      conversation.push({ role: 'assistant', content: content.join('') });
      break;
    }
    case 'tool': return unsupported({ message: 'Prompt API tool history is not supported yet.' });
    default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
    }
  }
  const final = conversation.at(-1);
  if (!final) return unsupported({ message: 'Prompt API requires the final message to be from the user.' });
  switch (final.role) {
  case 'user': break;
  case 'system':
  case 'assistant': return unsupported({ message: 'Prompt API requires the final message to be from the user.' });
  default: { const _ex: never = final.role; throw new Error(`Unhandled final role: ${_ex}`); }
  }
  const initialPrompts: PromptApiMessage[] = [];
  if (systemContents.length) initialPrompts.push({ role: 'system', content: systemContents.join('\n\n') });
  initialPrompts.push(...conversation.slice(0, -1));
  signal?.throwIfAborted();
  return { initialPrompts, prompt: typeof final.content === 'string' ? final.content : [final], inputMode };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
