import type { AssistantMessageNode } from '@/01-models/types';
import type { ChatGenerationItem, ChatGenerationResult } from '@/01-models/lm';
import { createAssistantGeneration } from '@/01-models/assistant-generation';

/**
 * Owns one local generation stream. Children run concurrently to avoid blocking
 * an interleaved upstream, while mutations and their acknowledgments are ordered.
 * Ordinary signal cancellation stops the producer, not this consumer's drain.
 * The producer must settle pending reads when aborted, including worker loss.
 */
export async function consumeChatGeneration({ node, items, abortController, onChange }: {
  node: AssistantMessageNode,
  items: AsyncIterable<ChatGenerationItem>,
  abortController: AbortController,
  onChange: () => void | Promise<void>,
}): Promise<ChatGenerationResult> {
  const state = createAssistantGeneration({ node });
  const failures: unknown[] = [];
  const waiting = new Set<ReturnType<typeof Promise.withResolvers<never>>['reject']>();
  const children = new Set<Promise<void>>();
  let mutations = Promise.resolve();
  let result: ChatGenerationResult | undefined;

  function fail({ error }: { error: unknown }): void {
    if (!failures.includes(error)) failures.push(error);
    for (const reject of waiting) reject(error);
    waiting.clear();
    // Callback failures and protocol violations abandon this run. A user stop
    // alone does not enter this path: its accepted contents still need draining.
    if (!abortController.signal.aborted) abortController.abort(error);
  }

  // Unlike racing every token against one never-settled Promise, this retains
  // handlers only for reads currently in flight, not for the entire transcript.
  function waitFor<T>({ pending }: { pending: PromiseLike<T> }): Promise<T> {
    return new Promise((resolve, reject) => {
      waiting.add(reject);
      Promise.resolve(pending).then(
        value => {
          waiting.delete(reject); resolve(value);
        },
        error => {
          waiting.delete(reject); reject(error);
        },
      );
      if (failures.length !== 0) {
        waiting.delete(reject);
        reject(failures[0]);
      }
    });
  }

  function apply({ change }: { change: () => void }): Promise<void> {
    const pending = mutations.then(async () => {
      if (failures.length !== 0) throw failures[0];
      change();
      await waitFor({ pending: Promise.resolve(onChange()) });
    });
    mutations = pending.catch(error => {
      fail({ error });
    });
    return pending;
  }

  async function consumePart({ partId, index, type, chunks, completeness }: Extract<ChatGenerationItem, { type: 'text' | 'reasoning' }>): Promise<void> {
    // Attach a handler at receipt, not after the child has drained. Producers also
    // own rejection handlers for any child descriptors not yet handed to us.
    const finalState = completeness.then(
      value => ({ type: 'value' as const, value }),
      error => {
        fail({ error }); return { type: 'failure' as const, error };
      },
    );
    const iterator = chunks[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      await apply({ change: () => state.beginPart({ partId, index, type }) });
      while (true) {
        const next = await waitFor({ pending: iterator.next() });
        if (next.done) {
          exhausted = true; break;
        }
        const text = next.value;
        await apply({ change: () => state.appendText({ partId, text }) });
      }
      const end = await waitFor({ pending: finalState });
      switch (end.type) {
      case 'value':
        await apply({ change: () => state.closePart({ partId, completeness: end.value }) });
        return;
      case 'failure': throw end.error;
      default: {
        const _ex: never = end;
        throw new Error(`Unhandled child completion: ${_ex}`);
      }
      }
    } catch (error) {
      fail({ error });
    } finally {
      if (!exhausted && iterator.return) {
        try {
          await iterator.return();
        } catch (error) {
          fail({ error });
        }
      }
    }
  }

  const iterator = items[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    while (true) {
      const next = await waitFor({ pending: iterator.next() });
      if (next.done) {
        exhausted = true; break;
      }
      const item = next.value;
      // Claim a child's completeness even when its descriptor violates the order.
      if (result !== undefined) {
        switch (item.type) {
        case 'text':
        case 'reasoning': void item.completeness.catch(error => {
          fail({ error });
        }); break;
        case 'tool_call':
        case 'result': break;
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled generation item: ${_ex}`);
        }
        }
        throw new Error('A generation item followed its final result.');
      }
      switch (item.type) {
      case 'text':
      case 'reasoning': {
        const { partId, index, type, chunks, completeness, ...unhandled } = item;
        unhandled satisfies Record<PropertyKey, never>;
        const child = consumePart({ partId, index, type, chunks, completeness }).catch(error => {
          fail({ error });
        });
        children.add(child);
        void child.then(() => {
          children.delete(child);
        });
        break;
      }
      case 'tool_call': {
        const { type: _type, partId, index, toolCall, ...unhandled } = item;
        unhandled satisfies Record<PropertyKey, never>;
        // Capture before awaiting other mutations: upstream may reuse its objects.
        const copy = { ...toolCall, function: { ...toolCall.function } };
        await apply({ change: () => state.addToolCall({ partId, index, toolCall: copy }) });
        break;
      }
      case 'result': {
        const { type: _type, result: value, ...unhandled } = item;
        unhandled satisfies Record<PropertyKey, never>;
        switch (value.type) {
        case 'finished': result = { type: value.type, next: value.next }; break;
        case 'interrupted': result = { type: value.type, reason: value.reason }; break;
        case 'error': result = { type: value.type, error: value.error }; break;
        default: {
          const _ex: never = value;
          throw new Error(`Unhandled generation result: ${_ex}`);
        }
        }
        break;
      }
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled generation item: ${_ex}`);
      }
      }
    }
    if (result === undefined) throw new Error('The generation closed without a result.');
  } catch (error) {
    fail({ error });
  } finally {
    if (!exhausted && iterator.return) {
      try {
        await iterator.return();
      } catch (error) {
        fail({ error });
      }
    }
    await Promise.all([...children]);
    await mutations;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Generation consumption and cleanup failed.');
  if (result === undefined) throw new Error('The generation closed without a result.');
  state.finish({ result });
  return result;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
