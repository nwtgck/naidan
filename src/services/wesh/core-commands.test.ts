import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh core command parsing', () => {
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
    data: string;
  }) {
    const handle = await rootHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
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

  it('supports legacy head -N syntax', async () => {
    await writeFile({ name: 'head.txt', data: 'a\nb\nc\n' });

    const { result, stdout, stderr } = await execute({ script: 'head -2 head.txt' });

    expect(stdout.text).toBe('a\nb\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports head --bytes with inline values', async () => {
    await writeFile({ name: 'bytes.txt', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({ script: 'head --bytes=4 bytes.txt' });

    expect(stdout.text).toBe('abcd');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports legacy tail -N syntax', async () => {
    await writeFile({ name: 'tail.txt', data: 'a\nb\nc\n' });

    const { result, stdout, stderr } = await execute({ script: 'tail -2 tail.txt' });

    expect(stdout.text).toBe('b\nc\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports tail +N syntax to start from a specific line', async () => {
    await writeFile({ name: 'tail-plus.txt', data: 'a\nb\nc\n' });

    const { result, stdout, stderr } = await execute({ script: 'tail +2 tail-plus.txt' });

    expect(stdout.text).toBe('b\nc\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports command -v through the shared parser', async () => {
    const { result, stdout, stderr } = await execute({ script: 'command -v cat' });

    expect(stdout.text).toBe('cat\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
