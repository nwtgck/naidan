import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh which', () => {
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

  it('prints help and reports missing operands', async () => {
    const help = await execute({ script: 'which --help' });
    expect(help.stdout.text).toContain('Locate a command');
    expect(help.stdout.text).toContain('usage: which command...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const missing = await execute({ script: 'which' });
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('which: missing operand');
    expect(missing.stderr.text).toContain('usage: which command...');
    expect(missing.result.exitCode).toBe(1);
  });

  it('keeps lookup behavior unchanged', async () => {
    const { result, stdout, stderr } = await execute({ script: 'which env missing-command' });

    expect(stdout.text).toContain('env: builtin command');
    expect(stderr.text).toContain('missing-command not found');
    expect(result.exitCode).toBe(1);
  });

  it('matches command -v for resolved builtins', async () => {
    const whichResult = await execute({ script: 'which env' });
    const commandResult = await execute({ script: 'command -v env' });

    expect(whichResult.stdout.text).toBe('env: builtin command\n');
    expect(commandResult.stdout.text).toBe('env\n');
    expect(whichResult.stderr.text).toBe('');
    expect(commandResult.stderr.text).toBe('');
  });

  it('treats -- as the end of options', async () => {
    const { result, stdout, stderr } = await execute({ script: 'which -- env' });

    expect(stdout.text).toBe('env: builtin command\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
