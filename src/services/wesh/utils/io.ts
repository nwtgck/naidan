import type { WeshFileHandle } from '@/services/wesh/types';

export function createTextHelpers({
  stdin,
  stdout,
  stderr,
}: {
  stdin: WeshFileHandle;
  stdout: WeshFileHandle;
  stderr: WeshFileHandle;
}) {
  const encoder = new TextEncoder();

  // Async Iterable for reading lines from stdin
  const inputIterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      const decoder = new TextDecoder();
      let buffer = '';
      const readBuf = new Uint8Array(4096); // 4KB buffer

      while (true) {
        const { bytesRead } = await stdin.read({ buffer: readBuf });
        if (bytesRead === 0) break; // EOF

        const chunk = readBuf.subarray(0, bytesRead);
        buffer += decoder.decode(chunk, { stream: true });

        if (buffer.includes('\n')) {
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? ''; // Keep the last partial line

          for (const line of lines) {
            yield line;
          }
        }
      }

      // Final flush
      if (buffer !== '') {
        yield buffer;
      }
    }
  };

  return {
    input: inputIterable,
    async print({ text }: { text: string }): Promise<void> {
      const data = encoder.encode(text);
      await stdout.write({ buffer: data });
    },

    async error({ text }: { text: string }): Promise<void> {
      const data = encoder.encode(text);
      await stderr.write({ buffer: data });
    },
  };
}
