import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh pwd', () => {
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

  it('prints cwd', async () => {
    const normal = await execute({ script: 'pwd' });

    expect(normal.stdout.text).toBe('/\n');
    expect(normal.stderr.text).toBe('');
    expect(normal.result.exitCode).toBe(0);
  });

  it('prints help and rejects extra operands and invalid options', async () => {
    const help = await execute({ script: 'pwd --help' });
    const invalid = await execute({ script: 'pwd --bogus' });
    const extra = await execute({ script: 'pwd extra' });

    expect(help.stdout.text).toContain('Print name of current/working directory');
    expect(help.stdout.text).toContain('usage: pwd');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("pwd: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: pwd');
    expect(invalid.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain('pwd: too many arguments');
    expect(extra.stderr.text).toContain('usage: pwd');
    expect(extra.result.exitCode).toBe(1);
  });
});
