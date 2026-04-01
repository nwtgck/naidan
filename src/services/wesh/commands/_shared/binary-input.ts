import type { WeshCommandContext, WeshFileHandle, WeshOpenFlags } from '@/services/wesh/types';
import { resolvePath } from '@/services/wesh/path';

async function readHandleAsBytes({
  handle,
  closeWhenDone,
}: {
  handle: WeshFileHandle;
  closeWhenDone: boolean;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      const buffer = new Uint8Array(64 * 1024);
      const { bytesRead } = await handle.read({ buffer });
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.slice(0, bytesRead);
      chunks.push(chunk);
      totalLength += chunk.length;
    }
  } finally {
    if (closeWhenDone) {
      await handle.close();
    }
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function readCommandInputAsBytes({
  context,
  input,
}: {
  context: WeshCommandContext;
  input: string | undefined;
}): Promise<Uint8Array> {
  if (input === undefined || input === '-') {
    return readHandleAsBytes({
      handle: context.stdin,
      closeWhenDone: false,
    });
  }

  const path = resolvePath({
    cwd: context.cwd,
    path: input,
  });

  if (context.files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await context.files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob':
      return new Uint8Array(await blobResult.blob.arrayBuffer());
    case 'fallback-required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob read result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const flags: WeshOpenFlags = {
    access: 'read',
    creation: 'never',
    truncate: 'preserve',
    append: 'preserve',
  };
  const handle = await context.files.open({
    path,
    flags,
  });

  return readHandleAsBytes({
    handle,
    closeWhenDone: true,
  });
}
