import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import { createWeshReadFileHandleFromText, createWeshWriteCaptureHandle } from '@/services/wesh/utils/test-stream';

describe('basename command', () => {
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

  it('prints help output', async () => {
    const { result, stdout, stderr } = await execute({ script: 'basename --help' });

    expect(stdout.text).toContain('Strip directory and suffix from filenames');
    expect(stdout.text).toContain('usage: basename [OPTION]... NAME...');
    expect(stdout.text).toContain('--multiple');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports a suffix argument and multiple names', async () => {
    const single = await execute({ script: 'basename include/stdio.h .h' });
    const multiple = await execute({ script: 'basename -a -s .h include/stdio.h any/str2.h' });

    expect(single.stdout.text).toBe('stdio\n');
    expect(single.stderr.text).toBe('');
    expect(single.result.exitCode).toBe(0);

    expect(multiple.stdout.text).toBe('stdio\nstr2\n');
    expect(multiple.stderr.text).toBe('');
    expect(multiple.result.exitCode).toBe(0);
  });

  it('supports NUL-terminated output and rejects invalid options', async () => {
    const nul = await execute({ script: 'basename -z /usr/bin/sort' });
    const invalid = await execute({ script: 'basename -x foo' });

    expect(nul.stdout.text).toBe('sort\0');
    expect(nul.stderr.text).toBe('');
    expect(nul.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("basename: invalid option -- 'x'");
    expect(invalid.stderr.text).toContain('usage: basename [OPTION]... NAME...');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('rejects missing operands', async () => {
    const { result, stdout, stderr } = await execute({ script: 'basename' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('basename: missing operand');
    expect(stderr.text).toContain('usage: basename [OPTION]... NAME...');
    expect(result.exitCode).toBe(1);
  });
});
