import { z } from 'zod';
import type { ChatMessage, LmParameters } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import type { TextOrBinaryObject, ToolExecutionResult } from '@/01-models/tool';
import { formatToolExecutionOutcomeForLm } from '@/01-models/tool';
import { copyChatMessage } from '@/01-models/chat-message';
import { idToRaw } from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';

type BinaryReader = Parameters<LmProvider['chat']>[0]['readBinaryObject'];

/** Snapshot plain model options without carrying reactive references into deferred work. */
export function snapshotChatRequest({ messages, parameters, tools }: Pick<Parameters<LmProvider['chat']>[0], 'messages' | 'parameters' | 'tools'>) {
  const copy = messages.map(message => copyChatMessage({ message }));
  let settings: LmParameters | undefined;
  if (parameters !== undefined) {
    const { temperature, topP, maxCompletionTokens, presencePenalty, frequencyPenalty, stop, reasoning, ...unhandled } = parameters;
    unhandled satisfies Record<PropertyKey, never>;
    const { effort, ...unhandledReasoning } = reasoning;
    unhandledReasoning satisfies Record<PropertyKey, never>;
    settings = exactObject<LmParameters>()({ temperature, topP, maxCompletionTokens, presencePenalty, frequencyPenalty, stop: stop?.slice(), reasoning: { effort } });
  }
  return { messages: copy, parameters: settings, tools: tools?.map(tool => {
    const { name, description, parameters, ...unhandled } = tool;
    unhandled satisfies Record<PropertyKey, never>;
    return { name, description, parameters: z.record(z.string(), z.json()).parse(parameters) };
  }) };
}

export type ApiContentPart = { type: 'text', text: string } | { type: 'image_url', image_url: { url: string } };
export type ApiChatMessage = {
  role: ChatMessage['role'],
  content: string | ApiContentPart[] | undefined,
  reasoning_content: string | undefined,
  tool_calls: { id: string, type: 'function', function: { name: string, arguments: string } }[] | undefined,
  tool_call_id: string | undefined,
};

