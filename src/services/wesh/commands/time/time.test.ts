import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh time', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'time --help' });
    const missing = await execute({ script: 'time' });
    const invalid = await execute({ script: 'time --nope true' });

    expect(help.stdout.text).toContain('Measure command execution time');
    expect(help.stdout.text).toContain('usage: time [-p] COMMAND [ARG]...');
    expect(help.stdout.text).toContain('-p');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('time: missing command operand');
    expect(missing.stderr.text).toContain('usage: time [-p] COMMAND [ARG]...');
    expect(missing.result.exitCode).toBe(1);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("time: unrecognized option '--nope'");
    expect(invalid.stderr.text).toContain('usage: time [-p] COMMAND [ARG]...');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('passes stdout through and writes timing to stderr', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time printf hello',
    });

    expect(stdout.text).toBe('hello');
    expect(stderr.text).toMatch(/^real\t\d+m\d+\.\d{3}s\nuser\t0m0\.000s\nsys\t0m0\.000s\n$/);
    expect(result.exitCode).toBe(0);
  });

  it('supports the portable -p format and preserves exit codes', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time -p false',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/);
    expect(result.exitCode).toBe(1);
  });

  it('times commands that consume stdin', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time cat -',
      stdinText: 'from-stdin\n',
    });

    expect(stdout.text).toBe('from-stdin\n');
    expect(stderr.text).toContain('real');
    expect(stderr.text).toContain('user');
    expect(stderr.text).toContain('sys');
    expect(result.exitCode).toBe(0);
  });
});
