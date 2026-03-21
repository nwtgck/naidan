import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import { createWeshReadFileHandleFromText, createWeshWriteCaptureHandle } from '@/services/wesh/utils/test-stream';

describe('printf command', () => {
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
    const { result, stdout, stderr } = await execute({ script: 'printf --help' });

    expect(stdout.text).toContain('Format and print data');
    expect(stdout.text).toContain('usage: printf FORMAT [ARGUMENT]...');
    expect(stdout.text).toContain('--help');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('formats strings, integers, escapes, and percent signs without a trailing newline', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf '%s %d %b %%' alpha 7 'line1\\nline2'`,
    });

    expect(stdout.text).toBe(`\
alpha 7 line1
line2 %`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('repeats the format string over extra arguments', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf '%s-' a b c`,
    });

    expect(stdout.text).toBe('a-b-c-');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid formats and missing format operands with usage', async () => {
    const invalid = await execute({ script: "printf '%q' x" });
    const missing = await execute({ script: 'printf' });

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("printf: invalid format character 'q'");
    expect(invalid.stderr.text).toContain('usage: printf FORMAT [ARGUMENT]...');
    expect(invalid.result.exitCode).toBe(1);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('printf: missing format operand');
    expect(missing.stderr.text).toContain('usage: printf FORMAT [ARGUMENT]...');
    expect(missing.result.exitCode).toBe(1);
  });
});
