import { concatBytes } from './bytes';

async function collectStream({ stream }: { stream: ReadableStream<Uint8Array> }): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes({ chunks });
}

async function transformZlib({ bytes, mode }: {
  bytes: Uint8Array,
  mode: 'compress' | 'decompress',
}): Promise<Uint8Array> {
  const transform = (() => {
    switch (mode) {
    case 'compress':
      return new CompressionStream('deflate');
    case 'decompress':
      return new DecompressionStream('deflate');
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled zlib transform mode: ${_ex}`);
    }
    }
  })();
  const writer = transform.writable.getWriter();
  const ownedBytes: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const writePromise = (async () => {
    try {
      await writer.write(ownedBytes);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  })();
  const output = await collectStream({ stream: transform.readable });
  await writePromise;
  return output;
}

export async function deflateZlib({ bytes }: { bytes: Uint8Array }): Promise<Uint8Array> {
  return transformZlib({ bytes, mode: 'compress' });
}

export async function inflateZlib({ bytes }: { bytes: Uint8Array }): Promise<Uint8Array> {
  return transformZlib({ bytes, mode: 'decompress' });
}

export const TEST_ONLY = {
};
