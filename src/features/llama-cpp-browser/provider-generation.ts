import { customAlphabet } from 'nanoid';
import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
import { toToolCallId } from '@/01-models/ids';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { snapshotChatRequest } from '@/features/lm/chat-request';
import { prepareLlamaCppRequest } from './message-projection';
import { errorCode, generationEventSchema, generationResultSchema, LlamaCppBrowserError } from './types';
import type { LlamaCppBrowserService, LlamaCppGenerationScope } from './service-contract';

// Native templates may constrain IDs to nine alphanumeric characters.
const createCallId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 9);

export function createLlamaCppGeneration({ request, generate }: {
  request: Parameters<LmProvider['chat']>[0],
  generate: LlamaCppBrowserService['generate'],
}): AsyncIterable<ChatGenerationItem> {
  const { messages, parameters, tools, model, readBinaryObject, debug, signal, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  const snapshot = snapshotChatRequest({ messages, parameters, tools });
  return createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
    const input = await prepareLlamaCppRequest({ ...snapshot, model, readBinaryObject, debug, signal });
    const usedIds = new Set(input.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
    let content = ''; let reasoning = '';
    let reserved = 0;
    const completed = new Map<number, string>();
    let phase: 'reasoning' | 'text' | 'tool_call' = 'reasoning';
    let replayable = true;
    try {
      const result = generationResultSchema.parse(await generate({ input, signal, onEvent: async ({ event }) => {
        const value = generationEventSchema.parse(event);
        switch (value.type) {
        case 'reasoning':
          switch (phase) {
          case 'reasoning': break;
          case 'text': case 'tool_call': replayable = false; break;
          default: { const exhaustive: never = phase; throw new Error(`Unknown generation phase: ${exhaustive}`); }
          }
          reasoning += value.text;
          await writer.text({ type: 'reasoning', text: value.text });
          break;
        case 'text':
          switch (phase) {
          case 'reasoning': phase = 'text'; break;
          case 'text': break;
          case 'tool_call': replayable = false; break;
          default: { const exhaustive: never = phase; throw new Error(`Unknown generation phase: ${exhaustive}`); }
          }
          content += value.text;
          await writer.text({ type: 'text', text: value.text });
          break;
        case 'tool_call_start':
          if (value.index !== reserved) throw new Error('Native call reservations must be ordered and unique.');
          writer.reserveCall({ key: reserved++ });
          phase = 'tool_call';
          await writer.callDraft({ key: value.index, name: undefined, arguments: undefined });
          break;
        case 'tool_call_draft':
          if (value.index >= reserved || completed.has(value.index)) throw new Error('Native call preview has no active reservation.');
          await writer.callDraft({ key: value.index, name: value.name, arguments: value.arguments });
          break;
        case 'tool_call': {
          if (value.index >= reserved || completed.has(value.index)) throw new Error('Native call completion has no unique reservation.');
          const call = value.toolCall;
          completed.set(value.index, JSON.stringify(call));
          let id = call.id;
          if (!id || usedIds.has(id)) {
            do {
              id = createCallId();
            } while (usedIds.has(id));
          }
          usedIds.add(id);
          await writer.call({ key: value.index, toolCall: { ...call, id: toToolCallId({ raw: id }), function: { ...call.function } } });
          break;
        }
        default: { const exhaustive: never = value; throw new Error(`Unknown native event: ${exhaustive}`); }
        }
      } }));
      if (result.content !== content || result.reasoningContent !== reasoning) throw new Error('Native result does not match delivered content.');
      if (signal.aborted) return { type: 'interrupted', reason: 'aborted' };
      switch (result.finishReason) {
      case 'length': return { type: 'interrupted', reason: 'limit' };
      case 'stop_sequence': return { type: 'interrupted', reason: 'stop_sequence' };
      case 'stop':
        if (reserved !== result.toolCalls.length || completed.size !== reserved || result.toolCalls.some((call, index) => completed.get(index) !== JSON.stringify(call))) throw new Error('Native result does not match completed calls.');
        // Preserve unsupported ordering in the generated parts, but do not execute
        // tools before discovering that the next input cannot represent it.
        if (!replayable) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
        return { type: 'finished', next: result.toolCalls.length ? 'tool_results' : 'user' };
      default: { const exhaustive: never = result.finishReason; throw new Error(`Unknown finish reason: ${exhaustive}`); }
      }
    } catch (error) {
      if (signal.aborted || errorCode({ error }) === 'aborted') return { type: 'interrupted', reason: 'aborted' };
      throw error;
    }
  } });
}

