import type { WeshFileHandle, WeshIOResult, WeshStat, WeshWriteResult } from '@/features/wesh/types';
import { createUtf8TextSource, type Utf8TextSource } from '@/utils/utf8-text-source';
import { waitForBlobRead } from '@/utils/blob-view-io';

const READ_CHUNK_SIZE = 64 * 1024;

export class GeneratedTextFileHandle implements WeshFileHandle {
  private readonly estimatedSize: number;
  private readText: (() => Promise<string>) | undefined;
  private source: Utf8TextSource | undefined;
  private loading: Promise<Utf8TextSource> | undefined;
  private readonly lifetime = new AbortController();
  private position = 0;

  constructor({ estimatedSize, readText }: { estimatedSize: number, readText: () => Promise<string> }) {
    this.estimatedSize = estimatedSize;
    this.readText = readText;
  }

  async read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    this.lifetime.signal.throwIfAborted();
    const bufferOffset = offset ?? 0;
    const requestedLength = length ?? (buffer.length - bufferOffset);
    if (!Number.isSafeInteger(bufferOffset) || bufferOffset < 0 || bufferOffset > buffer.length
      || !Number.isSafeInteger(requestedLength) || requestedLength < 0
      || (position !== undefined && (!Number.isSafeInteger(position) || position < 0))) {
      throw new RangeError('Invalid generated text read range');
    }
    const readLength = Math.min(requestedLength, buffer.length - bufferOffset, READ_CHUNK_SIZE);
    if (readLength === 0) return { bytesRead: 0 };
    const source = await this.ensureSource();
    this.lifetime.signal.throwIfAborted();
    // Select the implicit position after the shared render completes. Reading
    // and advancing it are synchronous, so concurrent waits do not reuse it.
    const start = position ?? this.position;
    const bytesRead = source.read({ buffer: buffer.subarray(bufferOffset, bufferOffset + readLength), position: start });
    if (position === undefined) this.position = start + bytesRead;
    return { bytesRead };
  }

  async write(): Promise<WeshWriteResult> {
    throw new Error('File is read-only');
  }

  async close(): Promise<void> {
    // End only this handle. A renderer already running may still finish, but
    // its result must not be encoded or installed back into this closed owner.
    this.lifetime.abort(new DOMException('File is closed', 'AbortError'));
    this.source = undefined;
    this.loading = undefined;
    this.readText = undefined;
  }

  async stat(): Promise<WeshStat> {
    this.lifetime.signal.throwIfAborted();
    const size = this.source?.getByteLength() ?? this.estimatedSize;
    return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
  }

  async truncate(): Promise<void> {
    throw new Error('File is read-only');
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }

  private async ensureSource(): Promise<Utf8TextSource> {
    this.lifetime.signal.throwIfAborted();
    if (this.source !== undefined) return this.source;
    if (this.loading === undefined) {
      const readText = this.readText;
      if (readText === undefined) throw new Error('Generated text renderer is unavailable');
      // Schedule the renderer after publishing the shared promise. A synchronous
      // throw or close during rendering follows the same cleanup path.
      const operation = Promise.resolve().then(async () => {
        this.lifetime.signal.throwIfAborted();
        const text = await readText();
        this.lifetime.signal.throwIfAborted();
        const source = createUtf8TextSource({ text });
        this.source = source;
        this.readText = undefined;
        return source;
      });
      const loading = operation.then(
        source => {
          if (this.loading === loading) this.loading = undefined;
          return source;
        },
        (error: unknown) => {
          if (this.loading === loading) this.loading = undefined;
          throw error;
        },
      );
      this.loading = loading;
    }
    return waitForBlobRead({ operation: this.loading, signal: this.lifetime.signal, timeoutMs: undefined });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  READ_CHUNK_SIZE,
};
