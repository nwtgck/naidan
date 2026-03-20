import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh argv migration batch b', () => {
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

  it('supports env help and parse errors', async () => {
    const help = await execute({ script: 'env --help' });
    expect(help.stdout.text).toContain('Print environment variables');
    expect(help.stdout.text).toContain('usage: env [name]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const error = await execute({ script: 'env --bogus' });
    expect(error.stdout.text).toBe('');
    expect(error.stderr.text).toContain('usage: env [name]');
    expect(error.stderr.text).toContain('--help');
    expect(error.result.exitCode).toBe(1);
  });

  it('keeps env operand behavior unchanged', async () => {
    const { result, stdout, stderr } = await execute({ script: 'env FOO' });

    expect(stdout.text).toBe('bar\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports export help, parse errors, and print mode', async () => {
    const help = await execute({ script: 'export --help' });
    expect(help.stdout.text).toContain('Set environment variables');
    expect(help.stdout.text).toContain('usage: export [-p] name=value...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stdout.text).toContain('-p');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const error = await execute({ script: 'export --bogus' });
    expect(error.stdout.text).toBe('');
    expect(error.stderr.text).toContain('usage: export [-p] name=value...');
    expect(error.stderr.text).toContain('--help');
    expect(error.result.exitCode).toBe(1);

    const printMode = await execute({ script: 'export -p' });
    expect(printMode.stdout.text).toContain("export FOO='bar'");
    expect(printMode.stderr.text).toBe('');
    expect(printMode.result.exitCode).toBe(0);
  });

  it('supports unset help, parse errors, and unsetting values', async () => {
    const help = await execute({ script: 'unset --help' });
    expect(help.stdout.text).toContain('Unset environment variables');
    expect(help.stdout.text).toContain('usage: unset name...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const error = await execute({ script: 'unset' });
    expect(error.stdout.text).toBe('');
    expect(error.stderr.text).toContain('unset: missing operand');
    expect(error.stderr.text).toContain('usage: unset name...');
    expect(error.result.exitCode).toBe(1);

    const unsetResult = await execute({ script: 'unset FOO' });
    expect(unsetResult.stdout.text).toBe('');
    expect(unsetResult.stderr.text).toBe('');
    expect(unsetResult.result.exitCode).toBe(0);

    const verifyUnset = await execute({ script: 'env FOO' });
    expect(verifyUnset.stdout.text).toBe('');
    expect(verifyUnset.stderr.text).toBe('');
    expect(verifyUnset.result.exitCode).toBe(0);
  });

  it('supports which help and parse errors', async () => {
    const help = await execute({ script: 'which --help' });
    expect(help.stdout.text).toContain('Locate a command');
    expect(help.stdout.text).toContain('usage: which command...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const error = await execute({ script: 'which --bogus' });
    expect(error.stdout.text).toBe('');
    expect(error.stderr.text).toContain('usage: which command...');
    expect(error.stderr.text).toContain('--help');
    expect(error.result.exitCode).toBe(1);
  });

  it('keeps which lookup behavior unchanged', async () => {
    const { result, stdout, stderr } = await execute({ script: 'which env missing-command' });

    expect(stdout.text).toContain('env: builtin command');
    expect(stderr.text).toContain('missing-command not found');
    expect(result.exitCode).toBe(1);
  });

  it('supports history help and parse errors', async () => {
    const help = await execute({ script: 'history --help' });
    expect(help.stdout.text).toContain('Display the command history list');
    expect(help.stdout.text).toContain('usage: history');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const error = await execute({ script: 'history --bogus' });
    expect(error.stdout.text).toBe('');
    expect(error.stderr.text).toContain('usage: history');
    expect(error.stderr.text).toContain('--help');
    expect(error.result.exitCode).toBe(1);
  });

  it('keeps history output stable', async () => {
    await execute({ script: 'echo one' });
    await execute({ script: 'echo two' });

    const { result, stdout, stderr } = await execute({ script: 'history' });

    expect(stdout.text).toContain('echo one');
    expect(stdout.text).toContain('echo two');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
