import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh mkfifo', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('creates fifos', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo pipe',
    });

    const check = await execute({
      script: 'test -p pipe',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(check.result.exitCode).toBe(0);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('mkfifo: missing operand');
    expect(stderr.text).toContain('usage: mkfifo [path...]');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Make FIFOs (named pipes)');
    expect(stdout.text).toContain('usage: mkfifo [path...]');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
});
