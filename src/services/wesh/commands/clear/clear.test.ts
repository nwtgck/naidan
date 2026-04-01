import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh clear', () => {
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

  it('prints the escape sequence', async () => {
    const normal = await execute({ script: 'clear' });

    expect(normal.stdout.text).toBe('\x1b[2J\x1b[H');
    expect(normal.stderr.text).toBe('');
    expect(normal.result.exitCode).toBe(0);
  });

  it('prints help and rejects extra operands and invalid options', async () => {
    const help = await execute({ script: 'clear --help' });
    const invalid = await execute({ script: 'clear --bogus' });
    const extra = await execute({ script: 'clear extra' });

    expect(help.stdout.text).toContain('Clear the terminal screen');
    expect(help.stdout.text).toContain('usage: clear');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("clear: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: clear');
    expect(invalid.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain('clear: too many arguments');
    expect(extra.stderr.text).toContain('usage: clear');
    expect(extra.result.exitCode).toBe(1);
  });
});
