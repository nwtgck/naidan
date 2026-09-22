import type { BlobView } from '@/utils/blob-view';
import { BLOB_VIEW_CHUNK_SIZE } from '@/utils/blob-view-io';
import type { WeshFileHandle, WeshIOResult, WeshStat, WeshWriteResult } from '@/features/wesh/types';
import type { NaidanSysfsBinaryObject } from './types';

export class BlobFileHandle implements WeshFileHandle {
  private position = 0;
  private readTail = Promise.resolve();
  private readonly lifetime = new AbortController();

  constructor({
    blob,
    metadata,
  }: {
    blob: BlobView,
    metadata: NaidanSysfsBinaryObject,
  }) {
    this.blob = blob;
    this.metadata = metadata;
  }

  private readonly blob: BlobView;
  private readonly metadata: NaidanSysfsBinaryObject;

  async read({
    buffer,
    offset,
    length,
    position,
  }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    this.lifetime.signal.throwIfAborted();
    // Choose and advance the cursor inside one read operation. A host round
    // trip must not let two reads reserve the same implicit position.
    const operation = this.readTail.then(() => this.readOpen({ buffer, offset, length, position }));
    this.readTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readOpen({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset: number | undefined,
    length: number | undefined,
    position: number | undefined,
  }): Promise<WeshIOResult> {
    this.lifetime.signal.throwIfAborted();
    const bufferOffset = offset ?? 0;
    const readPosition = position ?? this.position;
    const requestedLength = length ?? (buffer.length - bufferOffset);
    if (!Number.isSafeInteger(bufferOffset) || bufferOffset < 0 || bufferOffset > buffer.length
      || !Number.isSafeInteger(requestedLength) || requestedLength < 0
      || !Number.isSafeInteger(readPosition) || readPosition < 0) {
      throw new RangeError('Invalid binary file read range');
    }
    // A file read may return a partial result. Bound allocation and advance by
    // bytes actually copied, not by a request larger than the destination.
    const readLength = Math.min(requestedLength, buffer.length - bufferOffset,
      Math.max(0, this.blob.size - readPosition), BLOB_VIEW_CHUNK_SIZE);
    if (readLength === 0) return { bytesRead: 0 };
    const chunk = await this.blob.slice({ start: readPosition, end: readPosition + readLength })
      .bytes({ signal: this.lifetime.signal });
    this.lifetime.signal.throwIfAborted();
    if (chunk.byteLength !== readLength) throw new Error('Incomplete binary file read');
    buffer.set(chunk, bufferOffset);
    if (position === undefined) this.position = readPosition + readLength;
    return { bytesRead: readLength };
  }

  async write(): Promise<WeshWriteResult> {
    throw new Error('File is read-only');
  }

  async close(): Promise<void> {
    // Cancel only this handle, never the borrowed session BlobContext.
    this.lifetime.abort(new DOMException('File is closed', 'AbortError'));
  }

  async stat(): Promise<WeshStat> {
    this.lifetime.signal.throwIfAborted();
    return {
      size: this.blob.size,
      mode: 0o444,
      type: 'file',
      mtime: this.metadata.createdAt,
      ino: 0,
      uid: 0,
      gid: 0,
    };
  }

  async truncate({ size: _size }: { size: number }): Promise<void> {
    throw new Error('File is read-only');
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
