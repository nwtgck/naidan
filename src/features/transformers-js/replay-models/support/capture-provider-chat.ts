import type { ChatGenerationItem, ChatGenerationResult, LmProvider } from '@/01-models/lm';
import type { AssistantMessageNode, ToolCall } from '@/01-models/types';
import { toMessageId } from '@/01-models/ids';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { promiseAllKeyed } from '@/utils/promise';

export type CapturedChatRequest = Parameters<LmProvider['chat']>[0];
type TextItem = Extract<ChatGenerationItem, { type: 'text' | 'reasoning' }>;
export type CapturedProviderPart =
  | { type: 'text' | 'reasoning'; partId: string; index: number; chunks: string[]; completeness: 'pending' | 'complete' | 'partial' }
  | Extract<ChatGenerationItem, { type: 'tool_call' }>;
export type CapturedProviderEvent =
  | { kind: 'part'; type: 'text' | 'reasoning'; partId: string; index: number }
  | { kind: 'chunk'; partId: string; chunk: string }
  | { kind: 'part-complete'; partId: string; completeness: 'complete' | 'partial' }
  | { kind: 'tool-call'; partId: string; index: number; toolCall: ToolCall }
  | { kind: 'result'; result: ChatGenerationResult }
  | { kind: 'settled'; outcome: 'fulfilled' | 'rejected' | 'disposed' };
type FailureSource = 'provider' | 'outer' | 'chunks' | 'completeness' | 'cleanup' | 'protocol';
type ChatSettlement =
  | { status: 'pending' | 'fulfilled' | 'disposed' }
  | { status: 'rejected'; source: FailureSource; error: unknown };
export interface CapturedProviderChatSnapshot {
  /** Logical order; events retain delivery order, including interleaved children. */
  parts: CapturedProviderPart[];
  result: ChatGenerationResult | undefined;
  events: CapturedProviderEvent[];
  settlement: ChatSettlement;
}
export interface ProviderChatCapture {
  /** A delivered error result fulfills this Promise; a broken iterator rejects it. */
  completion: Promise<void>;
  snapshot(): CapturedProviderChatSnapshot;
  /** Abandon consumption, unlike aborting the request and draining accepted content. */
  dispose(): Promise<void>;
}

/** Observe one literal public call through the production consumer. No tool execution,
 * continuation, input selection, or expected model output belongs to this recorder.
 */
