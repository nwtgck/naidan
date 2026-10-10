import { openSyncAccess } from './sync-access';

export type DownloadFileAccess = {
  checkpointMode: 'periodic' | 'on-close',
  getSize(): number,
  truncate({ size }: { size: number }): Promise<void>,
  write({ bytes, at }: { bytes: Uint8Array<ArrayBuffer>, at: number }): Promise<number>,
  flush(): Promise<void>,
  close(): Promise<void>,
};

export async function openDownloadAccess({ handle, kind, offset }: {
  handle: FileSystemFileHandle, kind: 'opfs' | 'host', offset: number,
}): Promise<DownloadFileAccess> {
  switch (kind) {
  case 'opfs': {
    const access = await openSyncAccess({ handle });
    return {
      checkpointMode: 'periodic',
      getSize: () => access.getSize(),
      async truncate({ size }) {
        access.truncate(size);
      },
      async write({ bytes, at }) {
        return access.write(bytes, { at });
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
    let writer: FileSystemWritableFileStream | undefined; let closed = false;
    let failure: { error: unknown } | undefined;
    async function writable(): Promise<FileSystemWritableFileStream> {
      if (closed) throw new Error('Model writer is closed');
      writer ??= await handle.createWritable({ keepExistingData: offset > 0 }); return writer;
    }
    async function close(): Promise<void> {
      if (failure) throw failure.error;
      if (writer) {
        const current = writer; writer = undefined;
        try {
          await current.close();
        } catch (error) {
          failure = { error }; await current.abort().catch(() => undefined); throw error;
        }
      }
      closed = true;
    }
    return {
      checkpointMode: 'on-close',
      getSize: () => snapshot.size,
      async truncate({ size }) {
        await (await writable()).truncate(size);
      },
      async write({ bytes, at }) {
        await (await writable()).write({ type: 'write', position: at, data: bytes }); return bytes.length;
      },
      // Only closed host streams are durable. Periodic reopen would repeatedly
      // copy the prefix; pause/finish publish one checkpoint instead.
      flush: close,
      close,
    };
  }
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
};
