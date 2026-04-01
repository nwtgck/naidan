import type { WeshFileHandle } from '@/services/wesh/types';

async function writeAllTextToHandle({
  handle,
  text,
  encoder,
}: {
  handle: WeshFileHandle;
  text: string;
  encoder: TextEncoder;
}): Promise<void> {
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

export function createBufferedTextWriter({
  handle,
  maxBufferLength,
}: {
  handle: WeshFileHandle;
  maxBufferLength: number;
}) {
  const encoder = new TextEncoder();
  let buffer = '';

  return {
    async write({
      text,
    }: {
      text: string;
    }): Promise<void> {
      buffer += text;
      if (buffer.length < maxBufferLength) {
        return;
      }

      await writeAllTextToHandle({
        handle,
        text: buffer,
        encoder,
      });
      buffer = '';
    },
    async flush(): Promise<void> {
      if (buffer.length === 0) {
        return;
      }

      await writeAllTextToHandle({
        handle,
        text: buffer,
        encoder,
      });
      buffer = '';
    },
  };
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
      await writeAllTextToHandle({
        handle: stdout,
        text,
        encoder,
      });
    },

    async error({ text }: { text: string }): Promise<void> {
      await writeAllTextToHandle({
        handle: stderr,
        text,
        encoder,
      });
    },
  };
}
