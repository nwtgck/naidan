import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh cat', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    name,
    data,
  }: {
    name: string;
    data: string | Uint8Array;
  }) {
    const handle = await rootHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText: string | undefined;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('reads from stdin when no file is given', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cat',
      stdinText: 'hello\nworld\n',
    });

    expect(stdout.text).toBe('hello\nworld\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves raw bytes when no formatting flags are used', async () => {
    const bytes = new Uint8Array([0x00, 0x41, 0x0a, 0xff, 0x42]);
    await writeFile({ name: 'binary.bin', data: bytes });

    const { result, stdout, stderr } = await execute({
      script: 'cat binary.bin',
      stdinText: undefined,
    });

    expect(Array.from(stdout.buffer)).toEqual(Array.from(bytes));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps stdin and file inputs in argument order when using -', async () => {
    await writeFile({ name: 'ordered.txt', data: 'file line\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat - ordered.txt',
      stdinText: 'stdin line\n',
    });

    expect(stdout.text).toBe('stdin line\nfile line\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not add a newline to files that do not end with one', async () => {
    await writeFile({ name: 'no-newline.txt', data: 'tail' });

    const { result, stdout, stderr } = await execute({
      script: 'cat no-newline.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('tail');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues after file errors and returns a failing exit code', async () => {
    await writeFile({ name: 'present.txt', data: 'present\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat missing.txt present.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('present\n');
    expect(stderr.text).toContain('cat: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('numbers all output lines with -n', async () => {
    await writeFile({ name: 'number.txt', data: 'alpha\n\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -n number.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('     1  alpha\n     2  \n     3  beta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('numbers only nonblank lines with -b even when -n is also present', async () => {
    await writeFile({ name: 'nonblank.txt', data: 'alpha\n\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -bn nonblank.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('     1  alpha\n\n     2  beta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('shows line endings with -E', async () => {
    await writeFile({ name: 'ends.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -E ends.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('alpha$\nbeta$\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('shows tabs with -T', async () => {
    await writeFile({ name: 'tabs.txt', data: 'a\tb\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -T tabs.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('a^Ib\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('shows nonprinting characters with -v', async () => {
    await writeFile({ name: 'visible.txt', data: new Uint8Array([0x01, 0x41, 0x0a]) });

    const { result, stdout, stderr } = await execute({
      script: 'cat -v visible.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('^AA\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('squeezes repeated blank lines with -s', async () => {
    await writeFile({ name: 'squeeze.txt', data: 'alpha\n\n\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -s squeeze.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('alpha\n\nbeta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -A as the combined visible output mode', async () => {
    await writeFile({ name: 'show-all.txt', data: new Uint8Array([0x01, 0x09, 0x0a]) });

    const { result, stdout, stderr } = await execute({
      script: 'cat -A show-all.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('^A^I$\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -e as the alias for -vE', async () => {
    await writeFile({ name: 'alias-e.txt', data: new Uint8Array([0x01, 0x0a]) });

    const { result, stdout, stderr } = await execute({
      script: 'cat -e alias-e.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('^A$\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -t as the alias for -vT', async () => {
    await writeFile({ name: 'alias-t.txt', data: 'a\tb\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -t alias-t.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('a^Ib\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts -u as a compatibility no-op', async () => {
    await writeFile({ name: 'compat.txt', data: 'compat\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -u compat.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('compat\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports the long option forms', async () => {
    await writeFile({ name: 'long.txt', data: new Uint8Array([0x01, 0x09, 0x0a, 0x0a]) });

    const { result, stdout, stderr } = await execute({
      script: 'cat --show-all --number --squeeze-blank long.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('     1  ^A^I$\n     2  $\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports each remaining long option individually', async () => {
    await writeFile({ name: 'long-individual.txt', data: new Uint8Array([0x01, 0x09, 0x0a, 0x0a]) });

    const numberAll = await execute({
      script: 'cat --number long-individual.txt',
      stdinText: undefined,
    });
    expect(numberAll.stdout.text).toBe('     1  \u0001\t\n     2  \n');

    const numberNonblank = await execute({
      script: 'cat --number-nonblank long-individual.txt',
      stdinText: undefined,
    });
    expect(numberNonblank.stdout.text).toBe('     1  \u0001\t\n\n');

    const showEnds = await execute({
      script: 'cat --show-ends long-individual.txt',
      stdinText: undefined,
    });
    expect(showEnds.stdout.text).toBe('\u0001\t$\n$\n');

    const showTabs = await execute({
      script: 'cat --show-tabs long-individual.txt',
      stdinText: undefined,
    });
    expect(showTabs.stdout.text).toBe('\u0001^I\n\n');

    const showNonprinting = await execute({
      script: 'cat --show-nonprinting long-individual.txt',
      stdinText: undefined,
    });
    expect(showNonprinting.stdout.text).toBe('^A\t\n\n');

    const squeezeBlank = await execute({
      script: 'cat --squeeze-blank long-individual.txt',
      stdinText: undefined,
    });
    expect(squeezeBlank.stdout.text).toBe('\u0001\t\n\n');

    const compat = await execute({
      script: 'cat --u long-individual.txt',
      stdinText: undefined,
    });
    expect(compat.stdout.text).toBe('\u0001\t\n\n');
  });

  it('lets -- stop option parsing so hyphen-prefixed names are treated as files', async () => {
    await writeFile({ name: '-n', data: 'literal file\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cat -- -n',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('literal file\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints usage guidance for invalid short options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cat -z',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("cat: invalid option -- 'z'");
    expect(stderr.text).toContain('usage: cat [OPTION]... [FILE]...');
    expect(stderr.text).toContain('--show-all');
    expect(result.exitCode).toBe(1);
  });

  it('prints usage guidance for invalid long options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cat --unknown',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("cat: unrecognized option '--unknown'");
    expect(stderr.text).toContain('usage: cat [OPTION]... [FILE]...');
    expect(stderr.text).toContain('--number-nonblank');
    expect(result.exitCode).toBe(1);
  });
});
