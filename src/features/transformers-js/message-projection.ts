import { z } from 'zod';
import type { LmProvider } from '@/01-models/lm';
import type { ChatMessage, MultimodalContent } from '@/01-models/types';
import type { TextOrBinaryObject, ToolExecutionResult } from '@/01-models/tool';
import { formatToolExecutionOutcomeForLm } from '@/01-models/tool';
import { copyChatMessage } from '@/01-models/chat-message';
import { exactObject } from '@/utils/exact-object';
import { cloneLmParameters } from './inference-input-snapshot';
import type { InferenceMessage, WorkerToolDefinition } from './types';

type BinaryReader = Parameters<LmProvider['chat']>[0]['readBinaryObject'];

/** Prepare detached, local model inputs without retaining mutable application history. */
export async function prepareInferenceRequest({ messages, parameters, tools, readBinaryObject, signal }: {
  messages: readonly ChatMessage[],
  parameters: Parameters<LmProvider['chat']>[0]['parameters'],
  tools: Parameters<LmProvider['chat']>[0]['tools'],
  readBinaryObject: BinaryReader,
  signal: AbortSignal | undefined,
}): Promise<{
  messages: InferenceMessage[],
  params: Parameters<LmProvider['chat']>[0]['parameters'],
  tools: WorkerToolDefinition[] | undefined,
}> {
  signal?.throwIfAborted();
  // Snapshot before the first binary resolution can yield to UI edits.
  const acceptedMessages = messages.map(message => copyChatMessage({ message }));
  const params = cloneLmParameters({ params: parameters });
  const workerTools = tools?.map(tool => {
    const { name, description, parameters, ...unhandled } = tool;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<WorkerToolDefinition>()({
      type: 'function',
      function: { name, description, parameters: z.record(z.string(), z.json()).parse(parameters) },
    });
  });

  // Only one leading reasoning segment fits this native message contract.
  // Preserve its state; the selected model adapter decides whether its template
  // can represent it. Never manufacture inline tags to make a request fit.
  for (const message of acceptedMessages) validateRepresentableMessage({ message });

  const inferenceMessages: InferenceMessage[] = [];
  for (const message of acceptedMessages) {
    signal?.throwIfAborted();
    const { id: _id, role, parts: _parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    switch (message.role) {
    case 'user': {
      const content: MultimodalContent[] = [];
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
          const { id: _attachmentId, binaryObjectId, originalName, mimeType, size: _size, uploadedAt: _uploadedAt, ...state } = attachment;
          let blob: Blob;
          switch (state.status) {
          case 'memory': {
            const { status: _status, blob: value, ...unhandled } = state;
            unhandled satisfies Record<PropertyKey, never>;
            blob = value;
            break;
          }
          case 'persisted': {
            const { status: _status, ...unhandled } = state;
            unhandled satisfies Record<PropertyKey, never>;
            if (!readBinaryObject) throw new Error(`No binary reader for attachment "${originalName}".`);
            blob = await readBinaryObject({ binaryObjectId, signal });
            break;
          }
          case 'missing': throw new Error(`Attachment "${originalName}" is missing.`);
          default: { const _ex: never = state; throw new Error(`Unhandled attachment state: ${_ex}`); }
          }
          signal?.throwIfAborted();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          signal?.throwIfAborted();
          // Data URLs cross the existing image input boundary; no remote fetch or
          // model download is authorized by resolving a conversation attachment.
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${btoa(binary)}` } });
          break;
        }
        default: { const _ex: never = part; throw new Error(`Unhandled user part: ${_ex}`); }
        }
      }
      inferenceMessages.push({ role, content: nativeContent({ parts: content }) });
      break;
    }
    case 'assistant': {
      const content: MultimodalContent[] = [];
      const calls: NonNullable<InferenceMessage['tool_calls']> = [];
      let reasoning: InferenceMessage['reasoning'];
      for (const part of message.parts) {
        switch (part.type) {
        case 'text': {
          const { id: _id, type, text, completeness: _completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          content.push({ type, text });
          break;
        }
        case 'tool_call': {
          const { id: _id, type: _type, toolCall, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          // copyChatMessage already detached the arguments without JSON parsing.
          calls.push(toolCall);
          break;
        }
        case 'reasoning': {
          const { id: _id, type: _type, text, completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          reasoning = { text, completeness };
          break;
        }
        default: { const _ex: never = part; throw new Error(`Unhandled assistant part: ${_ex}`); }
        }
      }
      inferenceMessages.push({ role, content: nativeContent({ parts: content }), ...(calls.length === 0 ? {} : { tool_calls: calls }), ...(reasoning === undefined ? {} : { reasoning }) });
      break;
    }
    case 'system': {
      const content = message.parts.map(part => {
        const { id: _id, type, text, completeness: _completeness, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        return { type, text };
      });
      inferenceMessages.push({ role, content: nativeContent({ parts: content }) });
      break;
    }
    case 'tool':
      for (const part of message.parts) {
        const { id: _id, type: _type, result, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        const content = await readToolResult({ result, readBinaryObject, signal });
        inferenceMessages.push({ role, content, tool_call_id: result.toolCallId });
      }
      break;
    default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
    }
  }
  signal?.throwIfAborted();
  return { messages: inferenceMessages, params, tools: workerTools };
}

function nativeContent({ parts }: { parts: MultimodalContent[] }): InferenceMessage['content'] {
  // Keep an absent body distinct from one explicitly empty text part. Multiple
  // text parts retain their boundaries instead of being joined before templating.
  const only = parts[0];
  if (parts.length === 1 && only?.type === 'text') return only.text;
  return parts;
}

function validateRepresentableMessage({ message }: { message: ChatMessage }): void {
  switch (message.role) {
  case 'assistant': {
    let phase: 'reasoning' | 'text' | 'tool_call' = 'reasoning';
    let hasReasoning = false;
    for (const part of message.parts) {
      switch (part.type) {
      case 'reasoning':
        if (hasReasoning || phase !== 'reasoning') throw new Error('The native input requires a single leading reasoning part.');
        hasReasoning = true;
        break;
      case 'text':
        switch (phase) {
        case 'reasoning':
        case 'text': phase = 'text'; break;
        case 'tool_call': throw new Error('The native input cannot represent text after a tool call in one message.');
        default: { const _ex: never = phase; throw new Error(`Unhandled projection phase: ${_ex}`); }
        }
        break;
      case 'tool_call': phase = 'tool_call'; break;
      default: { const _ex: never = part; throw new Error(`Unhandled assistant part: ${_ex}`); }
      }
    }
    return;
  }
  case 'user':
    for (const part of message.parts) {
      switch (part.type) {
      case 'text': break;
      case 'attachment':
        switch (part.attachment.status) {
        case 'memory':
        case 'persisted': break;
        case 'missing': throw new Error(`Attachment "${part.attachment.originalName}" is missing.`);
        default: { const _ex: never = part.attachment; throw new Error(`Unhandled attachment: ${_ex}`); }
        }
        if (!/^image\/[a-zA-Z0-9.+-]+$/.test(part.attachment.mimeType)) throw new Error('This model input supports image attachments only.');
        break;
      default: { const _ex: never = part; throw new Error(`Unhandled user part: ${_ex}`); }
      }
    }
    return;
  case 'tool':
    if (message.parts.length === 0) throw new Error('A tool message has no results.');
    if (message.parts.some(part => part.result.status === 'executing')) throw new Error('A tool result is still executing.');
    return;
  case 'system': return;
  default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
  }
}

async function readToolContent({ content, readBinaryObject, signal }: {
  content: TextOrBinaryObject,
  readBinaryObject: BinaryReader,
  signal: AbortSignal | undefined,
}): Promise<string> {
  switch (content.type) {
  case 'text': {
    const { type: _type, text, ...unhandled } = content;
    unhandled satisfies Record<PropertyKey, never>;
    return text;
  }
  case 'binary_object': {
    const { type: _type, id, ...unhandled } = content;
    unhandled satisfies Record<PropertyKey, never>;
    if (!readBinaryObject) throw new Error('No binary reader for the tool result.');
    signal?.throwIfAborted();
    const blob = await readBinaryObject({ binaryObjectId: id, signal });
    signal?.throwIfAborted();
    const bytes = await blob.arrayBuffer();
    signal?.throwIfAborted();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  default: { const _ex: never = content; throw new Error(`Unhandled result content: ${_ex}`); }
  }
}

async function readToolResult({ result, readBinaryObject, signal }: {
  result: ToolExecutionResult,
  readBinaryObject: BinaryReader,
  signal: AbortSignal | undefined,
}): Promise<string> {
  switch (result.status) {
  case 'success': {
    const { toolCallId: _toolCallId, status: _status, content, ...unhandled } = result;
    unhandled satisfies Record<PropertyKey, never>;
    return readToolContent({ content, readBinaryObject, signal });
  }
  case 'error': {
    const { toolCallId: _toolCallId, status, error, ...unhandled } = result;
    unhandled satisfies Record<PropertyKey, never>;
    const { code, message, ...unhandledError } = error;
    unhandledError satisfies Record<PropertyKey, never>;
    return formatToolExecutionOutcomeForLm({ outcome: { status, code, message: await readToolContent({ content: message, readBinaryObject, signal }) } });
  }
  case 'executing': throw new Error('A tool result is still executing.');
  default: { const _ex: never = result; throw new Error(`Unhandled tool result: ${_ex}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
