import type { ChatGenerationItem, ChatGenerationResult } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { inferenceGenerationEventSchema, type InferenceGenerationCallback } from './generation-events';

/** Rebuilds local part iterators from an acknowledged, serializable native stream. */
export function createInferenceGeneration({ signal, generate }: {
  signal: AbortSignal | undefined,
  generate: ({ onEvent, signal }: { onEvent: InferenceGenerationCallback, signal: AbortSignal }) => Promise<void>,
}): AsyncIterable<ChatGenerationItem> {
  return createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
    let position = 0;
    let active: { index: number, kind: 'text' | 'reasoning' } | undefined;
    let result: ChatGenerationResult | undefined;
    let partial = false;
    const calls = new Map<number, 'pending' | 'complete'>();
    const callIds = new Set<string>();
    let accepting = true;
    let processing = false;
    let callbackFailure: { error: unknown } | undefined;
    function requireNewPosition({ index }: { index: number }): void {
      if (index !== position) throw new Error('Inference part positions are not consecutive.');
      if (active !== undefined) throw new Error('Inference changed parts before closing the previous body.');
      position++;
    }
    try {
      await generate({ signal, onEvent: async ({ event: raw }) => {
        if (!accepting) return;
        if (callbackFailure !== undefined) throw callbackFailure.error;
        if (processing) {
          const error = new Error('Inference delivery must await each event acknowledgement.');
          callbackFailure = { error }; throw error;
        }
        processing = true;
        try {
          const event = inferenceGenerationEventSchema.parse(raw);
          if (result !== undefined) throw new Error('Inference published content after its result.');
          switch (event.type) {
          case 'part_start':
            requireNewPosition({ index: event.index });
            active = { index: event.index, kind: event.kind };
            // A declared empty part is meaningful. Ordinary empty chunks never
            // invent a reasoning part; only this native boundary creates one.
            await writer.text({ type: event.kind, text: '' });
            break;
          case 'text_delta':
            if (active?.index !== event.index) throw new Error('Inference delta has no matching open part.');
            await writer.text({ type: active.kind, text: event.text });
            break;
          case 'part_end':
            if (active?.index !== event.index) throw new Error('Inference closed an unknown part.');
            writer.finishTextPart({ completeness: event.completeness });
            partial ||= event.completeness === 'partial';
            active = undefined;
            break;
          case 'tool_start':
            requireNewPosition({ index: event.index });
            writer.reserveCall({ key: event.index }); calls.set(event.index, 'pending');
            break;
          case 'tool_call': {
            const callState = calls.get(event.index);
            switch (callState) {
            case 'pending': break;
            case 'complete': case undefined: throw new Error('Inference published an unreserved or repeated call.');
            default: { const exhaustive: never = callState; throw new Error(`Unhandled call state: ${exhaustive}`); }
            }
            if (callIds.has(String(event.toolCall.id))) throw new Error('Inference repeated a tool call ID.');
            callIds.add(String(event.toolCall.id));
            await writer.call({ key: event.index, toolCall: event.toolCall });
            calls.set(event.index, 'complete');
            break;
          }
          case 'result': {
            if (active !== undefined) throw new Error('Inference result arrived before its part boundary.');
            const completedCalls = [...calls.values()].filter(value => value === 'complete').length;
            switch (event.result.type) {
            case 'finished':
              if (partial || [...calls.values()].some(value => value === 'pending')) throw new Error('Inference declared success with unfinished content.');
              if ((event.result.next === 'tool_results') !== (completedCalls > 0)) throw new Error('Inference result does not match its completed calls.');
              break;
            case 'interrupted': break;
            default: { const exhaustive: never = event.result; throw new Error(`Unhandled inference result: ${exhaustive}`); }
            }
            result = event.result;
            break;
          }
          default: { const exhaustive: never = event; throw new Error(`Unhandled inference event: ${exhaustive}`); }
          }
        } catch (error) {
          callbackFailure ??= { error }; throw error;
        } finally {
          processing = false;
        }
      } });
      if (processing) throw new Error('Inference returned before its callback acknowledgement.');
      if (callbackFailure !== undefined) throw callbackFailure.error;
      if (result === undefined) throw new Error('Inference ended without a native result.');
      // This return happens only after the RPC/owned generation operation has
      // settled. A result event alone never starts a competing model request.
      return result;
    } finally {
      accepting = false;
    }
  } });
}

export const TEST_ONLY = {
};
