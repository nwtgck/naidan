import { materializeStorageBinaryObjectAsBlob } from '@/00-storage/service/binary-object-io';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';

export type NaidanOpfsLayoutEntryHandle =
  | NaidanOpfsLayoutFileHandle
  | NaidanOpfsLayoutDirectoryHandle;

export class NaidanOpfsLayoutFileHandle {
  constructor({ handle }: {
    handle: StorageFileHandle;
  }) {
    this.handle = handle;
    this.name = handle.name;
  }

  readonly kind = 'file' as const;
  readonly name: string;
  readonly handle: StorageFileHandle;

  async getFile(): Promise<File> {
    const readable = await this.handle.openReadable({ mimeType: 'application/octet-stream' });
    try {
      const blob = await materializeStorageBinaryObjectAsBlob({ handle: readable });
      const stat = await this.handle.stat();
      if (isFileLike(blob) && blob.name === this.name) {
        return blob;
      }
      return new File([await blob.arrayBuffer()], this.name, {
        type: blob.type,
        lastModified: stat.modifiedAt ?? Date.now(),
      });
    } finally {
      await readable.close();
    }
  }

  async createWritable(): Promise<NaidanOpfsLayoutWritableFile> {
    return new NaidanOpfsLayoutWritableFile({
      writable: await this.handle.createWritable({ keepExistingData: false }),
    });
  }
}

export class NaidanOpfsLayoutWritableFile {
  constructor({ writable }: {
    writable: StorageWritableFile;
  }) {
    this.writable = writable;
  }

  private readonly writable: StorageWritableFile;
  private position = 0;
  private settled = false;

  // This compatibility adapter intentionally mirrors FileSystemWritableFileStream.write().
  // eslint-disable-next-line local-rules-named-args/require-named-args
  async write(value: string | Blob | BufferSource): Promise<void> {
    this.assertOpen();
    const bytes = await toBytes({ value });
    await this.writable.write({ position: this.position, data: bytes });
    this.position += bytes.byteLength;
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.settled = true;
    await this.writable.close();
  }

  async abort({ reason }: {
    reason: unknown;
  }): Promise<void> {
    if (this.settled) {
      return;
    }
    this.settled = true;
    await this.writable.abort({ reason });
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new Error('Naidan OPFS layout writer is already closed or aborted');
    }
  }
}

export class NaidanOpfsLayoutDirectoryHandle {
  constructor({ handle }: {
    handle: StorageDirectoryHandle;
  }) {
    this.handle = handle;
    this.name = handle.name;
  }

  readonly kind = 'directory' as const;
  readonly name: string;
  readonly handle: StorageDirectoryHandle;

  // This compatibility adapter intentionally mirrors FileSystemDirectoryHandle.getFileHandle().
  // eslint-disable-next-line local-rules-named-args/require-named-args
  async getFileHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<NaidanOpfsLayoutFileHandle> {
    return new NaidanOpfsLayoutFileHandle({
      handle: await this.handle.getFileHandle({
        name,
        create: options?.create ?? false,
      }),
    });
  }

  // This compatibility adapter intentionally mirrors FileSystemDirectoryHandle.getDirectoryHandle().
  // eslint-disable-next-line local-rules-named-args/require-named-args
  async getDirectoryHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<NaidanOpfsLayoutDirectoryHandle> {
    return new NaidanOpfsLayoutDirectoryHandle({
      handle: await this.handle.getDirectoryHandle({
        name,
        create: options?.create ?? false,
      }),
    });
  }

  async *values(): AsyncIterable<NaidanOpfsLayoutEntryHandle> {
    for await (const [, handle] of this.handle.entries()) {
      const wrapped = wrapEntry({ handle });
      if (wrapped !== undefined) {
        yield wrapped;
      }
    }
  }

  async *keys(): AsyncIterable<string> {
    for await (const [name] of this.handle.entries()) {
      yield name;
    }
  }

  // This compatibility adapter intentionally mirrors FileSystemDirectoryHandle.removeEntry().
  // eslint-disable-next-line local-rules-named-args/require-named-args
  async removeEntry(
    name: string,
    options?: { readonly recursive?: boolean },
  ): Promise<void> {
    await this.handle.removeEntry({
      name,
      recursive: options?.recursive ?? false,
    });
  }
}


function isFileLike(value: Blob): value is File {
  const candidate = value as Blob & Partial<Pick<File, 'name' | 'lastModified'>>;
  return typeof candidate.name === 'string'
    && typeof candidate.lastModified === 'number';
}

function wrapEntry({ handle }: {
  handle: StorageEntryHandle;
}): NaidanOpfsLayoutEntryHandle | undefined {
  switch (handle.kind) {
  case 'file':
    return new NaidanOpfsLayoutFileHandle({ handle });
  case 'directory':
    return new NaidanOpfsLayoutDirectoryHandle({ handle });
  case 'symlink':
    return undefined;
  default: {
    const _ex: never = handle;
    throw new Error(`Unhandled storage entry handle: ${String(_ex)}`);
  }
  }
}

async function toBytes({ value }: {
  value: string | Blob | BufferSource;
}): Promise<Uint8Array> {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return new Uint8Array(value.slice(0));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
