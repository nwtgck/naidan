import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh export', () => {
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
    const help = await execute({ script: 'export --help' });
    expect(help.stdout.text).toContain('Set environment variables');
    expect(help.stdout.text).toContain('usage: export [-p] name=value...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stdout.text).toContain('-p');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'export --bogus' });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('export: unrecognized option');
    expect(invalid.stderr.text).toContain('usage: export [-p] name=value...');
    expect(invalid.stderr.text).toContain('--help');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('keeps print mode behavior unchanged', async () => {
    const { result, stdout, stderr } = await execute({ script: 'export -p' });

    expect(stdout.text).toContain("export FOO='bar'");
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
