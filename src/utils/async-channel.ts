/** A single-reader channel. Producers await send to respect its bounded queue. */
export function createAsyncChannel<T>({ capacity, onCancel }: {
  capacity: number,
  onCancel: () => void,
}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid channel capacity.');
  const queue: T[] = [];
  let phase: 'open' | 'closed' | 'cancelled' = 'open';
  let readerClaimed = false;
  let read: ReturnType<typeof Promise.withResolvers<IteratorResult<T>>> | undefined;
  let room: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const end = (): IteratorReturnResult<undefined> => ({ done: true, value: undefined });
  function isOpen(): boolean {
    switch (phase) {
    case 'open': return true;
    case 'closed':
    case 'cancelled': return false;
    default: { const _ex: never = phase; throw new Error(`Unhandled channel phase: ${_ex}`); }
    }
  }
  function cancel(): void {
    switch (phase) {
    case 'cancelled': return;
    case 'open':
    case 'closed': break;
    default: { const _ex: never = phase; throw new Error(`Unhandled channel phase: ${_ex}`); }
    }
    phase = 'cancelled';
    queue.length = 0;
    read?.resolve(end()); read = undefined;
    room?.resolve(); room = undefined;
    onCancel();
  }
  return {
    async send({ value }: { value: T }): Promise<void> {
      while (isOpen() && queue.length >= capacity) {
        room ??= Promise.withResolvers<void>();
        await room.promise;
      }
      if (!isOpen()) throw new Error('Cannot send to a closed channel.');
      if (read) {
        const pending = read; read = undefined;
        pending.resolve({ done: false, value });
      } else queue.push(value);
    },
    close(): void {
      if (!isOpen()) return;
      phase = 'closed';
      read?.resolve(end()); read = undefined;
      room?.resolve(); room = undefined;
    },
    cancel,
    values: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        if (readerClaimed) throw new Error('This channel has already been consumed.');
        readerClaimed = true;
        return {
          async next(): Promise<IteratorResult<T>> {
            if (queue.length !== 0) {
              const value = queue.shift()!;
              room?.resolve(); room = undefined;
              return { done: false, value };
            }
            if (!isOpen()) return end();
            if (read) throw new Error('Concurrent reads from one channel are not supported.');
            read = Promise.withResolvers<IteratorResult<T>>();
            return read.promise;
          },
          async return(): Promise<IteratorResult<T>> {
            cancel(); return end();
          },
        };
      },
    } satisfies AsyncIterable<T>,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
