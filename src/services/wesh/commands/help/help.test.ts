import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh help', () => {
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

  it('delegates help grep to grep --help output', async () => {
    const direct = await execute({ script: 'grep --help' });
    const delegated = await execute({ script: 'help grep' });

    expect(delegated.stdout.text).toBe(direct.stdout.text);
    expect(delegated.stderr.text).toBe(direct.stderr.text);
    expect(delegated.result.exitCode).toBe(0);
  });

  it('prints help command help with --help', async () => {
    const { result, stdout, stderr } = await execute({ script: 'help --help' });

    expect(stdout.text).toContain('Display information about builtin commands');
    expect(stdout.text).toContain('usage: help [COMMAND]');
    expect(stdout.text).toContain('--help');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
