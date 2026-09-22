import type { ChatGenerationItem, ChatGenerationResult } from '@/01-models/lm';
import type { ToolCall } from '@/01-models/types';
import { createAsyncChannel } from '@/utils/async-channel';

export interface ChatGenerationWriter {
  finishTextPart({ completeness }: { completeness: 'complete' | 'partial' }): void,
  text({ type, text }: { type: 'text' | 'reasoning', text: string }): Promise<void>,
  reserveCall({ key }: { key: number }): void,
  call({ key, toolCall }: { key: number, toolCall: ToolCall }): Promise<void>,
}

/** Bridges one producer to the local nested API, without exporting a queue to a Worker. */
export function createChatGenerationStream({ signal, run }: {
  signal: AbortSignal | undefined,
  run: ({ writer, signal }: { writer: ChatGenerationWriter, signal: AbortSignal }) => Promise<ChatGenerationResult>,
}): AsyncIterable<ChatGenerationItem> {
  let claimed = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<ChatGenerationItem> {
      if (claimed) throw new Error('A generation stream can only be consumed once.');
      claimed = true;
      const controller = new AbortController();
      let phase: 'idle' | 'running' | 'finished' | 'abandoned' = 'idle';
      let index = 0;
      let active: {
        type: 'text' | 'reasoning',
        channel: ReturnType<typeof createAsyncChannel<string>>,
        completeness: ReturnType<typeof Promise.withResolvers<'complete' | 'partial'>>,
      } | undefined;
      const children = new Set<ReturnType<typeof createAsyncChannel<string>>>();
      let childSpace: ReturnType<typeof Promise.withResolvers<void>> | undefined;
      const reservations = new Map<number, { partId: string, index: number, status: 'pending' | 'complete' }>();
      function closeText({ completeness }: { completeness: 'complete' | 'partial' }): void {
        if (!active) return;
        active.channel.close();
        active.completeness.resolve(completeness);
        active = undefined;
      }
      function isAbandoned(): boolean {
        switch (phase) {
        case 'abandoned': return true;
        case 'idle':
        case 'running':
        case 'finished': return false;
        default: { const _ex: never = phase; throw new Error(`Unhandled generation phase: ${_ex}`); }
        }
      }
      function requireRunning(): void {
        switch (phase) {
        case 'running': return;
        case 'idle':
        case 'finished':
        case 'abandoned': throw new Error('Generation is no longer writable.');
        default: { const _ex: never = phase; throw new Error(`Unhandled generation phase: ${_ex}`); }
        }
      }
      function abandon(): void {
        if (isAbandoned()) return;
        phase = 'abandoned';
        controller.abort(new Error('Generation consumption was abandoned.'));
        closeText({ completeness: 'partial' });
        for (const child of children) child.cancel();
        children.clear();
        childSpace?.resolve(); childSpace = undefined;
        outer.cancel();
      }
      const outer = createAsyncChannel<ChatGenerationItem>({ capacity: 16, onCancel: abandon });
      const iterator = outer.values[Symbol.asyncIterator]();
      const writer: ChatGenerationWriter = {
        finishTextPart({ completeness }): void {
          requireRunning();
          if (!active) throw new Error('No text part is open.');
          closeText({ completeness });
        },
        async text({ type, text }): Promise<void> {
          requireRunning();
          if (!active || active.type !== type) {
            closeText({ completeness: 'complete' });
            // Completed but unread children count toward one shared bound as well.
            while (children.size >= 16) {
              childSpace ??= Promise.withResolvers<void>();
              await childSpace.promise;
              requireRunning();
            }
            const channel = createAsyncChannel<string>({ capacity: 16, onCancel: abandon });
            children.add(channel);
            const completeness = Promise.withResolvers<'complete' | 'partial'>();
            // These promises resolve on every exit, including abandonment.
            active = { type, channel, completeness };
            const position = index++;
            const values = channel.values;
            const chunks: AsyncIterable<string> = {
              async *[Symbol.asyncIterator]() {
                try {
                  yield* values;
                } finally {
                  children.delete(channel);
                  childSpace?.resolve(); childSpace = undefined;
                }
              },
            };
            await outer.send({ value: { type, partId: `part_${position}`, index: position, chunks, completeness: completeness.promise } });
          }
          const channel = active.channel;
          // Bound stored text as well as the number of queue entries. Chunk cuts
          // are transport boundaries, never token or semantic boundaries.
          if (text.length === 0) await channel.send({ value: '' });
          for (let offset = 0; offset < text.length; offset += 8192) {
            await channel.send({ value: text.slice(offset, offset + 8192) });
          }
        },
        reserveCall({ key }): void {
          requireRunning();
          if (reservations.has(key)) return;
          closeText({ completeness: 'complete' });
          const position = index++;
          reservations.set(key, { partId: `part_${position}`, index: position, status: 'pending' });
        },
        async call({ key, toolCall }): Promise<void> {
          writer.reserveCall({ key });
          const position = reservations.get(key)!;
          switch (position.status) {
          case 'pending': break;
          case 'complete': throw new Error('A tool call was published twice.');
          default: { const _ex: never = position.status; throw new Error(`Unhandled call phase: ${_ex}`); }
          }
          // Copy before awaiting delivery; parsers may still own their mutable draft.
          const copy: ToolCall = { ...toolCall, function: { ...toolCall.function } };
          await outer.send({ value: { type: 'tool_call', partId: position.partId, index: position.index, toolCall: copy } });
          position.status = 'complete';
        },
      };
      const onAbort = () => controller.abort(signal?.reason);
      let producer: Promise<void> | undefined;
      async function produce(): Promise<void> {
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        let result: ChatGenerationResult;
        try {
          result = controller.signal.aborted
            ? { type: 'interrupted', reason: 'aborted' }
            : await run({ writer, signal: controller.signal });
        } catch (error) {
          result = controller.signal.aborted
            ? { type: 'interrupted', reason: 'aborted' }
            : { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
        // Cancellation of the consumer discards content; ordinary signal abort does not.
        if (isAbandoned()) return;
        let completeness: 'complete' | 'partial';
        switch (result.type) {
        case 'finished':
          if ([...reservations.values()].some(call => call.status === 'pending')) {
            result = { type: 'interrupted', reason: 'unknown' };
            completeness = 'partial';
          } else completeness = 'complete';
          break;
        case 'interrupted':
        case 'error': completeness = 'partial'; break;
        default: { const _ex: never = result; throw new Error(`Unhandled result: ${_ex}`); }
        }
        closeText({ completeness });
        phase = 'finished';
        try {
          await outer.send({ value: { type: 'result', result } });
        } finally {
          outer.close();
        }
      }
      return {
        async next(): Promise<IteratorResult<ChatGenerationItem>> {
          switch (phase) {
          case 'idle': {
            phase = 'running';
            // Own failures even if no subsequent next() observes the producer.
            producer = produce().catch(() => {
              abandon();
            });
            break;
          }
          case 'running':
          case 'finished':
          case 'abandoned': break;
          default: { const _ex: never = phase; throw new Error(`Unhandled generation phase: ${_ex}`); }
          }
          return iterator.next();
        },
        async return(): Promise<IteratorResult<ChatGenerationItem>> {
          abandon();
          await producer;
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
