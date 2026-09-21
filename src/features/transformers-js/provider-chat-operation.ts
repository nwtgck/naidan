import { z } from 'zod';
import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
import { copyChatMessage } from '@/01-models/chat-message';
import { exactObject } from '@/utils/exact-object';
import { cloneLmParameters } from './inference-input-snapshot';
import { prepareInferenceRequest } from './message-projection';
import { createInferenceGeneration } from './create-inference-generation';
import type { InferenceGenerationCallback } from './generation-events';
import type { TransformersJsInferenceScope } from './inference-operation';

export function snapshotChatRequest({ messages, model, parameters, tools, readBinaryObject, debug, signal }: Parameters<LmProvider['chat']>[0]): Parameters<LmProvider['chat']>[0] {
  return exactObject<Parameters<LmProvider['chat']>[0]>()({
    messages: messages.map(message => copyChatMessage({ message })), model,
    parameters: cloneLmParameters({ params: parameters }),
    tools: tools?.map(tool => {
      const { name, description, parameters, ...unhandled } = tool;
      unhandled satisfies Record<PropertyKey, never>;
      return { name, description, parameters: z.record(z.string(), z.json()).parse(parameters) };
    }),
    readBinaryObject, debug, signal,
  });
}

export async function generateScopedMessage({ scope, request, signal, onEvent, continuationOwner }: {
  scope: TransformersJsInferenceScope,
  request: Parameters<LmProvider['chat']>[0],
  signal: AbortSignal,
  onEvent: InferenceGenerationCallback,
  continuationOwner: string,
}): Promise<void> {
  const { messages, model, parameters, tools, readBinaryObject, debug: _debug, signal: _requestSignal, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  scope.assertActive(); signal.throwIfAborted();
  // Resolve only local conversation binaries before touching the loaded model.
  const prepared = await prepareInferenceRequest({ messages, parameters, tools, readBinaryObject, signal });
  scope.assertActive(); signal.throwIfAborted();
  const state = scope.getState();
  if (state.activeModelId !== model || state.status !== 'ready') {
    switch (state.status) {
    case 'loading': throw new Error('Engine is busy. Please wait for the current operation to finish.');
    case 'idle': case 'ready': case 'error': break;
    default: { const exhaustive: never = state.status; throw new Error(`Unhandled runtime status: ${exhaustive}`); }
    }
    await scope.loadDownloadedModel({ modelId: model });
  }
  scope.assertActive(); signal.throwIfAborted();
  await scope.generateMessage({ ...prepared, onEvent, continuationOwner });
}

/** A local facade whose lifetime is owned by the enclosing runtime operation. */
export function createScopedChat({ scope, controller, continuationOwner }: {
  scope: TransformersJsInferenceScope,
  controller: AbortController,
  continuationOwner: string,
}) {
  let phase: 'open' | 'closed' = 'open';
  let generating = false;
  const iterators = new Set<AsyncIterator<ChatGenerationItem>>();
  const failures: unknown[] = [];
  function assertOpen(): void {
    switch (phase) {
    case 'open': return;
    case 'closed': throw new Error('The chat operation is closed.');
    default: { const exhaustive: never = phase; throw new Error(`Unhandled chat operation state: ${exhaustive}`); }
    }
  }


  const chat: LmProvider['chat'] = ({ messages, model, parameters, tools, readBinaryObject, debug, signal }) => {
    const request = snapshotChatRequest({ messages, model, parameters, tools, readBinaryObject, debug, signal });
    let claimed = false;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ChatGenerationItem> {
        if (claimed) throw new Error('A generation stream can only be consumed once.');
        claimed = true;
        const local = new AbortController();
        const sourceSignals = [...new Set([scope.signal, signal].filter(value => value !== undefined))];
        const relays = sourceSignals.map(source => {
          const abort = () => local.abort(source.reason);
          source.addEventListener('abort', abort, { once: true });
          if (source.aborted) abort();
          return () => source.removeEventListener('abort', abort);
        });
        const items = createInferenceGeneration({ signal: local.signal, generate: async ({ onEvent, signal }) => {
          assertOpen();
          scope.assertActive();
          if (generating) throw new Error('The chat operation already has an active generation.');
          generating = true;
          // Child abandonment must interrupt this owner, never whatever runtime
          // happens to be current after an old callback completes.
          const abort = () => controller.abort(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          try {
            await generateScopedMessage({ scope, request, signal, onEvent, continuationOwner });
          } finally {
            generating = false;
            signal.removeEventListener('abort', abort);
          }
        } });
        const inner = items[Symbol.asyncIterator]();
        const detach = () => {
          for (const remove of relays) remove();
          iterators.delete(iterator);
        };
        const iterator: AsyncIterator<ChatGenerationItem> = {
          async next() {
            try {
              assertOpen();
              const next = await inner.next();
              if (next.done) detach();
              return next;
            } catch (error) {
              failures.push(error); detach(); throw error;
            }
          },
          async return() {
            try {
              if (inner.return) await inner.return();
              return { done: true, value: undefined };
            } catch (error) {
              failures.push(error); throw error;
            } finally {
              detach();
            }
          },
        };
        iterators.add(iterator);
        return iterator;
      },
    };
  };
  return {
    chat,
    async close(): Promise<void> {
      phase = 'closed';
      // Unconsumed children are abandoned explicitly. Waiting only for the RPC
      // could otherwise deadlock on its bounded local delivery queues.
      await Promise.all([...iterators].map(async iterator => {
        try {
          await iterator.return?.();
        } catch { /* Recorded by the iterator above. */ }
      }));
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Closing chat generation streams failed.');
    },
  };
}

export const TEST_ONLY = {
};
