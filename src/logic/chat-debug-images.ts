import type { MessageNode } from '@/01-models/types';
import { GeneratedImageBlockSchema, IMAGE_BLOCK_LANG } from '@/utils/image-generation';
import type { GeneratedImageBlock } from '@/utils/image-generation';
import { getMessagePartDisplayKey } from './message-part-display-key';

/** Inspect body parts independently: a debug projection must not invent image blocks. */
export function inspectDebugImages({ message }: { message: Readonly<MessageNode> }): {
  images: { key: string; image: GeneratedImageBlock }[];
  errors: string[];
} {
  const images: { key: string; image: GeneratedImageBlock }[] = [];
  const errors: string[] = [];
  for (const part of message.parts) {
    switch (part.type) {
    case 'text': {
      const pattern = new RegExp('```' + IMAGE_BLOCK_LANG + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g');
      let occurrence = 0;
      for (const match of part.text.matchAll(pattern)) {
        const key = JSON.stringify([getMessagePartDisplayKey({ part }), occurrence++]);
        try {
          const result = GeneratedImageBlockSchema.safeParse(JSON.parse(match[1] ?? ''));
          if (result.success) images.push({ key, image: result.data });
          else errors.push(result.error.message);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      break;
    }
    case 'reasoning':
    case 'attachment':
    case 'tool_call':
    case 'tool_result': break;
    default: {
      const unhandled: never = part;
      throw new Error(`Unhandled debug part: ${unhandled}`);
    }
    }
  }
  return { images, errors };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