export function captureProviderChat({ provider, request }: {
  provider: Pick<LmProvider, 'chat'>; request: CapturedChatRequest;
}): ProviderChatCapture {
  const parts: CapturedProviderPart[] = [];
  const events: CapturedProviderEvent[] = [];
  const waiting = new Set<ReturnType<typeof Promise.withResolvers<never>>['reject']>();
  const disposed = new Error('Provider chat capture was disposed.');
  let disposalRequested = false;
  let failure: { source: FailureSource; error: unknown } | undefined;
  let settlement: ChatSettlement = { status: 'pending' };
  let result: ChatGenerationResult | undefined;

  function isSettled(): boolean {
    switch (settlement.status) {
    case 'pending': return false;
    case 'fulfilled':
    case 'rejected':
    case 'disposed': return true;
    default: { const exhaustive: never = settlement; throw new Error(String(exhaustive)); }
    }
  }

  function recordFailure({ source, error }: { source: FailureSource; error: unknown }): void {
    if (error !== disposed) failure ??= { source, error };
  }

  // Retain handlers only for pending reads, not one disposal-Promise handler per token.
  function waitFor<T>({ pending }: { pending: PromiseLike<T> }): Promise<T> {
    return new Promise((resolve, reject) => {
      waiting.add(reject);
      Promise.resolve(pending).then(value => {
        waiting.delete(reject);
        resolve(value);
      }, error => {
        waiting.delete(reject);
        reject(error);
      });
      if (disposalRequested) {
        waiting.delete(reject);
        reject(disposed);
      }
    });
  }

  function observeIterator<T, U>({ source, values, onValue, onDone }: {
    source: 'outer' | 'chunks'; values: AsyncIterable<T>;
    onValue: ({ value }: { value: T }) => U;
    onDone: ({ state }: { state: 'exhausted' | 'returned' }) => void;
  }): AsyncIterable<U> {
    return {
      [Symbol.asyncIterator]() {
        let iterator: AsyncIterator<T>;
        let closed = false;
        try {
          iterator = values[Symbol.asyncIterator]();
        } catch (error) {
          recordFailure({ source, error });
          throw error;
        }
        return {
          async next() {
            if (closed || isSettled()) return { done: true, value: undefined };
            let next: IteratorResult<T>;
            try {
              next = await waitFor({ pending: iterator.next() });
            } catch (error) {
              recordFailure({ source, error });
              throw error;
            }
            if (closed || isSettled()) return { done: true, value: undefined };
            if (next.done) {
              closed = true;
              onDone({ state: 'exhausted' });
              return { done: true, value: undefined };
            }
            return { done: false, value: onValue({ value: next.value }) };
          },
          async return() {
            closed = true;
            try {
              await iterator.return?.();
            } catch (error) {
              recordFailure({ source: 'cleanup', error });
              throw error;
            } finally {
              onDone({ state: 'returned' });
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  function observeText({ item }: { item: TextItem }): TextItem {
    const { type, partId, index, chunks, completeness, ...unhandled } = item;
    unhandled satisfies Record<PropertyKey, never>;
    const part: Extract<CapturedProviderPart, { type: 'text' | 'reasoning' }> = {
      type, partId, index, chunks: [], completeness: 'pending',
    };
    parts.push(part);
    events.push({ kind: 'part', type, partId, index });
    const drained = Promise.withResolvers<void>();
    let drainState: 'pending' | 'exhausted' | 'returned' = 'pending';
    const observedCompleteness = waitFor({ pending: completeness }).catch((error: unknown) => {
      recordFailure({ source: 'completeness', error });
      throw error;
    });
    // Attach immediately, but publish completeness only after every child chunk
    // has passed through the consumer. An early resolved Promise is not a drain.
    const afterDrain = promiseAllKeyed({ value: observedCompleteness, drained: drained.promise }).then(({ value }) => {
      if (!disposalRequested && !isSettled() && drainState === 'exhausted') {
        part.completeness = value;
        events.push({ kind: 'part-complete', partId, completeness: value });
      }
      return value;
    });
    void afterDrain.catch(() => {});
    return {
      type, partId, index, completeness: afterDrain,
      chunks: observeIterator({ source: 'chunks', values: chunks,
        onValue: ({ value }) => {
          part.chunks.push(value);
          events.push({ kind: 'chunk', partId, chunk: value });
          return value;
        },
        onDone: ({ state }) => {
          drainState = state;
          drained.resolve();
        },
      }),
    };
  }

  function observeItem({ value: item }: { value: ChatGenerationItem }): ChatGenerationItem {
    switch (item.type) {
    case 'text':
    case 'reasoning': return observeText({ item });
    case 'tool_call': {
      const { type, partId, index, toolCall, ...unhandled } = item;
      unhandled satisfies Record<PropertyKey, never>;
      const copy = structuredClone(toolCall);
      parts.push({ type, partId, index, toolCall: copy });
      events.push({ kind: 'tool-call', partId, index, toolCall: copy });
      return item;
    }
    case 'result': {
      const { type: _type, result: value, ...unhandled } = item;
      unhandled satisfies Record<PropertyKey, never>;
      result = { ...value };
      events.push({ kind: 'result', result });
      return item;
    }
    default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
    }
  }

  const completion = (async () => {
    try {
      let items: AsyncIterable<ChatGenerationItem>;
      try {
        // Forward the literal contract, including the original signal and resolver.
        items = provider.chat(request);
      } catch (error) {
        recordFailure({ source: 'provider', error });
        throw error;
      }
      const node: AssistantMessageNode = {
        id: toMessageId({ raw: 'captured-assistant' }), role: 'assistant', createdAt: 0,
        parts: [], modelId: undefined, lmParameters: undefined, interruption: undefined,
        replies: { items: [] },
      };
      await consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {},
        items: observeIterator({ source: 'outer', values: items, onValue: observeItem, onDone: () => {} }),
      });
      settlement = { status: 'fulfilled' };
      events.push({ kind: 'settled', outcome: 'fulfilled' });
    } catch (error) {
      if (error === disposed && failure === undefined) {
        settlement = { status: 'disposed' };
        events.push({ kind: 'settled', outcome: 'disposed' });
        return;
      }
      settlement = { status: 'rejected', source: failure?.source ?? 'protocol', error };
      events.push({ kind: 'settled', outcome: 'rejected' });
      throw error;
    }
  })();

  return {
    completion,
    snapshot() {
      return {
        parts: structuredClone(parts).sort((left, right) => left.index - right.index),
        result: result === undefined ? undefined : { ...result },
        events: events.map(event => {
          switch (event.kind) {
          case 'result': return { ...event, result: { ...event.result } };
          case 'tool-call': return structuredClone(event);
          case 'part':
          case 'chunk':
          case 'part-complete':
          case 'settled': return { ...event };
          default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
          }
        }),
        // Error objects retain their identity; they are not serialized evidence.
        settlement: { ...settlement },
      };
    },
    async dispose() {
      switch (settlement.status) {
      case 'pending':
        disposalRequested = true;
        for (const reject of waiting) reject(disposed);
        waiting.clear();
        break;
      case 'fulfilled':
      case 'rejected':
      case 'disposed': break;
      default: { const exhaustive: never = settlement; throw new Error(String(exhaustive)); }
      }
      await completion;
    },
  };
}

export const TEST_ONLY = {
};
