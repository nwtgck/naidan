import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh whoami', () => {
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

  it('prints the current user', async () => {
    const normal = await execute({ script: 'USER=alice whoami' });

    expect(normal.stdout.text).toBe('alice\n');
    expect(normal.stderr.text).toBe('');
    expect(normal.result.exitCode).toBe(0);
  });

  it('prints help and rejects extra operands and invalid options', async () => {
    const help = await execute({ script: 'whoami --help' });
    const invalid = await execute({ script: 'whoami --bogus' });
    const extra = await execute({ script: 'whoami extra' });

    expect(help.stdout.text).toContain('Print the user name associated with the current effective user ID');
    expect(help.stdout.text).toContain('usage: whoami');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("whoami: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: whoami');
    expect(invalid.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain('whoami: too many arguments');
    expect(extra.stderr.text).toContain('usage: whoami');
    expect(extra.result.exitCode).toBe(1);
  });
});
