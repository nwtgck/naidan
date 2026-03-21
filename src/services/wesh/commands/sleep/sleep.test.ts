import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh sleep', () => {
  let wesh: Wesh;
  let originalWaitForSignalOrTimeout: Wesh['kernel']['waitForSignalOrTimeout'] | undefined;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    originalWaitForSignalOrTimeout = wesh.kernel.waitForSignalOrTimeout.bind(wesh.kernel);
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

  it('accepts zero seconds', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep 0',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports fractional values, suffixes, and multiple operands', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number;
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    const fractional = await execute({
      script: 'sleep 0.5',
    });
    const suffixed = await execute({
      script: 'sleep 2m 1.5h 1d',
    });

    expect(fractional.stdout.text).toBe('');
    expect(fractional.stderr.text).toBe('');
    expect(fractional.result.exitCode).toBe(0);

    expect(suffixed.stdout.text).toBe('');
    expect(suffixed.stderr.text).toBe('');
    expect(suffixed.result.exitCode).toBe(0);

    expect(recordedTimeouts).toEqual([
      500,
      ((2 * 60) + (1.5 * 60 * 60) + (24 * 60 * 60)) * 1000,
    ]);

    if (originalWaitForSignalOrTimeout !== undefined) {
      wesh.kernel.waitForSignalOrTimeout = originalWaitForSignalOrTimeout;
    }
  });

  it('reports invalid intervals with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep nope',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sleep: invalid time interval 'nope'");
    expect(stderr.text).toContain('usage: sleep NUMBER[SUFFIX]...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sleep: missing operand');
    expect(stderr.text).toContain('usage: sleep NUMBER[SUFFIX]...');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Delay for a specified amount of time');
    expect(stdout.text).toContain('usage: sleep NUMBER[SUFFIX]...');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
});