/** The outer operation owns every local child, not only the native RPC promise. */
export function createScopedGeneration({ scope }: { scope: LlamaCppGenerationScope }) {
  let phase: 'open' | 'closed' = 'open';
  let generating = false;
  const readers = new Set<AsyncIterator<ChatGenerationItem>>();
  function assertOpen(): void {
    switch (phase) {
    case 'open': return;
    case 'closed': throw new Error('The chat operation is closed.');
    default: { const exhaustive: never = phase; throw new Error(`Unknown operation phase: ${exhaustive}`); }
    }
  }
  const chat: LmProvider['chat'] = ({ messages, model, parameters, tools, readBinaryObject, debug, signal }) => {
    assertOpen();
    const local = new AbortController();
    // Capture before the returned iterable is consumed or waits for the native lane.
    const items = createLlamaCppGeneration({ request: { messages, model, parameters, tools, readBinaryObject, debug, signal: local.signal }, generate: scope.generate });
    let claimed = false;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ChatGenerationItem> {
        assertOpen();
        if (claimed) throw new Error('A generation stream can only be consumed once.');
        claimed = true;
        const sources = [...new Set([scope.signal, signal].filter(value => value !== undefined))];
        const removers = sources.map(source => {
          const forward = () => local.abort(source.reason);
          source.addEventListener('abort', forward, { once: true });
          if (source.aborted) forward();
          return () => source.removeEventListener('abort', forward);
        });
        const inner = items[Symbol.asyncIterator]();
        let active = false;
        let ended = false;
        let children = 0;
        const detach = () => {
          if (active) generating = false;
          active = false;
          for (const remove of removers) remove();
          readers.delete(reader);
        };
        const settled = () => {
          if (ended && children === 0) detach();
        };
        const reader: AsyncIterator<ChatGenerationItem> = {
          async next() {
            if (ended) return { done: true, value: undefined };
            assertOpen();
            if (!active) {
              if (generating) throw new Error('The chat operation already has a generation.');
              generating = true; active = true;
            }
            const next = await inner.next();
            if (next.done) {
              ended = true; settled(); return next;
            }
            const item = next.value;
            switch (item.type) {
            case 'text': case 'reasoning': {
              children++;
              let childClaimed = false;
              const chunks: AsyncIterable<string> = {
                async *[Symbol.asyncIterator]() {
                  if (childClaimed) throw new Error('A part stream can only be consumed once.');
                  childClaimed = true;
                  try {
                    yield* item.chunks;
                  } finally {
                    children--; settled();
                  }
                },
              };
              return { done: false, value: { ...item, chunks } };
            }
            case 'tool_call_draft': case 'tool_call': case 'result': return next;
            default: { const exhaustive: never = item; throw new Error(`Unknown generation item: ${exhaustive}`); }
            }
          },
          async return() {
            ended = true;
            try {
              await inner.return?.(); return { done: true, value: undefined };
            } finally {
              detach();
            }
          },
        };
        readers.add(reader);
        return reader;
      },
    };
  };
  return {
    chat,
    async close(): Promise<void> {
      phase = 'closed';
      // return() abandons each producer and every unread child before waiting.
      const results = await Promise.allSettled([...readers].map(reader => reader.return?.()));
      const failures = results.flatMap(result => {
        switch (result.status) {
        case 'fulfilled': return [];
        case 'rejected': return [result.reason];
        default: { const exhaustive: never = result; throw new Error(`Unknown cleanup result: ${exhaustive}`); }
        }
      });
      if (failures.length) throw new AggregateError(failures, 'Could not close the chat operation.');
    },
  };
}
export const TEST_ONLY = {
};
