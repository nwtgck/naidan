import type { WeshOpenFlags, WeshFileHandle } from '@/services/wesh/types';
import type { WeshKernel } from '@/services/wesh/kernel';

/**
 * Read the entire content of a file as a Uint8Array.
 */
export async function readFile({ kernel, path }: { kernel: WeshKernel; path: string }): Promise<Uint8Array> {
  const flags: WeshOpenFlags = {
    access: 'read',
    creation: 'never',
    truncate: 'preserve',
    append: 'preserve',
  };
  const handle = await kernel.open({ path, flags });
  try {
    const stat = await handle.stat();
    const buffer = new Uint8Array(stat.size);
    let totalRead = 0;
    while (totalRead < stat.size) {
      const { bytesRead } = await handle.read({
        buffer,
        offset: totalRead,
        length: stat.size - totalRead,
      });
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return buffer.subarray(0, totalRead);
  } finally {
    await handle.close();
  }
}

/**
 * Write the entire content of a Uint8Array to a file.
 */
export async function writeFile({
  kernel,
  path,
  data,
}: {
  kernel: WeshKernel;
  path: string;
  data: Uint8Array;
}): Promise<void> {
  const flags: WeshOpenFlags = {
    access: 'write',
    creation: 'if-needed',
    truncate: 'truncate',
    append: 'preserve',
  };
  const handle = await kernel.open({ path, flags });
  try {
    let totalWritten = 0;
    while (totalWritten < data.length) {
      const { bytesWritten } = await handle.write({
        buffer: data,
        offset: totalWritten,
        length: data.length - totalWritten,
      });
      totalWritten += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Check if a file or directory exists.
 */
export async function exists({ kernel, path }: { kernel: WeshKernel; path: string }): Promise<boolean> {
  try {
    await kernel.stat({ path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a WeshFileHandle to a ReadableStream<Uint8Array>.
 */
export function handleToStream({
  handle,
  chunkSize = 64 * 1024,
}: {
  handle: WeshFileHandle;
  chunkSize?: number;
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const buffer = new Uint8Array(chunkSize);
      try {
        const { bytesRead } = await handle.read({ buffer });
        if (bytesRead === 0) {
          await handle.close();
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
      } catch (e) {
        await handle.close();
        controller.error(e);
      }
    },
    async cancel() {
      await handle.close();
    },
  });
}

/**
 * Write a ReadableStream<Uint8Array> to a WeshFileHandle.
 */
export async function streamToHandle({
  stream,
  handle,
}: {
  stream: ReadableStream<Uint8Array>;
  handle: WeshFileHandle;
}): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      let written = 0;
      while (written < value.length) {
        const { bytesWritten } = await handle.write({
          buffer: value,
          offset: written,
          length: value.length - written,
        });
        written += bytesWritten;
      }
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
}
