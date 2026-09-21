import type { LmProvider } from '@/01-models/lm';
import type { TextOrBinaryObject } from '@/01-models/tool';
import { formatToolExecutionOutcomeForLm } from '@/01-models/tool';
import { idToRaw } from '@/01-models/ids';
import { snapshotChatRequest } from '@/features/lm/chat-request';
import { LlamaCppBrowserError, type GenerateInput } from './types';

/** Resolve local content before loading a model; never rebuild history from UI text. */
export async function prepareLlamaCppRequest({ messages, model, parameters, tools, readBinaryObject, debug, signal }: Parameters<LmProvider['chat']>[0]): Promise<Omit<GenerateInput, 'options'>> {
  const snapshot = snapshotChatRequest({ messages, parameters, tools });
  const accepted: GenerateInput['messages'] = [];
  const callNames = new Map<string, string>();
  const unsupported = (): never => {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  };
  const readText = async ({ content }: { content: TextOrBinaryObject }): Promise<string> => {
    switch (content.type) {
    case 'text': return content.text;
    case 'binary_object': {
      if (!readBinaryObject) return unsupported();
      const blob = await readBinaryObject({ binaryObjectId: content.id, signal });
      signal?.throwIfAborted();
      const bytes = await blob.arrayBuffer();
      signal?.throwIfAborted();
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    default: { const exhaustive: never = content; throw new Error(`Unknown tool content: ${exhaustive}`); }
    }
  };
  for (const message of snapshot.messages) {
    signal?.throwIfAborted();
    const { id: _id, role: _role, parts: _parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    switch (message.role) {
    case 'system':
      accepted.push({ role: 'system', content: message.parts.map(part => part.text).join('') });
      break;
    case 'user': {
      const content: Exclude<GenerateInput['messages'][number]['content'], string> = [];
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
          const { id: _attachmentId, binaryObjectId, mimeType, originalName: _name, size: _size, uploadedAt: _uploadedAt, ...state } = attachment;
          if (!mimeType.startsWith('image/')) return unsupported();
          let blob: Blob;
          switch (state.status) {
          case 'memory': blob = state.blob; break;
          case 'persisted':
            if (!readBinaryObject) return unsupported();
            blob = await readBinaryObject({ binaryObjectId, signal });
            break;
          case 'missing': return unsupported();
          default: { const exhaustive: never = state; throw new Error(`Unknown attachment state: ${exhaustive}`); }
          }
          signal?.throwIfAborted();
          content.push({ type: 'image', blob });
          break;
        }
        default: { const exhaustive: never = part; throw new Error(`Unknown user part: ${exhaustive}`); }
        }
      }
      // Native chat has a single text value unless image positions are needed.
      accepted.push({ role: 'user', content: content.every(part => part.type === 'text') ? content.map(part => part.text).join('') : content });
      break;
    }
    case 'assistant': {
      let content = '';
      let reasoning: string | undefined;
      let phase: 'reasoning' | 'text' | 'tool_call' = 'reasoning';
      const calls: NonNullable<GenerateInput['messages'][number]['tool_calls']> = [];
      for (const part of message.parts) {
        switch (part.type) {
        case 'reasoning': {
          const { id: _id, type: _type, text, completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          // The native message has one leading reasoning field, not arbitrary channels.
          if (phase !== 'reasoning' || reasoning !== undefined || completeness !== 'complete') return unsupported();
          reasoning = text;
          break;
        }
        case 'text': {
          const { id: _id, type: _type, text, completeness: _completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          switch (phase) {
          case 'reasoning': case 'text': break;
          case 'tool_call': return unsupported();
          default: { const exhaustive: never = phase; throw new Error(`Unknown input phase: ${exhaustive}`); }
          }
          phase = 'text'; content += text;
          break;
        }
        case 'tool_call': {
          const { id: _id, type: _type, toolCall, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          const { id, type, function: fn, ...unhandledCall } = toolCall;
          unhandledCall satisfies Record<PropertyKey, never>;
          const { name, arguments: argumentsText, ...unhandledFunction } = fn;
          unhandledFunction satisfies Record<PropertyKey, never>;
          const raw = idToRaw({ id });
          callNames.set(raw, name);
          phase = 'tool_call';
          calls.push({ id: raw, type, function: { name, arguments: argumentsText } });
          break;
        }
        default: { const exhaustive: never = part; throw new Error(`Unknown assistant part: ${exhaustive}`); }
        }
      }
      accepted.push({ role: 'assistant', content, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }), ...(calls.length ? { tool_calls: calls } : {}) });
      break;
    }
    case 'tool':
      for (const part of message.parts) {
        const { id: _id, type: _type, result, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        const id = idToRaw({ id: result.toolCallId });
        const name = callNames.get(id);
        if (name === undefined) return unsupported();
        let content: string;
        switch (result.status) {
        case 'executing': return unsupported();
        case 'success': content = await readText({ content: result.content }); break;
        case 'error': content = formatToolExecutionOutcomeForLm({ outcome: { status: 'error', code: result.error.code, message: await readText({ content: result.error.message }) } }); break;
        default: { const exhaustive: never = result; throw new Error(`Unknown tool result: ${exhaustive}`); }
        }
        accepted.push({ role: 'tool', content, tool_call_id: id, name });
      }
      break;
    default: { const exhaustive: never = message; throw new Error(`Unknown chat message: ${exhaustive}`); }
    }
  }
  signal?.throwIfAborted();
  return { model, debug, messages: accepted,
    tools: snapshot.tools?.map(tool => ({ type: 'function', function: { ...tool } })),
    reasoningEffort: snapshot.parameters?.reasoning.effort,
    temperature: snapshot.parameters?.temperature ?? 0.7,
    topP: snapshot.parameters?.topP ?? 0.95,
    maxTokens: snapshot.parameters?.maxCompletionTokens,
    presencePenalty: snapshot.parameters?.presencePenalty ?? 0,
    frequencyPenalty: snapshot.parameters?.frequencyPenalty ?? 0,
    stop: snapshot.parameters?.stop ?? [],
  };
}
export const TEST_ONLY = {
};
