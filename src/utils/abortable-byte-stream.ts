export function createAbortableByteStream({
  stream,
  signal,
  onCancel,
}: {
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onCancel: (() => void) | undefined,
}): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let status: 'open' | 'closed' = 'open';
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  function releaseReader(): void {
    try {
      reader.releaseLock();
    } catch {
      // The reader can already be released after an overlapping cancel or completion.
    }
  }

  function cancelReader({ reason }: { reason: unknown }): void {
    // Cancellation closes the readable side immediately. Its returned promise
    // belongs to producer cleanup, which can reject or never settle. It must
    // not keep a failed save pending or replace the original sink error.
    void reader.cancel(reason).catch(() => undefined);
    releaseReader();
  }

  function removeAbortListener(): void {
    signal.removeEventListener('abort', handleAbort);
  }

  function isClosed(): boolean {
    return status === 'closed';
  }

  function handleAbort(): void {
    if (isClosed()) {
      return;
    }
    status = 'closed';
    removeAbortListener();
    const reason = signal.reason ?? new DOMException('Byte stream cancelled', 'AbortError');
    cancelReader({ reason });
    streamController?.error(reason);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort, { once: true });
    },
    async pull(controller) {
      if (isClosed()) {
        return;
      }
      try {
        const result = await reader.read();
        if (isClosed()) {
          return;
        }
        if (result.done) {
          status = 'closed';
          removeAbortListener();
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (isClosed()) {
          return;
        }
        status = 'closed';
        removeAbortListener();
        cancelReader({ reason: error });
        controller.error(error);
      }
    },
    cancel(reason) {
      if (isClosed()) {
        return;
      }
      status = 'closed';
      removeAbortListener();
      try {
        onCancel?.();
      } finally {
        cancelReader({ reason });
      }
    },
  }, { highWaterMark: 0 });
}

export const TEST_ONLY = {
};
