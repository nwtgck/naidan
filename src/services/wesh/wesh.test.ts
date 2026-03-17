import { describe, it, expect, beforeEach } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';

describe('Wesh Shell', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as any });
    await wesh.init();

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
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo hello', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello');
    expect(result.exitCode).toBe(0);
  });

  it('handles variable assignment', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'MYVAR=test', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createWeshWriteCaptureHandle();
    const result = await wesh.execute({ script: 'echo $MYVAR', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('test');
    expect(result.exitCode).toBe(0);
  });

  it('handles sequential commands with ;', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo A; echo B', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
    expect(result.exitCode).toBe(0);
  });

  it('handles logical AND (&&)', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo A && echo B', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
    expect(result.exitCode).toBe(0);

    const stdout2 = createWeshWriteCaptureHandle();
    const resultFail = await wesh.execute({ script: 'false && echo B', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(resultFail.exitCode).not.toBe(0);
    expect(stdout2.text).not.toContain('B');
  });

  it('handles if statements', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'if true; then echo yes; else echo no; fi', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('yes');

    const stdout2 = createWeshWriteCaptureHandle();
    await wesh.execute({ script: 'if false; then echo yes; else echo no; fi', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('no');
  });

  it('handles for loops', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'for i in A B; do echo $i; done', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
  });

  it('supports file redirection and reading (Mock OPFS)', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'echo "file content" > test.txt', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const handle = await rootHandle.getFileHandle('test.txt');
    const file = await handle.getFile();
    const text = await file.text();
    expect(text).toContain('file content');

    const stdout2 = createWeshWriteCaptureHandle();
    const catResult = await wesh.execute({ script: 'cat test.txt', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('file content');
    expect(catResult.exitCode).toBe(0);
  });

  it('handles subshells ( isolation )', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'VAR=parent', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createWeshWriteCaptureHandle();
    await wesh.execute({ script: '(VAR=child; echo $VAR); echo $VAR', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('child');
    expect(stdout2.text).toContain('parent');

    // Check that child assignment didn't leak
    const stdout3 = createWeshWriteCaptureHandle();
    await wesh.execute({ script: 'echo $VAR', stdin, stdout: stdout3.handle, stderr: stderr.handle });
    expect(stdout3.text).toBe('parent\n');
  });

  it('handles here-documents (<<EOF)', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'cat <<EOF\nhello\nworld\nEOF', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello');
    expect(stdout.text).toContain('world');
  });

  it('handles here-strings (<<<)', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'cat <<< "hello world"', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello world');
  });

  it('handles process substitution <(cmd)', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'cat <(echo "subst")', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('subst');
  });

  it('handles environment variable maps ( Map compliance )', async () => {
    const stdin = createWeshReadFileHandleFromText({ text: '' });
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    await wesh.execute({ script: 'export TEST_MAP=1', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createWeshWriteCaptureHandle();
    await wesh.execute({ script: 'env', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('TEST_MAP=1');
  });
});
