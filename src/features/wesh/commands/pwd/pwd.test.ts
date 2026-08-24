import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh pwd', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
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

  it('prints cwd', async () => {
    const normal = await execute({ script: 'pwd' });

    expect(normal.stdout.text).toBe('/\n');
    expect(normal.stderr.text).toBe('');
    expect(normal.result.exitCode).toBe(0);
  });

  it('accepts logical and physical mode options', async () => {
    const logical = await execute({ script: 'pwd -L' });
    const physical = await execute({ script: 'pwd -P' });

    expect(logical.stdout.text).toBe('/\n');
    expect(logical.stderr.text).toBe('');
    expect(logical.result.exitCode).toBe(0);
    expect(physical.stdout.text).toBe('/\n');
    expect(physical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);
  });

  it('distinguishes logical and physical paths through symbolic links', async () => {
    const result = await execute({
      script: `\
mkdir -p sandbox/real
ln -s real sandbox/link
cd sandbox/link
pwd -L
pwd -P
pwd -P -L
pwd -L -P`,
    });

    expect(result.stdout.text).toBe(`\
/sandbox/link
/sandbox/real
/sandbox/link
/sandbox/real
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('stops parsing options after the first ignored operand like Bash', async () => {
    const result = await execute({
      script: `\
mkdir -p sandbox/real
ln -s real sandbox/link
cd sandbox/link
pwd ignored -P
pwd -P ignored -L
pwd ignored --help`,
    });

    expect(result.stdout.text).toBe(`\
/sandbox/link
/sandbox/real
/sandbox/link
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('prints help, ignores extra operands, and rejects invalid options', async () => {
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

    expect(extra.stdout.text).toBe('/\n');
    expect(extra.stderr.text).toBe('');
    expect(extra.result.exitCode).toBe(0);
  });
});
