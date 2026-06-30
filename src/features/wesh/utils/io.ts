import type { WeshFileHandle } from '@/features/wesh/types';
import { openHandleReadStream } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { iterateUtf8Lines } from '@/features/wesh/utils/text-records';

async function writeAllTextToHandle({
  handle,
  text,
  encoder,
}: {
  handle: WeshFileHandle,
  text: string,
  encoder: TextEncoder,
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
  handle: WeshFileHandle,
  maxBufferLength: number,
}) {
  const encoder = new TextEncoder();
  let chunks: string[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }

    const text = chunks.join('');
    chunks = [];
    bufferedLength = 0;
    await writeAllTextToHandle({
      handle,
      text,
      encoder,
    });
  };

  return {
    async write({
      text,
    }: {
      text: string,
    }): Promise<void> {
      chunks.push(text);
      bufferedLength += text.length;
      if (bufferedLength < maxBufferLength) {
        return;
      }

      await flush();
    },
    flush,
  };
}

export function createTextIoHelpers({
  stdin,
  stdout,
  stderr,
}: {
  stdin: WeshFileHandle,
  stdout: WeshFileHandle,
  stderr: WeshFileHandle,
}) {
  const encoder = new TextEncoder();

  const inputIterable = (async function* (): AsyncIterable<string> {
    yield* iterateUtf8Lines({
      chunks: iterateReadableStreamChunks({
        stream: openHandleReadStream({
          handle: stdin,
          chunkSize: 4096,
        }),
      }),
    });
  })();

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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
