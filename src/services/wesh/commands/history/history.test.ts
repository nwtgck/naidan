import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh history', () => {
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
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports invalid options', async () => {
    const help = await execute({ script: 'history --help' });
    expect(help.stdout.text).toContain('Display the command history list');
    expect(help.stdout.text).toContain('usage: history');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'history --bogus' });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('history: unrecognized option');
    expect(invalid.stderr.text).toContain('usage: history');
    expect(invalid.stderr.text).toContain('--help');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('keeps history output stable', async () => {
    await execute({ script: 'echo one' });
    await execute({ script: 'echo two' });

    const { result, stdout, stderr } = await execute({ script: 'history' });

    expect(stdout.text).toContain('echo one');
    expect(stdout.text).toContain('echo two');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
