import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh comm', () => {
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

  async function execute({
    script,
    stdinText = '',
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports missing operands', async () => {
    const help = await execute({ script: 'comm --help' });
    const missing = await execute({ script: 'comm only-one-file.txt' });

    expect(help.stdout.text).toContain('Compare two sorted files line by line');
    expect(help.stdout.text).toContain('usage: comm [OPTION]... FILE1 FILE2');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('comm: missing operand');
    expect(missing.stderr.text).toContain('usage: comm [OPTION]... FILE1 FILE2');
    expect(missing.result.exitCode).toBe(1);
  });

  it('compares sorted files and supports column suppression', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
alpha
beta
delta
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
beta
gamma
delta
`,
    });

    const plain = await execute({ script: 'comm left.txt right.txt' });
    const suppressed = await execute({ script: 'comm -1 left.txt right.txt' });

    expect(plain.stderr.text).toBe('');
    expect(suppressed.stderr.text).toBe('');
    expect(plain.result.exitCode).toBe(0);
    expect(suppressed.result.exitCode).toBe(0);
    expect(plain.stdout.text).toBe('alpha\n\t\tbeta\ndelta\n\tgamma\n\tdelta\n');
    expect(suppressed.stdout.text).toBe('\tbeta\ngamma\ndelta\n');
  });

  it('accepts stdin for one of the inputs', async () => {
    await writeFile({
      path: 'right.txt',
      data: 'beta\n',
    });

    const { result, stdout, stderr } = await execute({
      script: 'comm - right.txt',
      stdinText: `\
alpha
beta
`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('alpha\n\t\tbeta\n');
  });

  it('rejects repeated stdin operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'comm - -',
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('comm: -: Bad file descriptor');
    expect(result.exitCode).toBe(1);
  });
});
