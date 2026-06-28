/* eslint-disable no-restricted-imports -- Gemma 4 worker adapter intentionally depends on transformers.js runtime image utilities. */
import type { RawImage as TransformersRawImage, PreTrainedTokenizer } from '@huggingface/transformers';
import type { ChatMessage } from '@/01-models/types';

export type Gemma4TemplateContentPart =
  | { type: 'text', text: string }
  | { type: 'image' };

export interface Gemma4TemplateMessage {
  role: string,
  content: string | Gemma4TemplateContentPart[],
}

export interface Gemma4ProcessorLike {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callable mirrors the Transformers processor runtime signature.
  (
    text: string | string[],
    images: TransformersRawImage[] | TransformersRawImage | null,
    audio: Float32Array[] | Float32Array | null,
    options: Record<string, unknown>
  ): Promise<Record<string, unknown>>,
  tokenizer: PreTrainedTokenizer,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this method mirrors the Transformers tokenizer apply_chat_template signature.
  apply_chat_template(messages: Gemma4TemplateMessage[], options: Record<string, unknown>): string,
}

export function isGemma4Model({
  modelType,
  activeModelId,
}: {
  modelType: string | undefined,
  activeModelId: string | null,
}): boolean {
  if (modelType === 'gemma4') {
    return true;
  }

  const normalizedModelId = activeModelId?.toLowerCase();
  return normalizedModelId?.includes('gemma-4') === true || normalizedModelId?.includes('gemma4') === true;
}

export async function buildGemma4TemplateInput({
  messages,
}: {
  messages: ChatMessage[],
}): Promise<{
  images: TransformersRawImage[],
  templateMessages: Gemma4TemplateMessage[],
}> {
  const images: TransformersRawImage[] = [];
  const templateMessages: Gemma4TemplateMessage[] = [];

  for (const message of messages) {
    const normalizedRole = normalizeGemma4Role({ role: message.role });

    if (message.role === 'tool') {
      templateMessages.push({
        role: normalizedRole,
        content: `Tool result:\n${flattenGemma4MessageContent({ message })}`,
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      templateMessages.push({
        role: normalizedRole,
        content: buildGemma4AssistantToolSummary({ message }),
      });
      continue;
    }

    if (typeof message.content === 'string') {
      templateMessages.push({
        role: normalizedRole,
        content: message.content,
      });
      continue;
    }

    const contentParts: Gemma4TemplateContentPart[] = [];
    for (const part of message.content) {
      switch (part.type) {
      case 'text':
        contentParts.push({ type: 'text', text: part.text });
        break;
      case 'image_url':
        contentParts.push({ type: 'image' });
        images.push(await readGemma4Image({ url: part.image_url.url }));
        break;
      default: {
        const exhaustive: never = part;
        throw new Error(`Unhandled Gemma 4 multimodal part: ${String(exhaustive)}`);
      }
      }
    }

    templateMessages.push({
      role: normalizedRole,
      content: contentParts.length > 0 ? contentParts : '',
    });
  }

  return {
    images,
    templateMessages,
  };
}

function normalizeGemma4Role({
  role,
}: {
  role: string,
}): string {
  switch (role) {
  case 'developer':
    return 'system';
  case 'tool':
    return 'user';
  default:
    return role;
  }
}

function buildGemma4AssistantToolSummary({
  message,
}: {
  message: ChatMessage,
}): string {
  const sections: string[] = [];
  const visibleContent = flattenGemma4MessageContent({ message });
  if (visibleContent.length > 0) {
    sections.push(visibleContent);
  }

  for (const toolCall of message.tool_calls ?? []) {
    sections.push(`Tool call: ${JSON.stringify({
      name: toolCall.function.name,
      arguments: parseGemma4ToolArguments({ argumentsText: toolCall.function.arguments }),
    })}`);
  }

  return sections.join('\n\n');
}

function flattenGemma4MessageContent({
  message,
}: {
  message: ChatMessage,
}): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .map(part => {
      switch (part.type) {
      case 'text':
        return part.text;
      case 'image_url':
        return '[Image]';
      default: {
        const exhaustive: never = part;
        throw new Error(`Unhandled Gemma 4 content part: ${String(exhaustive)}`);
      }
      }
    })
    .join('\n');
}

function parseGemma4ToolArguments({
  argumentsText,
}: {
  argumentsText: string,
}): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readGemma4Image({
  url,
}: {
  url: string,
}): Promise<TransformersRawImage> {
  const { RawImage } = await import('@huggingface/transformers');

  if (url.startsWith('data:')) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to read Gemma 4 image data URL: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    return RawImage.read(blob);
  }

  return RawImage.read(url);
}
