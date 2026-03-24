import type {
  WeshOpenFlags,
  WeshFileHandle,
  WeshEfficientFileWriteResult,
  WeshEfficientBlobReadResult,
} from '@/services/wesh/types';

interface WeshFileCapabilities {
  open(options: { path: string; flags: WeshOpenFlags; mode?: number }): Promise<WeshFileHandle>;
  stat(options: { path: string }): Promise<unknown>;
  tryReadBlobEfficiently?(options: { path: string }): Promise<WeshEfficientBlobReadResult>;
  tryCreateFileWriterEfficiently?(options: {
    path: string;
    mode: 'truncate' | 'append';
  }): Promise<WeshEfficientFileWriteResult>;
}

/**
 * Read the entire content of a file as a Uint8Array.
 */
export async function readFile({ files, path }: { files: WeshFileCapabilities; path: string }): Promise<Uint8Array> {
  if (files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob':
      return new Uint8Array(await blobResult.blob.arrayBuffer());
    case 'fallback-required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const flags: WeshOpenFlags = {
    access: 'read',
    creation: 'never',
    truncate: 'preserve',
    append: 'preserve',
  };
  const handle = await files.open({ path, flags });
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
 * Read the entire content of a file as a UTF-8 string.
 */
export async function readFileAsText({ files, path }: { files: WeshFileCapabilities; path: string }): Promise<string> {
  if (files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob':
      return blobResult.blob.text();
    case 'fallback-required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return new TextDecoder().decode(await readFile({ files, path }));
}

/**
 * Write the entire content of a Uint8Array to a file.
 */
export async function writeFile({
  files,
  path,
  data,
}: {
  files: WeshFileCapabilities;
  path: string;
  data: Uint8Array;
}): Promise<void> {
  const flags: WeshOpenFlags = {
    access: 'write',
    creation: 'if-needed',
    truncate: 'truncate',
    append: 'preserve',
  };
  const handle = await files.open({ path, flags });
  try {
    let totalWritten = 0;
    while (totalWritten < data.length) {
      const { bytesWritten } = await handle.write({
        buffer: data,
        offset: totalWritten,
        length: data.length - totalWritten,
      });
      if (bytesWritten === 0) {
        break;
      }
      totalWritten += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Check if a file or directory exists.
 */
export async function exists({ files, path }: { files: WeshFileCapabilities; path: string }): Promise<boolean> {
  try {
    await files.stat({ path });
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
        if (bytesWritten === 0) {
          return;
        }
        written += bytesWritten;
      }
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
}

export async function streamToFilePath({
  files,
  path,
  stream,
  mode,
}: {
  files: WeshFileCapabilities;
  path: string;
  stream: ReadableStream<Uint8Array>;
  mode: 'truncate' | 'append';
}): Promise<void> {
  const efficientWriterResult = files.tryCreateFileWriterEfficiently === undefined
    ? undefined
    : await files.tryCreateFileWriterEfficiently({
      path,
      mode,
    });

  switch (efficientWriterResult?.kind) {
  case 'writer': {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        await efficientWriterResult.writer.write({
          chunk: value,
        });
      }
      await efficientWriterResult.writer.close();
      return;
    } catch (error: unknown) {
      await efficientWriterResult.writer.abort({
        reason: error,
      });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  case 'fallback-required':
  case undefined:
    break;
  default: {
    const _ex: never = efficientWriterResult;
    throw new Error(`Unhandled efficient writer result: ${JSON.stringify(_ex)}`);
  }
  }

  const fallbackFlags = (() => {
    switch (mode) {
    case 'truncate':
      return {
        access: 'write',
        creation: 'if-needed',
        truncate: 'truncate',
        append: 'preserve',
      } satisfies WeshOpenFlags;
    case 'append':
      return {
        access: 'write',
        creation: 'if-needed',
        truncate: 'preserve',
        append: 'append',
      } satisfies WeshOpenFlags;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled stream-to-path mode: ${_ex}`);
    }
    }
  })();

  const handle = await files.open({
    path,
    flags: fallbackFlags,
  });
  await streamToHandle({
    stream,
    handle,
  });
}
