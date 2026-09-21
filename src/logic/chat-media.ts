import type { MessageNode } from '@/01-models/types';
import { idToRaw, toBinaryObjectId } from '@/01-models/ids';
import type { BinaryObjectId, MessageId } from '@/01-models/ids';
import { getMessageText } from '@/01-models/message-text';
import { GeneratedImageBlockSchema, IMAGE_BLOCK_LANG, stripNaidanSentinels } from '@/utils/image-generation';

export interface ChatMediaItem {
  id: string,
  messageId: MessageId,
  binaryObjectId: BinaryObjectId,
  mimeType: string,
  size: number,
  name: string | undefined,
  prompt: string | undefined,
  steps: number | undefined,
  seed: number | undefined,
  model: string | undefined,
  width: number | undefined,
  height: number | undefined,
  memoryBlob: Blob | undefined,
  index: number,
  total: number,
}
export interface ChatMediaGroup {
  messageId: MessageId,
  prompt: string | undefined,
  items: ChatMediaItem[],
  createdAt: number,
}

/** A read-only shelf projection, never a source for rewriting stored parts. */
export function collectChatMedia({ messages, order }: {
  messages: readonly MessageNode[],
  order: 'forward' | 'reverse',
}): ChatMediaGroup[] {
  const groups: ChatMediaGroup[] = [];
  for (const message of messages) {
    const items: ChatMediaItem[] = [];
    let sharedPrompt: string | undefined;
    for (const part of message.parts) {
      switch (part.type) {
      case 'attachment': {
        const attachment = part.attachment;
        if (!attachment.mimeType.startsWith('image/')) break;
        let memoryBlob: Blob | undefined;
        switch (attachment.status) {
        case 'missing': continue;
        case 'persisted': memoryBlob = undefined; break;
        case 'memory': memoryBlob = attachment.blob; break;
        default: {
          const unhandled: never = attachment;
          throw new Error(`Unhandled media attachment: ${unhandled}`);
        }
        }
        items.push({
          id: JSON.stringify([idToRaw({ id: message.id }), part.id]), messageId: message.id,
          binaryObjectId: attachment.binaryObjectId, mimeType: attachment.mimeType, size: attachment.size,
          name: attachment.originalName, prompt: undefined, steps: undefined, seed: undefined,
          model: undefined, width: undefined, height: undefined, memoryBlob, index: 0, total: 0,
        });
        break;
      }
      case 'text': {
        // Only complete metadata blocks in this body part can describe an image.
        // Never manufacture a block by concatenating different parts or reasoning.
        const blocks = new RegExp('```' + IMAGE_BLOCK_LANG + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g');
        let occurrence = 0;
        for (const match of part.text.matchAll(blocks)) {
          const blockIndex = occurrence++;
          try {
            const parsed = GeneratedImageBlockSchema.safeParse(JSON.parse(match[1] ?? ''));
            if (!parsed.success) continue;
            const data = parsed.data;
            if (!sharedPrompt) sharedPrompt = data.prompt;
            items.push({
              id: JSON.stringify([idToRaw({ id: message.id }), part.id, blockIndex]), messageId: message.id,
              binaryObjectId: toBinaryObjectId({ raw: data.binaryObjectId }), mimeType: 'image/png', size: 0,
              name: undefined, prompt: data.prompt, steps: data.steps, seed: data.seed,
              model: message.modelId, width: data.width, height: data.height, memoryBlob: undefined, index: 0, total: 0,
            });
          } catch {
            // Incomplete or invalid experimental blocks stay in the original text.
          }
        }
        break;
      }
      case 'reasoning':
      case 'tool_call':
      case 'tool_result': break;
      default: {
        const unhandled: never = part;
        throw new Error(`Unhandled media part: ${unhandled}`);
      }
      }
    }
    if (items.length === 0) continue;
    if (!sharedPrompt) sharedPrompt = stripNaidanSentinels({ content: getMessageText({ message }) }).trim().slice(0, 100);
    items.forEach((item, index) => {
      item.index = index + 1; item.total = items.length;
    });
    switch (order) {
    case 'forward': break;
    case 'reverse': items.reverse(); break;
    default: {
      const unhandled: never = order;
      throw new Error(`Unhandled media order: ${unhandled}`);
    }
    }
    groups.push({ messageId: message.id, prompt: sharedPrompt || undefined, items, createdAt: message.createdAt });
  }
  return groups.sort((left, right) => right.createdAt - left.createdAt);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