/** API-specific projection, not a second persisted history representation. */
export async function buildApiChatMessages({ messages, readBinaryObject, signal }: {
  messages: readonly ChatMessage[],
  readBinaryObject: BinaryReader,
  signal: AbortSignal | undefined,
}): Promise<ApiChatMessage[]> {
  const result: ApiChatMessage[] = [];
  for (const message of messages) {
    signal?.throwIfAborted();
    const { id: _id, role, parts: _parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    // Branch on the original discriminated object so part types remain narrowed.
    switch (message.role) {
    case 'user': {
      const content: ApiContentPart[] = [];
      for (const part of message.parts) {
        switch (part.type) {
        case 'text': {
          const { id: _id, type, text, completeness: _completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          content.push({ type, text });
          break;
        }
        case 'attachment': {
          const { id: _id, type: _type, attachment, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          const { id: _attachmentId, binaryObjectId, mimeType, originalName, size: _size, uploadedAt: _uploadedAt, ...state } = attachment;
          let blob: Blob;
          switch (state.status) {
          case 'memory': blob = state.blob; break;
          case 'persisted':
            if (!readBinaryObject) throw new Error(`No binary reader for attachment "${originalName}".`);
            blob = await readBinaryObject({ binaryObjectId, signal });
            break;
          case 'missing': throw new Error(`Attachment "${originalName}" is missing.`);
          default: {
            const _ex: never = state;
            throw new Error(`Unhandled attachment state: ${_ex}`);
          }
          }
          signal?.throwIfAborted();
          if (mimeType.startsWith('image/')) {
            const data = new Uint8Array(await blob.arrayBuffer());
            let binary = '';
            for (const byte of data) binary += String.fromCharCode(byte);
            content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${btoa(binary)}` } });
          } else if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
            content.push({ type: 'text', text: `[File: ${originalName}]\n${text}` });
          } else {
            throw new Error(`This chat API cannot represent attachment "${originalName}" (${mimeType}).`);
          }
          break;
        }
        default: {
          const _ex: never = part;
          throw new Error(`Unhandled user part: ${_ex}`);
        }
        }
      }
      // Without attachments this API has one text field. Keep absence distinct from empty text.
      result.push({ role, content: content.some(part => part.type === 'image_url') ? content : content.map(part => {
        switch (part.type) {
        case 'text': return part.text;
        case 'image_url': throw new Error('Expected text-only content.');
        default: { const _ex: never = part; throw new Error(`Unhandled content: ${_ex}`); }
        }
      }).join(''), reasoning_content: undefined, tool_calls: undefined, tool_call_id: undefined });
      break;
    }
    case 'assistant': {
      let content: string | undefined;
      let reasoning: string | undefined;
      const calls: NonNullable<ApiChatMessage['tool_calls']> = [];
      let phase: 'reasoning' | 'text' | 'tool_call' = 'reasoning';
      for (const part of message.parts) {
        switch (part.type) {
        case 'reasoning': {
          const { id: _id, type: _type, text, completeness: _completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          switch (phase) {
          case 'reasoning': break;
          case 'text':
          case 'tool_call': throw new Error('This API cannot represent reasoning after text or a tool call.');
          default: { const _ex: never = phase; throw new Error(`Unhandled projection phase: ${_ex}`); }
          }
          reasoning = (reasoning ?? '') + text;
          break;
        }
        case 'text': {
          const { id: _id, type: _type, text, completeness: _completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          switch (phase) {
          case 'reasoning':
          case 'text': break;
          case 'tool_call': throw new Error('This API cannot represent text after a tool call in the same message.');
          default: { const _ex: never = phase; throw new Error(`Unhandled projection phase: ${_ex}`); }
          }
          phase = 'text'; content = (content ?? '') + text;
          break;
        }
        case 'tool_call': {
          const { id: _id, type: _type, toolCall, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          const { id, type, function: fn, ...unhandledCall } = toolCall;
          unhandledCall satisfies Record<PropertyKey, never>;
          const { name, arguments: argumentsText, ...unhandledFunction } = fn;
          unhandledFunction satisfies Record<PropertyKey, never>;
          phase = 'tool_call';
          calls.push({ id: idToRaw({ id }), type, function: { name, arguments: argumentsText } });
          break;
        }
        default: {
          const _ex: never = part;
          throw new Error(`Unhandled assistant part: ${_ex}`);
        }
        }
      }
      result.push({ role, content, reasoning_content: reasoning, tool_calls: calls.length ? calls : undefined, tool_call_id: undefined });
      break;
    }
    case 'system':
      result.push({ role, content: message.parts.map(part => part.text).join(''), reasoning_content: undefined, tool_calls: undefined, tool_call_id: undefined });
      break;
    case 'tool':
      for (const part of message.parts) {
        const { id: _id, type: _type, result: outcome, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        result.push({ role, content: await toolText({ result: outcome, readBinaryObject, signal }), reasoning_content: undefined, tool_calls: undefined, tool_call_id: idToRaw({ id: outcome.toolCallId }) });
      }
      break;
    default: {
      const _ex: never = message;
      throw new Error(`Unhandled chat message: ${_ex}`);
    }
    }
  }
  signal?.throwIfAborted();
  return result;
}

async function resolveToolText({ content, readBinaryObject, signal }: { content: TextOrBinaryObject, readBinaryObject: BinaryReader, signal: AbortSignal | undefined }): Promise<string> {
  switch (content.type) {
  case 'text': return content.text;
  case 'binary_object': {
    if (!readBinaryObject) throw new Error('No binary reader for the tool result.');
    const blob = await readBinaryObject({ binaryObjectId: content.id, signal });
    signal?.throwIfAborted();
    const bytes = await blob.arrayBuffer();
    signal?.throwIfAborted();
    // A leading BOM belongs to the recorded tool text, not transport framing.
    // Reject corrupt bytes rather than changing the next model input with replacements.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  default: { const _ex: never = content; throw new Error(`Unhandled tool content: ${_ex}`); }
  }
}
async function toolText({ result, readBinaryObject, signal }: { result: ToolExecutionResult, readBinaryObject: BinaryReader, signal: AbortSignal | undefined }): Promise<string> {
  switch (result.status) {
  case 'executing': throw new Error('A tool result is still executing.');
  case 'success': return resolveToolText({ content: result.content, readBinaryObject, signal });
  case 'error': return formatToolExecutionOutcomeForLm({ outcome: { status: 'error', code: result.error.code, message: await resolveToolText({ content: result.error.message, readBinaryObject, signal }) } });
  default: { const _ex: never = result; throw new Error(`Unhandled tool result: ${_ex}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
