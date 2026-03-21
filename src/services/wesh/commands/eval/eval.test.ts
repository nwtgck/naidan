import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh eval', () => {
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

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'eval --help' });
    const invalid = await execute({ script: 'eval --bogus' });

    expect(help.stdout.text).toContain('Evaluate arguments as shell code');
    expect(help.stdout.text).toContain('usage: eval [arg...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("eval: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: eval [arg...]');
    expect(invalid.stderr.text).toContain('try:');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('evaluates joined positional arguments and honors --', async () => {
    const basic = await execute({ script: 'eval echo hello' });
    const dashed = await execute({ script: 'eval -- echo after-doubledash' });

    expect(basic.stdout.text).toBe('hello\n');
    expect(basic.stderr.text).toBe('');
    expect(basic.result.exitCode).toBe(0);

    expect(dashed.stdout.text).toBe('after-doubledash\n');
    expect(dashed.stderr.text).toBe('');
    expect(dashed.result.exitCode).toBe(0);
  });
});
