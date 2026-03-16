import { describe, it, expect, beforeEach } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import type { WeshFileHandle, WeshStat, WeshIOResult, WeshWriteResult } from './types';

class MemoryFileHandle implements WeshFileHandle {
  private buffer = new Uint8Array(0);
  private cursor = 0;

  async read(options: { buffer: Uint8Array; offset?: number; length?: number; position?: number }): Promise<WeshIOResult> {
    const pos = options.position ?? this.cursor;
    if (pos >= this.buffer.length) return { bytesRead: 0 };

    const bufferOffset = options.offset ?? 0;
    const maxLen = options.length ?? (options.buffer.length - bufferOffset);
    const copyLen = Math.min(this.buffer.length - pos, maxLen);

    options.buffer.set(this.buffer.subarray(pos, pos + copyLen), bufferOffset);
    if (options.position === undefined) this.cursor += copyLen;
    return { bytesRead: copyLen };
  }

  async write(options: { buffer: Uint8Array; offset?: number; length?: number; position?: number }): Promise<WeshWriteResult> {
    const bufferOffset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - bufferOffset);
    const pos = options.position ?? this.cursor;

    if (pos + length > this.buffer.length) {
      const newBuf = new Uint8Array(pos + length);
      newBuf.set(this.buffer);
      this.buffer = newBuf;
    }

    this.buffer.set(options.buffer.subarray(bufferOffset, bufferOffset + length), pos);
    if (options.position === undefined) this.cursor += length;
    return { bytesWritten: length };
  }

  async close(): Promise<void> {}
  async stat(): Promise<WeshStat> {
    return { size: this.buffer.length, mode: 0, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
  }
  async truncate(options: { size: number }): Promise<void> {
    this.buffer = this.buffer.slice(0, options.size);
    if (this.cursor > options.size) this.cursor = options.size;
  }
  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }

  toString() {
    return new TextDecoder().decode(this.buffer);
  }
}

describe('Wesh Shell', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;
  let stdin: MemoryFileHandle;
  let stdout: MemoryFileHandle;
  let stderr: MemoryFileHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as any });
    await wesh.init();

    stdin = new MemoryFileHandle();
    stdout = new MemoryFileHandle();
    stderr = new MemoryFileHandle();

    // Register mock commands
    wesh.registerCommand({
      definition: {
        meta: { name: 'true', description: 'Success', usage: 'true' },
        fn: async () => ({ exitCode: 0 })
      }
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'false', description: 'Fail', usage: 'false' },
        fn: async () => ({ exitCode: 1 })
      }
    });
  });

  it('executes simple commands', async () => {
    const result = await wesh.execute({ script: 'echo hello', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('hello');
    expect(result.exitCode).toBe(0);
  });

  it('handles variable assignment', async () => {
    await wesh.execute({ script: 'MYVAR=test', stdin, stdout, stderr });
    // Reset stdout for next command
    stdout = new MemoryFileHandle();
    const result = await wesh.execute({ script: 'echo $MYVAR', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('test');
    expect(result.exitCode).toBe(0);
  });

  it('handles sequential commands with ;', async () => {
    const result = await wesh.execute({ script: 'echo A; echo B', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('A');
    expect(stdout.toString()).toContain('B');
    expect(result.exitCode).toBe(0);
  });

  it('handles logical AND (&&)', async () => {
    const result = await wesh.execute({ script: 'echo A && echo B', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('A');
    expect(stdout.toString()).toContain('B');
    expect(result.exitCode).toBe(0);

    stdout = new MemoryFileHandle();
    const resultFail = await wesh.execute({ script: 'false && echo B', stdin, stdout, stderr });
    expect(resultFail.exitCode).not.toBe(0);
    expect(stdout.toString()).not.toContain('B');
  });

  it('handles if statements', async () => {
    const result = await wesh.execute({ script: 'if true; then echo yes; else echo no; fi', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('yes');

    stdout = new MemoryFileHandle();
    const resultElse = await wesh.execute({ script: 'if false; then echo yes; else echo no; fi', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('no');
  });

  it('handles for loops', async () => {
    const result = await wesh.execute({ script: 'for i in A B; do echo $i; done', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('A');
    expect(stdout.toString()).toContain('B');
  });

  it('supports file redirection and reading (Mock OPFS)', async () => {
    await wesh.execute({ script: 'echo "file content" > test.txt', stdin, stdout, stderr });

    const handle = await rootHandle.getFileHandle('test.txt');
    const file = await handle.getFile();
    const text = await file.text();
    expect(text).toContain('file content');

    stdout = new MemoryFileHandle();
    const catResult = await wesh.execute({ script: 'cat test.txt', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('file content');
    expect(catResult.exitCode).toBe(0);
  });

  it('handles subshells ( isolation )', async () => {
    await wesh.execute({ script: 'VAR=parent', stdin, stdout, stderr });
    stdout = new MemoryFileHandle();
    const result = await wesh.execute({ script: '(VAR=child; echo $VAR); echo $VAR', stdin, stdout, stderr });
    const output = stdout.toString();
    expect(output).toContain('child');
    expect(output).toContain('parent');

    // Check that child assignment didn't leak
    stdout = new MemoryFileHandle();
    await wesh.execute({ script: 'echo $VAR', stdin, stdout, stderr });
    expect(stdout.toString()).toBe('parent\n');
  });

  it('handles here-documents (<<EOF)', async () => {
    const result = await wesh.execute({ script: 'cat <<EOF\nhello\nworld\nEOF', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('hello');
    expect(stdout.toString()).toContain('world');
  });

  it('handles here-strings (<<<)', async () => {
    const result = await wesh.execute({ script: 'cat <<< "hello world"', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('hello world');
  });

  it('handles process substitution <(cmd)', async () => {
    const result = await wesh.execute({ script: 'cat <(echo "subst")', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('subst');
  });

  it('handles environment variable maps ( Map compliance )', async () => {
    await wesh.execute({ script: 'export TEST_MAP=1', stdin, stdout, stderr });
    stdout = new MemoryFileHandle();
    const result = await wesh.execute({ script: 'env', stdin, stdout, stderr });
    expect(stdout.toString()).toContain('TEST_MAP=1');
  });
});
