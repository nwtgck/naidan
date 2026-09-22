/** Decode one UTF-8 stream without treating transport chunks as character boundaries. */
export async function* readStreamLines({ stream, signal, maxLineLength }: {
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxLineLength: number,
}): AsyncGenerator<string, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let ended = false;
  let cancellation: Promise<void> | undefined;
  const onAbort = () => {
    cancellation ??= reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // CRLF and LF are framing, never the escaped text inside a JSON field.
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        if (newline > maxLineLength) throw new Error('The response line exceeds the supported size.');
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
        signal.throwIfAborted();
      }
      if (buffer.length > maxLineLength) throw new Error('The response line exceeds the supported size.');
      if (done) {
        ended = true; break;
      }
    }
    if (buffer !== '') yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!ended) await reader.cancel().catch(() => {});
    await cancellation;
    reader.releaseLock();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
