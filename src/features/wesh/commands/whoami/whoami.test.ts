import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh whoami', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints the current USER value when core identity is unavailable', async () => {
    const normal = await execute({ script: 'USER=alice whoami' });

    expect(normal.stdout.text).toBe('alice\n');
    expect(normal.stderr.text).toBe('');
    expect(normal.result.exitCode).toBe(0);
  });

  it('supports GNU-style --version before the option terminator', async () => {
    const version = await execute({ script: 'whoami --version' });
    const abbreviatedVersion = await execute({ script: 'whoami --vers --bogus' });
    const lateVersion = await execute({ script: 'whoami extra --version' });
    const terminated = await execute({ script: 'whoami -- extra --version' });

    expect(version.stdout.text).toBe('whoami (Wesh coreutils) 1.0\n');
    expect(abbreviatedVersion.stdout.text).toBe('whoami (Wesh coreutils) 1.0\n');
    expect(abbreviatedVersion.stderr.text).toBe('');
    expect(abbreviatedVersion.result.exitCode).toBe(0);
    expect(version.stderr.text).toBe('');
    expect(version.result.exitCode).toBe(0);
    expect(lateVersion.stdout.text).toBe('whoami (Wesh coreutils) 1.0\n');
    expect(lateVersion.stderr.text).toBe('');
    expect(lateVersion.result.exitCode).toBe(0);
    expect(terminated.stdout.text).toBe('');
    expect(terminated.stderr.text).toContain('whoami: too many arguments');
    expect(terminated.result.exitCode).toBe(1);
  });

  it('prints help and rejects extra operands and invalid options', async () => {
    const help = await execute({ script: 'whoami --help' });
    const abbreviatedHelp = await execute({ script: 'whoami --he --bogus' });
    const invalid = await execute({ script: 'whoami --bogus' });
    const extra = await execute({ script: 'whoami extra' });

    expect(help.stdout.text).toContain('Print the user name associated with the current effective user ID');
    expect(help.stdout.text).toContain('usage: whoami');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);
    expect(abbreviatedHelp.stdout.text).toBe(help.stdout.text);
    expect(abbreviatedHelp.stderr.text).toBe('');
    expect(abbreviatedHelp.result.exitCode).toBe(0);

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
