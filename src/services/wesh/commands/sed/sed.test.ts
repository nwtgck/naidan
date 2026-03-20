import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh sed', () => {
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
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function readFile({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText?: string;
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

  it('applies substitution scripts from the command line', async () => {
    await writeFile({ path: 'input.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: "sed 's/a/A/g' input.txt",
    });

    expect(stdout.text).toBe('AlphA\nbetA\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports multiple -e scripts with -n and p', async () => {
    await writeFile({ path: 'input.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: "sed -n -e 's/a/A/gp' -e '/beta/p' input.txt",
    });

    expect(stdout.text).toBe('AlphA\nbetA\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports script files with -f', async () => {
    await writeFile({ path: 'script.sed', data: '1d\ns/e/E/g\n' });
    await writeFile({ path: 'input.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: 'sed -f script.sed input.txt',
    });

    expect(stdout.text).toBe('bEta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports regex and range addresses', async () => {
    await writeFile({ path: 'input.txt', data: 'alpha\nbeta\ngamma\nomega\n' });

    const { result, stdout, stderr } = await execute({
      script: "sed '/beta/,/omega/d' input.txt",
    });

    expect(stdout.text).toBe('alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports in-place editing with backup suffixes', async () => {
    await writeFile({ path: 'input.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: "sed -i.bak 's/a/A/g' input.txt",
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'input.txt' })).toBe('AlphA\nbetA\n');
    expect(await readFile({ path: 'input.txt.bak' })).toBe('alpha\nbeta\n');
  });

  it('reads from stdin when no file is given', async () => {
    const { result, stdout, stderr } = await execute({
      script: "sed 's/a/A/g'",
      stdinText: 'alpha\nbeta\n',
    });

    expect(stdout.text).toBe('AlphA\nbetA\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports unsupported commands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: "sed 'q' input.txt",
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sed: unsupported sed command 'q'");
    expect(stderr.text).toContain('usage: sed');
    expect(result.exitCode).toBe(1);
  });
});
