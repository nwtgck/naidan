import { UnsupportedReasoningError } from '@/01-models/lm-errors';
import { z } from 'zod';
import { peerChatTranscriptSchema as transcriptSchema, peerChatEventSchema as eventSchema } from '@/features/naidan-rpc-integration/contract';
import type { GenerationResult } from '@/features/llama-cpp-browser/types';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { bytesSource, collectBytes, decodeDocument, encodeDocument, assertDocumentBounds } from '@/features/naidan-rpc-integration/codecs/transfer';

export const TRANSCRIPT_LIMIT = 8 * 1024 * 1024;
export const EVENT_LIMIT = 8 * 1024 * 1024;
export const OUTPUT_LIMIT = 32 * 1024 * 1024;
export type Transcript = z.infer<typeof transcriptSchema>;
export type ImageUpload = { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; byteLength: number; data: ReadableStream<Uint8Array> };

export function prepareTranscript({ input }: { input: Parameters<LlamaCppBrowserService['generate']>[0]['input'] }): {
  transcript: ReadableStream<Uint8Array>; images: ImageUpload[];
} {
  const { messages, model: _model, debug: _debug, tools, reasoningEffort, temperature, topP, maxTokens,
    presencePenalty, frequencyPenalty, stop, ...rest } = input;
  rest satisfies Record<PropertyKey, never>;
  const images: ImageUpload[] = []; let imageBytes = 0;
  const projected = messages.map(message => {
    const { content, role, reasoning_content, tool_calls, tool_call_id, name, ...rest } = message;
    rest satisfies Record<PropertyKey, never>;
    const body = typeof content === 'string' ? content : content.map(part => {
      switch (part.type) {
      case 'text': return { type: 'text' as const, text: part.text };
      case 'image': {
        const blob = part.blob;
        const mimeType = z.enum(['image/png', 'image/jpeg', 'image/webp']).parse(blob.type);
        if (blob.size === 0 || blob.size > 16 * 1024 * 1024 || images.length >= 8 || (imageBytes += blob.size) > 64 * 1024 * 1024) throw new Error('Remote chat attachment limit exceeded');
        const attachment = images.length; images.push({ mimeType, byteLength: blob.size, data: blob.stream() });
        return { type: 'image' as const, attachment };
      }
      default: { const unreachable: never = part; throw new Error(String(unreachable)); }
      }
    });
    return { role, content: body, reasoning_content, tool_calls, tool_call_id, name };
  });
  const document = {
    messages: projected,
    tools,
    reasoningEffort,
    temperature,
    topP,
    maxTokens: maxTokens ?? 4096,
    presencePenalty,
    frequencyPenalty,
    stop,
  };
  // Tool schemas also originate in local/imported settings. Bound their shape
  // before recursive validation, rather than relying on the serializer later.
  assertDocumentBounds({ value: document });
  const value = transcriptSchema.parse(document);
  return { transcript: bytesSource({ bytes: encodeDocument({ value, limit: TRANSCRIPT_LIMIT }) }), images };
}

export async function receiveTranscript({ transcript, images, model, signal }: {
  transcript: ReadableStream<Uint8Array>; images: readonly ImageUpload[]; model: string; signal: AbortSignal;
}): Promise<Parameters<LlamaCppBrowserService['generate']>[0]['input']> {
  if (images.length > 8 || images.reduce((sum, image) => sum + image.byteLength, 0) > 64 * 1024 * 1024) throw new Error('Remote chat attachment limit exceeded');
  const value = transcriptSchema.parse(decodeDocument({ bytes: await collectBytes({ readable: transcript, limit: TRANSCRIPT_LIMIT, signal }) }));
  // Reject impossible references before accepting bytes from any attachment.
  // The transport owns cancellation of the remaining, unconsumed input streams.
  for (const message of value.messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'image' && part.attachment >= images.length) throw new Error('Missing remote attachment');
    }
  }
  const blobs: Blob[] = [];
  for (const image of images) {
    const bytes = await collectBytes({ readable: image.data, limit: image.byteLength, signal });
    if (bytes.length !== image.byteLength) throw new Error('Remote attachment length mismatch');
    blobs.push(new Blob([bytes], { type: image.mimeType }));
  }
  const { messages, tools, reasoningEffort, temperature, topP, maxTokens, presencePenalty, frequencyPenalty, stop, ...rest } = value;
  rest satisfies Record<PropertyKey, never>;
  return {
    model,
    debug: 'off',
    tools,
    reasoningEffort,
    temperature,
    topP,
    maxTokens,
    presencePenalty,
    frequencyPenalty,
    stop,
    messages: messages.map(message => {
      const { role, content, reasoning_content, tool_calls, tool_call_id, name, ...rest } = message;
      rest satisfies Record<PropertyKey, never>;
      return {
        role,
        reasoning_content,
        tool_calls,
        tool_call_id,
        name,
        content: typeof content === 'string' ? content : content.map(part => {
          switch (part.type) {
          case 'text': return { type: 'text' as const, text: part.text };
          case 'image': { const blob = blobs[part.attachment]; if (!blob) throw new Error('Missing remote attachment'); return { type: 'image' as const, blob }; }
          default: { const unreachable: never = part; throw new Error(String(unreachable)); }
          }
        }),
      };
    }),
  };
}

