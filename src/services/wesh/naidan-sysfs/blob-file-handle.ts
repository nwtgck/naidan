import type { WeshFileHandle, WeshIOResult, WeshStat, WeshWriteResult } from '@/services/wesh/types'
import type { NaidanSysfsBinaryObject } from './types'

export class BlobFileHandle implements WeshFileHandle {
  private position = 0

  constructor({
    blob,
    metadata,
  }: {
    blob: Blob;
    metadata: NaidanSysfsBinaryObject;
  }) {
    this.blob = blob
    this.metadata = metadata
  }

  private readonly blob: Blob
  private readonly metadata: NaidanSysfsBinaryObject

  async read({
    buffer,
    offset,
    length,
    position,
  }: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    const bufferOffset = offset ?? 0
    const readPosition = position ?? this.position
    const maxLength = length ?? (buffer.length - bufferOffset)

    if (maxLength <= 0) {
      return { bytesRead: 0 }
    }

    const end = Math.min(readPosition + maxLength, this.blob.size)
    if (end <= readPosition) {
      return { bytesRead: 0 }
    }

    const chunk = await readBlobSlice({
      blob: this.blob,
      start: readPosition,
      end,
    })
    const safeChunk = chunk.subarray(0, Math.min(chunk.length, maxLength, buffer.length - bufferOffset))
    buffer.set(safeChunk, bufferOffset)

    if (position === undefined) {
      this.position = end
    }

    return { bytesRead: safeChunk.length }
  }

  async write(_args: Record<never, never>): Promise<WeshWriteResult> {
    throw new Error('File is read-only')
  }

  async close(): Promise<void> {}

  async stat(): Promise<WeshStat> {
    return {
      size: this.blob.size,
      mode: 0o444,
      type: 'file',
      mtime: this.metadata.createdAt,
      ino: 0,
      uid: 0,
      gid: 0,
    }
  }

  async truncate({ size: _size }: { size: number }): Promise<void> {
    throw new Error('File is read-only')
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 }
  }
}

async function readBlobSlice({
  blob,
  start,
  end,
}: {
  blob: Blob;
  start: number;
  end: number;
}): Promise<Uint8Array> {
  const slice = blob.slice(start, end) as Blob & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    stream?: () => ReadableStream<Uint8Array>;
    text?: () => Promise<string>;
  }

  if (typeof slice.arrayBuffer === 'function') {
    return new Uint8Array(await slice.arrayBuffer())
  }

  if (typeof slice.stream === 'function') {
    return new Uint8Array(await new Response(slice.stream()).arrayBuffer())
  }

  if (typeof slice.text === 'function') {
    return new TextEncoder().encode(await slice.text())
  }

  throw new Error('Blob does not support readable methods')
}
