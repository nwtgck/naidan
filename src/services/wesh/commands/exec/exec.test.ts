import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh exec', () => {
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
    const help = await execute({ script: 'exec --help' });
    const invalid = await execute({ script: 'exec --bogus' });

    expect(help.stdout.text).toContain('Replace the shell command context');
    expect(help.stdout.text).toContain('usage: exec [command [arg...]]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("exec: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: exec [command [arg...]]');
    expect(invalid.stderr.text).toContain('try:');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('executes the requested command and honors --', async () => {
    const basic = await execute({ script: 'exec pwd' });
    const dashed = await execute({ script: 'exec -- pwd' });

    expect(basic.stdout.text).toBe('/\n');
    expect(basic.stderr.text).toBe('');
    expect(basic.result.exitCode).toBe(0);

    expect(dashed.stdout.text).toBe('/\n');
    expect(dashed.stderr.text).toBe('');
    expect(dashed.result.exitCode).toBe(0);
  });
});
