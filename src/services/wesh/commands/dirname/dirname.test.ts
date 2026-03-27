import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/services/wesh/utils/test-stream';

describe('dirname command', () => {
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

  it('prints help output', async () => {
    const { result, stdout, stderr } = await execute({ script: 'dirname --help' });

    expect(stdout.text).toContain('Strip last component from file name');
    expect(stdout.text).toContain('usage: dirname [OPTION]... NAME...');
    expect(stdout.text).toContain('--zero');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles multiple operands and NUL-terminated output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
dirname -z /usr/bin/ dir1/str stdio.h`,
    });

    expect(stdout.text).toBe('/usr\0dir1\0.\0');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects missing operands and invalid options', async () => {
    const missing = await execute({ script: 'dirname' });
    const invalid = await execute({ script: 'dirname -x foo' });

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('dirname: missing operand');
    expect(missing.stderr.text).toContain('usage: dirname [OPTION]... NAME...');
    expect(missing.result.exitCode).toBe(1);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("dirname: invalid option -- 'x'");
    expect(invalid.stderr.text).toContain('usage: dirname [OPTION]... NAME...');
    expect(invalid.result.exitCode).toBe(1);
  });
});
