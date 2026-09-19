import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh time', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'time --help' });
    const missing = await execute({ script: 'time' });
    const optionLikeCommand = await execute({ script: 'time --nope true' });

    expect(help.stdout.text).toContain('Measure command execution time');
    expect(help.stdout.text).toContain('usage: time [-p] COMMAND [ARG]...');
    expect(help.stdout.text).toContain('-p');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('time: missing command operand');
    expect(missing.stderr.text).toContain('usage: time [-p] COMMAND [ARG]...');
    expect(missing.result.exitCode).toBe(1);

    expect(optionLikeCommand.stdout.text).toBe('');
    expect(optionLikeCommand.stderr.text).toContain('time: cannot run --nope: No such file or directory');
    expect(optionLikeCommand.stderr.text).toContain('real');
    expect(optionLikeCommand.result.exitCode).toBe(127);
  });

  it('passes option-like arguments to the timed command', async () => {
    const { result, stdout, stderr } = await execute({
      script: `time -p printf '%s\n' --help`,
    });

    expect(stdout.text).toBe('--help\n');
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/);
    expect(result.exitCode).toBe(0);
  });

  it('reports command-not-found after timing the failed launch', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time -p definitely-missing-time-command',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(
      /^time: cannot run definitely-missing-time-command: No such file or directory\nreal \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/,
    );
    expect(result.exitCode).toBe(127);
  });

  it('supports -- before the command operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time -p -- false',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/);
    expect(result.exitCode).toBe(1);
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

  it('treats only one leading -p as a time option', async () => {
    const repeated = await execute({ script: 'time -p -p true' });
    const unknown = await execute({ script: 'time -x' });

    expect(repeated.stdout.text).toBe('');
    expect(repeated.stderr.text).toContain('time: cannot run -p: No such file or directory');
    expect(repeated.result.exitCode).toBe(127);

    expect(unknown.stdout.text).toBe('');
    expect(unknown.stderr.text).toContain('time: cannot run -x: No such file or directory');
    expect(unknown.result.exitCode).toBe(127);
  });

});
