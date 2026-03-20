import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh test', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function mkdir({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

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

  it('supports string truthiness and equality operators', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test value
echo $?
test alpha = alpha
echo $?
test alpha != beta
echo $?`,
    });

    expect(stdout.text).toBe('0\n0\n0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports bare operand truthiness and negation', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test ""
echo $?
test ! ""
echo $?
[ ! value ]
echo $?`,
    });

    expect(stdout.text).toBe('1\n0\n1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats no-argument test as false and keeps -a higher precedence than -o', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test
echo $?
test value -o "" -a ""
echo $?
test "" -o value -a ""
echo $?`,
    });

    expect(stdout.text).toBe('1\n0\n1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports integer comparisons including -l string length', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test 5 -gt 3
echo $?
test -l alpha -eq 5
echo $?
test 3 -le 1
echo $?`,
    });

    expect(stdout.text).toBe('0\n0\n1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports logical composition with !, -a, -o, and parentheses via bracket syntax', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
[ \\( alpha = beta -o alpha = alpha \\) -a ! -z value ]
echo $?
[ ]
echo $?`,
    });

    expect(stdout.text).toBe('0\n1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches symlink semantics for file predicates', async () => {
    await writeFile({ path: 'target.txt', data: 'payload' });
    await mkdir({ path: 'dir' });
    await wesh.vfs.symlink({
      path: '/target.link',
      targetPath: '/target.txt',
    });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dir',
    });

    const { result, stdout, stderr } = await execute({
      script: `\
test -L target.link
echo $?
test -f target.link
echo $?
test -d dir.link
echo $?
test -L missing.link
echo $?`,
    });

    expect(stdout.text).toBe('0\n0\n0\n1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -h as an alias for -L on symlinks', async () => {
    await writeFile({ path: 'real.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/real.link',
      targetPath: '/real.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: `\
test -h real.link
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports file comparisons and special file predicates', async () => {
    await writeFile({ path: 'older.txt', data: 'old' });
    await new Promise<void>(resolve => {
      setTimeout(resolve, 5);
    });
    await writeFile({ path: 'newer.txt', data: 'new' });
    await wesh.vfs.symlink({
      path: '/same.link',
      targetPath: '/older.txt',
    });
    await wesh.vfs.mknod({
      path: '/pipe.fifo',
      type: 'fifo',
    });
    await wesh.vfs.mknod({
      path: '/tty.dev',
      type: 'chardev',
    });

    const { result, stdout, stderr } = await execute({
      script: `\
test older.txt -ef same.link
echo $?
test newer.txt -nt older.txt
echo $?
test -p pipe.fifo
echo $?
test -c tty.dev
echo $?`,
    });

    expect(stdout.text).toBe('0\n0\n0\n0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports access predicates and empty-string checks', async () => {
    await writeFile({ path: 'script.sh', data: 'echo hi\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
test -r script.sh
echo $?
test -w script.sh
echo $?
test -x script.sh
echo $?
test -z ""
echo $?`,
    });

    expect(stdout.text).toBe('0\n0\n1\n0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns exit status 2 for syntax errors', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test 1 -eq
echo $?
[ alpha = alpha
echo $?
test value extra
echo $?`,
    });

    expect(stdout.text).toBe('2\n2\n2\n');
    expect(stderr.text).toContain("test: expected integer after '-eq'");
    expect(stderr.text).toContain('usage: test EXPRESSION');
    expect(stderr.text).toContain("[: missing ']'");
    expect(stderr.text).toContain('usage: [ EXPRESSION ]');
    expect(stderr.text).toContain("test: unexpected argument 'extra'");
    expect(result.exitCode).toBe(0);
  });

  it('prints help for test and bracket forms', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test --help
[ --help ]`,
    });

    expect(stdout.text).toContain('Evaluate shell conditional expressions');
    expect(stdout.text).toContain('usage: test EXPRESSION');
    expect(stdout.text).toContain('usage: [ EXPRESSION ]');
    expect(stdout.text).toContain('--help');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
