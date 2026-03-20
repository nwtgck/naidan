import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh command', () => {
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

  it('prints help and supports command -v and -V', async () => {
    const help = await execute({ script: 'command --help' });
    const verbose = await execute({ script: 'command -v env missing-command' });
    const described = await execute({ script: 'command -V env missing-command' });

    expect(help.stdout.text).toContain('Run command with arguments, ignoring any function or alias');
    expect(help.stdout.text).toContain('usage: command [-vV] command [argument...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(verbose.stdout.text).toBe('env\n');
    expect(verbose.stderr.text).toBe('');
    expect(verbose.result.exitCode).toBe(1);

    expect(described.stdout.text).toBe('env is a shell builtin\n');
    expect(described.stderr.text).toBe('');
    expect(described.result.exitCode).toBe(1);
  });

  it('executes the resolved builtin command and reports unknown commands', async () => {
    const executed = await execute({ script: 'command echo hello world' });
    const missing = await execute({ script: 'command missing-command' });

    expect(executed.stdout.text).toBe('hello world\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('command: missing-command not found');
    expect(missing.result.exitCode).toBe(1);
  });

  it('treats -- as the end of command options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'command -- echo hello',
    });

    expect(stdout.text).toBe('hello\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
