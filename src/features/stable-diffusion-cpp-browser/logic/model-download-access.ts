import { openSyncAccess } from '@/features/llama-cpp-browser/hugging-face/sync-access';

export type ModelDownloadAccess = {
  checkpointMode: 'periodic' | 'on-close',
  getSize(): number,
  read({ bytes, at }: { bytes: Uint8Array<ArrayBuffer>, at: number }): Promise<number>,
  write({ bytes, at }: { bytes: Uint8Array<ArrayBuffer>, at: number }): Promise<number>,
  truncate({ size }: { size: number }): Promise<void>,
  flush(): Promise<void>,
  close(): Promise<void>,
};

export async function openModelDownloadAccess({ handle, kind, offset }: {
  handle: FileSystemFileHandle, kind: 'opfs' | 'host', offset: number,
}): Promise<ModelDownloadAccess> {
  switch (kind) {
  case 'opfs': {
    const access = await openSyncAccess({ handle });
    if (!('read' in access) || typeof access.read !== 'function') {
      access.close();
      throw new Error('Random-access model verification is unavailable');
    }
    const read = access.read.bind(access);
    return {
      checkpointMode: 'periodic',
      getSize: () => access.getSize(),
      async read({ bytes, at }) {
        return read(bytes, { at });
      },
      async write({ bytes, at }) {
        return access.write(bytes, { at });
      },
      async truncate({ size }) {
        access.truncate(size);
      },
      async flush() {
        access.flush();
      },
      async close() {
        access.close();
      },
    };
  }
  case 'host': {
    const snapshot = await handle.getFile();
    let writer: FileSystemWritableFileStream | undefined;
    let closed = false;
    let closeFailure: { error: unknown } | undefined;
    async function writable(): Promise<FileSystemWritableFileStream> {
      if (closed) throw new Error('Model writer is closed');
      writer ??= await handle.createWritable({ keepExistingData: offset > 0 });
      return writer;
    }
    async function close(): Promise<void> {
      if (closeFailure) throw closeFailure.error;
      if (writer) {
        const active = writer;
        writer = undefined;
        try {
          await active.close();
        } catch (error) {
          closeFailure = { error }; await active.abort().catch(() => undefined); throw error;
        }
      }
      closed = true;
    }
    return {
      checkpointMode: 'on-close',
      getSize: () => snapshot.size,
      async read({ bytes, at }) {
        const source = new Uint8Array(await snapshot.slice(at, at + bytes.length).arrayBuffer());
        bytes.set(source); return source.length;
      },
      async write({ bytes, at }) {
        await (await writable()).write({ type: 'write', position: at, data: bytes });
        return bytes.length;
      },
      async truncate({ size }) {
        await (await writable()).truncate(size);
      },
      // Host filesystem writes become visible only on close. Reopening keepExistingData
      // can copy the full prefix, so do not create periodic host checkpoints.
      // Graceful pause commits progress; a hard crash can lose this session's suffix.
      flush: close,
      close,
    };
  }
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
};
