import {
  materializeStorageBinaryObjectAsBlob,
  runWithStorageBinaryObjectReadHandleClose,
} from '@/00-storage/service/binary-object-io';
import { promiseAllKeyed } from '@/utils/promise';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';

export type NaidanOpfsLayoutEntryHandle =
  | NaidanOpfsLayoutFileHandle
  | NaidanOpfsLayoutDirectoryHandle;

type NaidanOpfsLayoutCreateWritableOptions = {
  readonly keepExistingData?: boolean;
};

export class NaidanOpfsLayoutFileHandle {
  constructor({ handle }: {
    handle: StorageFileHandle;
  }) {
    this.handle = handle;
  }

  readonly kind = 'file' as const;
  readonly handle: StorageFileHandle;

  get name(): string {
    return this.handle.name;
  }

  async getFile(): Promise<File> {
    const readable = await this.handle.openReadable({ mimeType: 'application/octet-stream' });
    return await runWithStorageBinaryObjectReadHandleClose({
      operation: async () => {
        const { blob, stat } = await promiseAllKeyed({
          blob: materializeStorageBinaryObjectAsBlob({ handle: readable }),
          stat: this.handle.stat(),
        });
        if (isFileLike(blob) && blob.name === this.name) {
          return blob;
        }
        return new File([await blob.arrayBuffer()], this.name, {
          type: blob.type,
          lastModified: stat.modifiedAt ?? Date.now(),
        });
      },
      handle: readable,
    });
  }

  async createWritable({ keepExistingData = false }:
    NaidanOpfsLayoutCreateWritableOptions = {},
  ): Promise<NaidanOpfsLayoutWritableFile> {
    return new NaidanOpfsLayoutWritableFile({
      writable: await this.handle.createWritable({ keepExistingData }),
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
  private state: 'open' | 'settled' = 'open';

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
    this.state = 'settled';
    await this.writable.close();
  }

  async abort({ reason }: {
    reason: unknown;
  }): Promise<void> {
    switch (this.state) {
    case 'open':
      this.state = 'settled';
      await this.writable.abort({ reason });
      return;
    case 'settled':
      return;
    default: {
      const _ex: never = this.state;
      throw new Error(`Unhandled Naidan OPFS layout writer state: ${String(_ex)}`);
    }
    }
  }

  private assertOpen(): void {
    switch (this.state) {
    case 'open':
      return;
    case 'settled':
      throw new Error('Naidan OPFS layout writer is already closed or aborted');
    default: {
      const _ex: never = this.state;
      throw new Error(`Unhandled Naidan OPFS layout writer state: ${String(_ex)}`);
    }
    }
  }
}

export class NaidanOpfsLayoutDirectoryHandle {
  constructor({ handle }: {
    handle: StorageDirectoryHandle;
  }) {
    this.handle = handle;
  }

  readonly kind = 'directory' as const;
  readonly handle: StorageDirectoryHandle;

  get name(): string {
    return this.handle.name;
  }

  // This compatibility adapter intentionally mirrors FileSystemDirectoryHandle.getFileHandle().
  // eslint-disable-next-line local-rules-named-args/require-named-args
  async getFileHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<NaidanOpfsLayoutFileHandle> {
    return wrapFile({
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
    return wrapDirectory({
      handle: await this.handle.getDirectoryHandle({
        name,
        create: options?.create ?? false,
      }),
    });
  }

  async *entries(): AsyncIterable<readonly [string, NaidanOpfsLayoutEntryHandle]> {
    for await (const [name, handle] of this.handle.entries()) {
      const wrapped = wrapEntry({ handle });
      if (wrapped !== undefined) {
        yield [name, wrapped] as const;
      }
    }
  }

  async *values(): AsyncIterable<NaidanOpfsLayoutEntryHandle> {
    for await (const [, handle] of this.entries()) {
      yield handle;
    }
  }

  async *keys(): AsyncIterable<string> {
    for await (const [name] of this.entries()) {
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

function wrapFile({ handle }: {
  handle: StorageFileHandle;
}): NaidanOpfsLayoutFileHandle {
  return new NaidanOpfsLayoutFileHandle({ handle });
}

function wrapDirectory({ handle }: {
  handle: StorageDirectoryHandle;
}): NaidanOpfsLayoutDirectoryHandle {
  return new NaidanOpfsLayoutDirectoryHandle({ handle });
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
    return wrapFile({ handle });
  case 'directory':
    return wrapDirectory({ handle });
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
