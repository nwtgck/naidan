import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh xargs', () => {
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

  it('prints help and rejects invalid options', async () => {
    const help = await execute({
      script: 'xargs --help',
      stdinText: '',
    });
    const invalid = await execute({
      script: 'xargs --bogus',
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Build and run command lines from standard input');
    expect(help.stdout.text).toContain('usage: xargs [-0rt] [-n MAX] [-I REPLSTR] [COMMAND [INITIAL-ARGS]...]');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("xargs: unrecognized option '--bogus'");
    expect(invalid.result.exitCode).toBe(2);
  });

  it('splits standard input using xargs-style quoting and escaping', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs echo',
      stdinText: 'alpha "two words" three\\ four\n',
    });

    expect(stdout.text).toBe('alpha two words three four\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports null-delimited input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -0 echo',
      stdinText: 'alpha beta\0two words\0',
    });

    expect(stdout.text).toBe('alpha beta two words\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('batches arguments with -n', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -n 2 echo prefix',
      stdinText: 'a b c d e\n',
    });

    expect(stdout.text).toBe(`\
prefix a b
prefix c d
prefix e
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports insert mode with -I using one line per execution', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -I {} echo X:{}:Y',
      stdinText: `\
  foo bar
baz
`,
    });

    expect(stdout.text).toBe(`\
X:foo bar:Y
X:baz:Y
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -r to skip execution when there is no input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -r echo prefix',
      stdinText: ' \n\t\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports malformed quoted input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs echo',
      stdinText: '"unterminated\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xargs: unmatched quote in input');
    expect(result.exitCode).toBe(1);
  });
});
