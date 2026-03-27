import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh ps', () => {
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

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'ps --help' });
    const invalid = await execute({ script: 'ps --bogus' });
    const extra = await execute({ script: 'ps extra' });
    const badFormat = await execute({ script: 'ps -o nope' });
    const badPid = await execute({ script: 'ps -p abc' });

    expect(help.stdout.text).toContain('Report process status');
    expect(help.stdout.text).toContain('usage: ps [-eA] [-p PIDLIST] [-o FORMAT]');
    expect(help.stdout.text).toContain('-p');
    expect(help.stdout.text).toContain('-o');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("ps: unrecognized option '--bogus'");
    expect(invalid.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain('ps: extra operand');
    expect(extra.result.exitCode).toBe(1);

    expect(badFormat.stdout.text).toBe('');
    expect(badFormat.stderr.text).toContain('ps: unknown user-defined format specifier: nope');
    expect(badFormat.result.exitCode).toBe(1);

    expect(badPid.stdout.text).toBe('');
    expect(badPid.stderr.text).toContain('ps: invalid process ID: abc');
    expect(badPid.result.exitCode).toBe(1);
  });

  it('shows the current process group by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'ps',
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('PID');
    expect(stdout.text).toContain('PGID');
    expect(stdout.text).toContain('ARGS');
    expect(stdout.text).toContain('wesh');
    expect(stdout.text).toContain('ps');
  });

  it('supports -e and custom output formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'ps -e -o pid,ppid,pgid,stat,args',
    });

    const lines = stdout.text.trimEnd().split('\n');
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(lines[0]).toBe('PID PPID PGID STAT ARGS');
    expect(lines.some(line => line.includes('wesh') && line.includes('ps -e -o pid,ppid,pgid,stat,args'))).toBe(true);
  });

  it('supports selecting specific process IDs with -p', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;

    const { result, stdout, stderr } = await execute({
      script: `ps -p ${shellPid} -o pid,args`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('PID ARGS');
    expect(stdout.text).toContain(`${shellPid}`);
    expect(stdout.text).toContain('wesh');
  });

  it('can show background processes with -e', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sleep 0.2 &
ps -e -o pid,stat,args`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain('[1] background');
    expect(stdout.text).toContain('PID STAT ARGS');
    expect(stdout.text).toContain('wesh sleep 0.2');
    expect(stdout.text).toContain('R');
  });
});
