import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh env', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { FOO: 'bar' },
    });
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
    const help = await execute({ script: 'env --help' });
    expect(help.stdout.text).toContain('Print environment variables');
    expect(help.stdout.text).toContain('usage: env [name]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'env --bogus' });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('env: unrecognized option');
    expect(invalid.stderr.text).toContain('usage: env [name]');
    expect(invalid.stderr.text).toContain('--help');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('keeps operand behavior unchanged', async () => {
    const { result, stdout, stderr } = await execute({ script: 'env FOO' });

    expect(stdout.text).toBe('bar\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
