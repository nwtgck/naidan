import type { WeshFileHandle, WeshIOResult, WeshStat, WeshWriteResult } from '@/services/wesh/types';

export class GeneratedTextFileHandle implements WeshFileHandle {
  private readonly estimatedSize: number;
  private readonly readText: () => Promise<string>;
  private bytes: Uint8Array | undefined;
  private position = 0;

  constructor({
    estimatedSize,
    readText,
  }: {
    estimatedSize: number,
    readText: () => Promise<string>,
  }) {
    this.estimatedSize = estimatedSize;
    this.readText = readText;
  }

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
    const bytes = await this.ensureBytes();
    const bufferOffset = offset ?? 0;
    const start = position ?? this.position;
    const maxLength = length ?? (buffer.length - bufferOffset);
    const end = Math.min(start + maxLength, bytes.length);
    const slice = bytes.subarray(start, end);
    buffer.set(slice, bufferOffset);
    if (position === undefined) {
      this.position = end;
    }
    return { bytesRead: slice.length };
  }

  async write(): Promise<WeshWriteResult> {
    throw new Error('File is read-only');
  }

  async close(): Promise<void> {}

  async stat(): Promise<WeshStat> {
    const size = this.bytes?.length ?? this.estimatedSize;
    return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
  }

  async truncate(): Promise<void> {
    throw new Error('File is read-only');
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }

  private async ensureBytes(): Promise<Uint8Array> {
    if (this.bytes === undefined) {
      this.bytes = new TextEncoder().encode(await this.readText());
    }
    return this.bytes;
  }
}
