import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh sleep', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root');
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

  it('accepts zero seconds', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep 0',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports invalid intervals with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep nope',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sleep: invalid time interval 'nope'");
    expect(stderr.text).toContain('usage: sleep number');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Delay for a specified amount of time');
    expect(stdout.text).toContain('usage: sleep number');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
});
