import type { WeshFileHandle } from '@/services/wesh/types';

async function writeAllTextToHandle({
  handle,
  text,
}: {
  handle: WeshFileHandle;
  text: string;
}): Promise<void> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  let totalWritten = 0;

  while (totalWritten < data.length) {
    const { bytesWritten } = await handle.write({
      buffer: data,
      offset: totalWritten,
      length: data.length - totalWritten,
    });
    if (bytesWritten === 0) {
      return;
    }
    totalWritten += bytesWritten;
  }
}

export function createTextIoHelpers({
  stdin,
  stdout,
  stderr,
}: {
  stdin: WeshFileHandle;
  stdout: WeshFileHandle;
  stderr: WeshFileHandle;
}) {
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
      await writeAllTextToHandle({
        handle: stdout,
        text,
      });
    },

    async error({ text }: { text: string }): Promise<void> {
      await writeAllTextToHandle({
        handle: stderr,
        text,
      });
    },
  };
}
