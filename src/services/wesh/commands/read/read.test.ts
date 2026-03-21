import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh read', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports bad file descriptors', async () => {
    const help = await execute({
      script: 'read --help',
      stdinText: '',
    });
    const badFd = await execute({
      script: `\
read -u 9 value
status=$?
echo "$status"`,
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Read a line from standard input or a file descriptor into shell variables');
    expect(help.stdout.text).toContain('usage: read [-r] [-s] [-p prompt] [-u fd] [name...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(badFd.stderr.text).toContain('read: 9: bad file descriptor');
    expect(badFd.stdout.text).toBe('1\n');
    expect(badFd.result.exitCode).toBe(0);
  });

  it('supports -p prompts and rejects unsupported -s', async () => {
    const prompted = await execute({
      script: `\
read -p "Name: " value
echo "$value"`,
      stdinText: 'alice\n',
    });
    const silent = await execute({
      script: 'read -s secret',
      stdinText: 'value\n',
    });

    expect(prompted.stdout.text).toBe('Name: alice\n');
    expect(prompted.stderr.text).toBe('');
    expect(prompted.result.exitCode).toBe(0);

    expect(silent.stdout.text).toBe('');
    expect(silent.stderr.text).toContain('read: silent mode with -s is not supported in wesh yet');
    expect(silent.result.exitCode).toBe(1);
  });

  it('assigns REPLY verbatim when no variable names are given', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
read
echo "$REPLY"`,
      stdinText: '  keep  spacing  \n',
    });

    expect(stdout.text).toBe('  keep  spacing  \n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('splits fields across multiple names and leaves the remainder in the last one', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
read first second third
echo "$first|$second|$third"`,
      stdinText: 'alpha beta gamma delta\n',
    });

    expect(stdout.text).toBe('alpha|beta|gamma delta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('respects IFS and raw mode', async () => {
    const ifsResult = await execute({
      script: `\
IFS=, read first second
echo "$first|$second"`,
      stdinText: 'left,right,value\n',
    });
    const rawResult = await execute({
      script: `\
read -r value
echo "$value"`,
      stdinText: 'a\\ b\n',
    });

    expect(ifsResult.stdout.text).toBe('left|right,value\n');
    expect(ifsResult.stderr.text).toBe('');
    expect(ifsResult.result.exitCode).toBe(0);

    expect(rawResult.stdout.text).toBe('a\\ b\n');
    expect(rawResult.stderr.text).toBe('');
    expect(rawResult.result.exitCode).toBe(0);
  });

  it('preserves empty fields for non-whitespace IFS delimiters', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
IFS=, read first second third
echo "$first|$second|$third"`,
      stdinText: ',,tail\n',
    });

    expect(stdout.text).toBe('||tail\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles mixed whitespace and non-whitespace IFS delimiters', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
IFS=" ," read first second third
echo "$first|$second|$third"`,
      stdinText: '  alpha, beta,,gamma delta\n',
    });

    expect(stdout.text).toBe('alpha|beta|,gamma delta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('joins escaped characters by default and continues on backslash-newline', async () => {
    const escapedSpace = await execute({
      script: `\
read value
echo "$value"`,
      stdinText: 'a\\ b\n',
    });
    const continuedLine = await execute({
      script: `\
read value
echo "$value"`,
      stdinText: `\
hello\\
world
`,
    });

    expect(escapedSpace.stdout.text).toBe('a b\n');
    expect(escapedSpace.stderr.text).toBe('');
    expect(escapedSpace.result.exitCode).toBe(0);

    expect(continuedLine.stdout.text).toBe('helloworld\n');
    expect(continuedLine.stderr.text).toBe('');
    expect(continuedLine.result.exitCode).toBe(0);
  });

  it('returns failure on EOF while still assigning the partial line', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
read value
echo "$?"
echo "$value"`,
      stdinText: 'partial-without-newline',
    });

    expect(stdout.text).toBe('1\npartial-without-newline\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats empty IFS as no splitting', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
IFS= read first second
echo "$first|$second"`,
      stdinText: 'alpha beta gamma\n',
    });

    expect(stdout.text).toBe('alpha beta gamma|\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