export function eventBytes({ event }: { event: z.infer<typeof eventSchema> }): Uint8Array<ArrayBuffer> {
  const body = encodeDocument({ value: eventSchema.parse(event), limit: EVENT_LIMIT });
  const bytes = new Uint8Array(body.length + 4); new DataView(bytes.buffer).setUint32(0, body.length, false); bytes.set(body, 4); return bytes;
}

export async function receiveEvents({ readable, onEvent, signal }: {
  readable: ReadableStream<Uint8Array>; onEvent: Parameters<LlamaCppBrowserService['generate']>[0]['onEvent']; signal: AbortSignal;
}): Promise<GenerationResult> {
  const reader = readable.getReader(); let current = new Uint8Array(), at = 0, total = 0;
  let cancellation: Promise<void> | undefined;
  const cancelReader = ({ reason }: { reason: unknown }): Promise<void> => {
    return cancellation ??= reader.cancel(reason).catch(() => {});
  };
  const cancel = () => {
    void cancelReader({ reason: signal.reason });
  };
  signal.addEventListener('abort', cancel, { once: true });
  const exact = async ({ size, allowEnd }: { size: number; allowEnd: boolean }): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    const out = new Uint8Array(size); let written = 0;
    while (written < size) {
      signal.throwIfAborted();
      if (at === current.length) {
        const chunk = await reader.read(); signal.throwIfAborted();
        if (chunk.done) {
          if (allowEnd && written === 0) return undefined; throw new Error('Truncated inference event');
        }
        current = new Uint8Array(chunk.value); at = 0;
        if ((total += current.length) > OUTPUT_LIMIT) throw new Error('Inference output limit exceeded');
      }
      const count = Math.min(size - written, current.length - at); out.set(current.subarray(at, at + count), written); at += count; written += count;
    }
    return out;
  };
  let content = '', reasoningContent = '', finishReason: GenerationResult['finishReason'] | undefined;
  const toolCalls: GenerationResult['toolCalls'] = [];
  try {
    for (;;) {
      const header = await exact({ size: 4, allowEnd: true }); if (!header) break;
      if (finishReason !== undefined) throw new Error('Events after remote completion');
      const size = new DataView(header.buffer).getUint32(0, false);
      if (size === 0 || size > EVENT_LIMIT) throw new Error('Invalid inference event length');
      const body = await exact({ size, allowEnd: false }); if (!body) throw new Error('Missing inference event');
      const event = eventSchema.parse(decodeDocument({ bytes: body }));
      switch (event.type) {
      case 'rejected': throw new UnsupportedReasoningError({ message: 'The remote model does not support the requested reasoning control.' });
      case 'finish': finishReason = event.reason; break;
      case 'text': content += event.text; await onEvent({ event }); break;
      case 'reasoning': reasoningContent += event.text; await onEvent({ event }); break;
      case 'tool_call': if (event.index !== toolCalls.length) throw new Error('Unordered remote tool result'); toolCalls.push(event.toolCall); await onEvent({ event }); break;
      case 'tool_call_start': case 'tool_call_draft': await onEvent({ event }); break;
      default: { const unreachable: never = event; throw new Error(String(unreachable)); }
      }
    }
    if (finishReason === undefined) throw new Error('Remote inference ended without completion');
    return { content, reasoningContent, toolCalls, finishReason };
  } catch (error) {
    await cancelReader({ reason: error }); throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (cancellation) await cancellation;
    reader.releaseLock();
  }
}

export const TEST_ONLY = {
};
