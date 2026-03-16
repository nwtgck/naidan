export function createTextHelpers({
  stdin,
  stdout,
  stderr,
}: {
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}) {
  const encoder = new TextEncoder();

  const inputIterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      const reader = stdin.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          // Keep the last partial line in the buffer
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            yield line;
          }
        }
        // After EOF, if there's anything left in buffer, yield it
        if (buffer !== '') {
          yield buffer;
        }
      } finally {
        reader.releaseLock();
      }
    }
  };

  return {
    input: inputIterable,

    async print({ text }: { text: string }): Promise<void> {
      const writer = stdout.getWriter();
      try {
        await writer.ready;
        await writer.write(encoder.encode(text));
      } finally {
        writer.releaseLock();
      }
    },

    async error({ text }: { text: string }): Promise<void> {
      const writer = stderr.getWriter();
      try {
        await writer.ready;
        await writer.write(encoder.encode(text));
      } finally {
        writer.releaseLock();
      }
    },
  };
}
