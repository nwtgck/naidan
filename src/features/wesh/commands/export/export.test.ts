import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh export', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { FOO: 'bar' },
    });
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

  it('prints help and reports invalid options', async () => {
    const help = await execute({ script: 'export --help' });
    expect(help.stdout.text).toContain('Set environment variables');
    expect(help.stdout.text).toContain('usage: export [-pn] [name[=value]...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stdout.text).toContain('-p');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'export --bogus' });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('export: unrecognized option');
    expect(invalid.stderr.text).toContain('usage: export [-pn] [name[=value]...]');
    expect(invalid.stderr.text).toContain('--help');
    expect(invalid.result.exitCode).toBe(2);
  });

  it('keeps print mode behavior unchanged', async () => {
    const { result, stdout, stderr } = await execute({ script: 'export -p' });

    expect(stdout.text).toContain("export FOO='bar'");
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid shell identifiers without applying them', async () => {
    const { result, stdout, stderr } = await execute({
      script: `export 'bad-name=value'
printf 'status=%s\n' "$?"
`,
    });

    expect(stdout.text).toBe('status=1\n');
    expect(stderr.text).toContain("export: `bad-name=value': not a valid identifier");
    expect(result.exitCode).toBe(0);
  });

  it('prints variables in C byte order instead of locale collation order', async () => {
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { Z: '1', a: '2', A: '3', _x: '4', aa: '5' },
    });
    await wesh.init();

    const { result, stdout, stderr } = await execute({ script: 'export -p' });
    const selected = stdout.text
      .split('\n')
      .filter((line) => /^export (?:A|Z|_x|a|aa)=/u.test(line));

    expect(selected).toEqual([
      "export A='3'",
      "export Z='1'",
      "export _x='4'",
      "export a='2'",
      "export aa='5'",
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints exported variables when invoked without operands', async () => {
    const { result, stdout, stderr } = await execute({ script: 'export' });

    expect(stdout.text).toContain("export FOO='bar'");
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('stops option parsing after the first export operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: `x=1; export x -p >/dev/null 2>/dev/null; printf '%s|%s\\n' "$?" "$x"`,
    });

    expect(stdout.text).toBe('1|1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

});
