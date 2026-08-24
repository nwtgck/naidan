import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh exec', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
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
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'exec --help' });
    const invalid = await execute({ script: 'exec --bogus' });

    expect(help.stdout.text).toContain('Replace the shell command context');
    expect(help.stdout.text).toContain('usage: exec [-cl] [-a name] [command [arg...]]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("exec: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: exec [-cl] [-a name] [command [arg...]]');
    expect(invalid.stderr.text).toContain('try:');
    expect(invalid.result.exitCode).toBe(2);
  });

  it('accepts Bash exec option bundles and argv0 forms before a command', async () => {
    for (const script of [
      'exec -c',
      'exec -l',
      'exec -cl',
      'exec -lc',
      'exec -a custom',
      'exec -acustom',
    ]) {
      const { result, stdout, stderr } = await execute({ script });
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });

  it('keeps command arguments out of exec option parsing', async () => {
    for (const script of [
      'exec true -c',
      'exec true -l',
      'exec true -a',
      'exec -- true -c',
    ]) {
      const { result, stdout, stderr } = await execute({ script });
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe('exec: replacing the shell requires Wesh core exit control-flow support\n');
      expect(result.exitCode).toBe(1);
    }
  });

  it('rejects a missing exec -a value as an argv error', async () => {
    const { result, stdout, stderr } = await execute({ script: 'exec -a' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('-a requires a value for NAME');
    expect(result.exitCode).toBe(2);
  });

});
