import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh true', () => {
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

  it('prints help and ignores extra arguments', async () => {
    const help = await execute({ script: 'true --help' });
    const ignored = await execute({ script: 'true anything goes' });

    expect(help.stdout.text).toContain('Do nothing successfully');
    expect(help.stdout.text).toContain('usage: true [arguments...]');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(ignored.stdout.text).toBe('');
    expect(ignored.stderr.text).toBe('');
    expect(ignored.result.exitCode).toBe(0);
  });
});
