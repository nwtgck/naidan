import type { AssistantMessageNode } from '@/01-models/types';
import type { ChatGenerationItem, ChatGenerationResult, ToolCallDraft } from '@/01-models/lm';
import { createAssistantGeneration } from '@/01-models/assistant-generation';

/**
 * Owns one local generation stream. Children run concurrently to avoid blocking
 * an interleaved upstream, while mutations and their acknowledgments are ordered.
 * Ordinary signal cancellation stops the producer, not this consumer's drain.
 * The producer must settle pending reads when aborted, including worker loss.
 */
export async function consumeChatGeneration({ node, items, abortController, onChange, onToolCallDraftsChange }: {
  node: AssistantMessageNode,
  items: AsyncIterable<ChatGenerationItem>,
  abortController: AbortController,
  onChange: () => void | Promise<void>,
  onToolCallDraftsChange: (({ drafts }: { drafts: readonly ToolCallDraft[] }) => void) | undefined,
}): Promise<ChatGenerationResult> {
  const state = createAssistantGeneration({ node });
  const failures: unknown[] = [];
  const waiting = new Set<ReturnType<typeof Promise.withResolvers<never>>['reject']>();
  const children = new Set<Promise<void>>();
  let mutations = Promise.resolve();
  let result: ChatGenerationResult | undefined;
  const positions = new Map<string, { index: number, type: 'text' | 'reasoning' | 'tool_call_draft' | 'tool_call' }>();
  const indices = new Map<number, string>();
  const drafts = new Map<string, ToolCallDraft>();

  function register({ partId, index, type }: { partId: string, index: number, type: 'text' | 'reasoning' | 'tool_call_draft' | 'tool_call' }): void {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid generated part position.');
    const previous = positions.get(partId);
    if (previous !== undefined) {
      if (previous.index !== index || previous.type !== 'tool_call_draft' || (type !== 'tool_call_draft' && type !== 'tool_call')) {
        throw new Error('Duplicate or inconsistent generated part.');
      }
    } else if (indices.has(index)) throw new Error('Invalid or duplicate generated part position.');
    positions.set(partId, { index, type });
    indices.set(index, partId);
  }

  function publishDrafts(): void {
    if (onToolCallDraftsChange === undefined) return;
    const materialized = [...positions.values()].filter(position => position.type !== 'tool_call_draft');
    onToolCallDraftsChange({ drafts: [...drafts.values()].sort((left, right) => left.index - right.index).map(draft => ({
      ...draft,
      beforePartIndex: materialized.filter(position => position.index < draft.index).length,
    })) });
  }

  function clearDrafts(): void {
    if (drafts.size === 0) return;
    drafts.clear();
    publishDrafts();
  }

  function abortDrafts(): void {
    try {
      clearDrafts();
    } catch (error) {
      fail({ error });
    }
  }

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

  function apply({ change, persistence }: { change: () => void, persistence: 'history' | 'transient' }): Promise<void> {
    const pending = mutations.then(async () => {
      if (failures.length !== 0) throw failures[0];
      change();
      switch (persistence) {
      case 'history': await waitFor({ pending: Promise.resolve(onChange()) }); break;
      case 'transient': break;
      default: { const _ex: never = persistence; throw new Error(`Unhandled persistence mode: ${_ex}`); }
      }
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
      await apply({ persistence: 'history', change: () => {
        register({ partId, index, type });
        state.beginPart({ partId, index, type });
        if (drafts.size !== 0) publishDrafts();
      } });
      while (true) {
        const next = await waitFor({ pending: iterator.next() });
        if (next.done) {
          exhausted = true; break;
        }
        const text = next.value;
        await apply({ persistence: 'history', change: () => state.appendText({ partId, text }) });
      }
      const end = await waitFor({ pending: finalState });
      switch (end.type) {
      case 'value':
        await apply({ persistence: 'history', change: () => state.closePart({ partId, completeness: end.value }) });
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
  abortController.signal.addEventListener('abort', abortDrafts, { once: true });
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
        case 'tool_call_draft':
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
        await apply({ persistence: 'history', change: () => {
          register({ partId, index, type: 'tool_call' });
          state.addToolCall({ partId, index, toolCall: copy });
          const removed = drafts.delete(partId);
          if (removed || drafts.size !== 0) publishDrafts();
        } });
        break;
      }
      case 'tool_call_draft': {
        const { type, partId, index, name, arguments: update, ...unhandled } = item;
        unhandled satisfies Record<PropertyKey, never>;
        const patch = update === undefined ? undefined : { ...update };
        await apply({ persistence: 'transient', change: () => {
          register({ partId, index, type });
          // An ordinary stop still drains accepted completed content, but a
          // retired draft must never reappear while that drain is in progress.
          if (abortController.signal.aborted) return;
          const previous = drafts.get(partId);
          let argumentsText = previous?.arguments ?? '';
          if (patch !== undefined) {
            if (!Number.isSafeInteger(patch.offset) || patch.offset < 0 || patch.offset > argumentsText.length) {
              throw new Error('Invalid tool call draft argument offset.');
            }
            argumentsText = argumentsText.slice(0, patch.offset) + patch.text;
          }
          drafts.set(partId, { partId, index, name: name ?? previous?.name ?? '', arguments: argumentsText, beforePartIndex: 0 });
          publishDrafts();
        } });
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
        if (value.type === 'finished' && [...positions.values()].some(position => position.type === 'tool_call_draft')) {
          throw new Error('A successful generation cannot leave an unfinished tool call draft.');
        }
        clearDrafts();
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
    abortController.signal.removeEventListener('abort', abortDrafts);
    try {
      clearDrafts();
    } catch (error) {
      fail({ error });
    }
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
