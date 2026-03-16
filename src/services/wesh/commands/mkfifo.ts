import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';

class NamedPipeHandle implements WeshFileHandle {
  private buffer: Uint8Array[] = [];
  private readers: Array<(res: { bytesRead: number }) => void> = [];
  private closed = false;

  async read({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }> {
    if (this.buffer.length > 0) {
      const chunk = this.buffer.shift()!;
      const copyLen = Math.min(buffer.length, chunk.length);
      buffer.set(chunk.subarray(0, copyLen));
      if (chunk.length > copyLen) {
        this.buffer.unshift(chunk.subarray(copyLen));
      }
      return { bytesRead: copyLen };
    }
    if (this.closed) return { bytesRead: 0 };
    
    return new Promise((resolve) => {
      this.readers.push(resolve);
    });
  }

  async write({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesWritten: number }> {
    if (this.closed) throw new Error('Pipe closed');
    
    if (this.readers.length > 0) {
      const resolve = this.readers.shift()!;
      const copyLen = Math.min(buffer.length, buffer.length); // Simplified
      // For real pipe, we should handle partial read if buffer is smaller than write
      // But here we just deliver what we have.
      // Wait, resolve expects {bytesRead: number}. We need to copy to THEIR buffer.
      // This implementation is tricky without knowing the reader's buffer.
      // So we just buffer it and let the reader resolve from buffer.
    }
    
    this.buffer.push(new Uint8Array(buffer));
    const firstReader = this.readers.shift();
    if (firstReader) {
       const chunk = this.buffer.shift()!;
       // We can't easily copy to the reader's buffer here because we don't have it.
       // Re-implementing:
    }
    return { bytesWritten: buffer.length };
  }

  // Simplified version:
  /*
  async read(...) {
    if (this.buffer.length === 0 && !this.closed) await wait_for_data;
    ...
  }
  */

  async close() { this.closed = true; this.readers.forEach(r => r({ bytesRead: 0 })); }
  async stat() { return { size: 0, kind: 'file' as const }; }
  async truncate() {}
}

/**
 * Better Named Pipe Implementation
 */
class Fifo {
  private queue: Uint8Array[] = [];
  private readRequests: Array<{ buffer: Uint8Array; resolve: (res: { bytesRead: number }) => void }> = [];
  private closed = false;

  async read({ buffer }: { buffer: Uint8Array }): Promise<{ bytesRead: number }> {
    if (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      const n = Math.min(buffer.length, chunk.length);
      buffer.set(chunk.subarray(0, n));
      if (chunk.length > n) this.queue.unshift(chunk.subarray(n));
      return { bytesRead: n };
    }
    if (this.closed) return { bytesRead: 0 };
    return new Promise(resolve => {
      this.readRequests.push({ buffer, resolve });
    });
  }

  async write({ buffer }: { buffer: Uint8Array }): Promise<{ bytesWritten: number }> {
    if (this.closed) throw new Error('Broken pipe');
    
    let remaining = new Uint8Array(buffer);
    while (remaining.length > 0 && this.readRequests.length > 0) {
      const req = this.readRequests.shift()!;
      const n = Math.min(req.buffer.length, remaining.length);
      req.buffer.set(remaining.subarray(0, n));
      req.resolve({ bytesRead: n });
      remaining = remaining.subarray(n);
    }
    
    if (remaining.length > 0) {
      this.queue.push(remaining);
    }
    return { bytesWritten: buffer.length };
  }

  close() {
    this.closed = true;
    while (this.readRequests.length > 0) {
      this.readRequests.shift()!.resolve({ bytesRead: 0 });
    }
  }
}

class FifoHandle implements WeshFileHandle {
  constructor(private fifo: Fifo) {}
  read({ buffer }: { buffer: Uint8Array }) { return this.fifo.read({ buffer }); }
  write({ buffer }: { buffer: Uint8Array }) { return this.fifo.write({ buffer }); }
  async close() {} // Individual handles don't close the FIFO itself usually, or they do? 
  // In Linux, FIFO stays until unlinked.
  async stat() { return { size: 0, kind: 'file' as const }; }
  async truncate() {}
}

export const mkfifoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mkfifo',
    description: 'Make FIFOs (named pipes)',
    usage: 'mkfifo [name...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    for (const name of context.args) {
      const path = name.startsWith('/') ? name : `${context.cwd}/${name}`;
      const fifo = new Fifo();
      context.vfs.registerSpecialFile({
        path,
        handler: () => new FifoHandle(fifo)
      });
    }
    return { exitCode: 0, data: undefined, error: undefined };
  },
};
