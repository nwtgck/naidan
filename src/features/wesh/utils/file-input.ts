import type { WeshFileHandle } from '@/features/wesh/types';

export const OPEN_FILE_DESCRIPTION = Symbol('open file description');

type WeshFileReference = WeshFileHandle & { [OPEN_FILE_DESCRIPTION]?: object };

// Keep the identity of caller-provided clones without changing their handle objects.
const openFiles = new WeakMap<WeshFileHandle, object>();
const retainedInput = new WeakMap<object, WeshInputBuffer>();

export function openFileDescription({ handle }: { handle: WeshFileReference }): object {
  return handle[OPEN_FILE_DESCRIPTION] ?? openFiles.get(handle) ?? handle;
}

export function duplicateFileReference({ handle }: { handle: WeshFileHandle }): WeshFileHandle {
  const reference = handle.cloneReference?.() ?? handle;
  if (reference !== handle && !(OPEN_FILE_DESCRIPTION in reference)) {
    openFiles.set(reference, openFileDescription({ handle }));
  }
  return reference;
}

export function fileInputBuffer({ description }: { description: object }): WeshInputBuffer | undefined {
  return retainedInput.get(description);
}

export function acquireFileInputBuffer({ handle }: { handle: WeshFileHandle }): WeshInputBuffer {
  const description = openFileDescription({ handle });
  let input = retainedInput.get(description);
  if (input === undefined) {
    input = new WeshInputBuffer();
    retainedInput.set(description, input);
  }
  input.attachReader();
  return input;
}

type RefillResult = 'data' | 'eof' | 'cancelled';

export interface WeshShellInput {
  buffer: WeshInputBuffer,
  read: WeshFileHandle['read'],
  isClosed: () => boolean,
  waitForRefill?: ({ operation }: { operation: Promise<RefillResult> }) => Promise<RefillResult>,
}

export class WeshInputBuffer {
  private storage: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private start = 0;
  private length = 0;
  private version = 0;
  private reading: Promise<RefillResult> | undefined;
  private attachedReaders: number | undefined;

  attachReader(): void {
    this.attachedReaders = (this.attachedReaders ?? 0) + 1;
  }

  detachReader(): void {
    if (this.attachedReaders === undefined || this.attachedReaders === 0) {
      throw new Error('Missing shell source reader');
    }
    this.attachedReaders -= 1;
    if (this.attachedReaders === 0) {
      this.trim();
    }
  }

  get byteLength(): number {
    return this.length;
  }

  get revision(): number {
    return this.version;
  }

  get pendingRefill(): Promise<RefillResult> | undefined {
    return this.reading;
  }

  refill({ read, isCancelled }: {
    read: () => Promise<Uint8Array | undefined>,
    isCancelled: () => boolean,
  }): Promise<RefillResult> {
    if (this.reading !== undefined) {
      return this.reading;
    }
    const reading = read().then<RefillResult, RefillResult>(
      bytes => {
        if (bytes === undefined) {
          return isCancelled() ? 'cancelled' : 'eof';
        }
        if (bytes.length === 0) {
          throw new Error('Shell source returned an empty chunk before end of source');
        }
        this.append({ bytes });
        return 'data';
      },
      (error: unknown) => {
        if (isCancelled()) {
          return 'cancelled';
        }
        throw error;
      },
    );
    this.reading = reading;
    const finish = () => {
      this.reading = undefined;
    };
    void reading.then(finish, finish);
    return reading;
  }

  private trim(): void {
    if (this.storage.length > this.length * 2) {
      this.storage = this.view().slice();
      this.start = 0;
    }
  }

  view(): Uint8Array<ArrayBuffer> {
    return this.storage.subarray(this.start, this.start + this.length);
  }

  append({ bytes }: { bytes: Uint8Array }) {
    if (bytes.length === 0) {
      return;
    }
    const availableAtEnd = this.storage.length - (this.start + this.length);
    if (availableAtEnd < bytes.length) {
      const availableAfterCompaction = this.storage.length - this.length;
      if (availableAfterCompaction >= bytes.length) {
        this.storage.copyWithin(0, this.start, this.start + this.length);
        this.start = 0;
      } else {
        const requiredLength = this.length + bytes.length;
        let capacity = Math.max(bytes.length, this.storage.length);
        while (capacity < requiredLength) {
          capacity = Math.max(requiredLength, capacity * 2);
        }
        const expanded = new Uint8Array(capacity);
        expanded.set(this.view(), 0);
        this.storage = expanded;
        this.start = 0;
      }
    }
    this.storage.set(bytes, this.start + this.length);
    this.length += bytes.length;
  }

  consume({ bytes }: { bytes: number }) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.length) {
      throw new Error(`Invalid shell source retained-byte consumption: ${bytes}`);
    }
    this.start += bytes;
    this.length -= bytes;
    if (bytes !== 0) {
      this.version += 1;
    }
    if (this.length === 0) {
      this.start = 0;
      if (this.attachedReaders === 0) {
        this.trim();
      }
    }
  }

  read({ buffer, offset, length }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
  }): number {
    const bytesRead = Math.min(length, this.length);
    if (bytesRead === 0) {
      return 0;
    }
    buffer.set(this.view().subarray(0, bytesRead), offset);
    this.consume({ bytes: bytesRead });
    return bytesRead;
  }
}

export const TEST_ONLY = {
};
