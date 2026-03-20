import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh mv', () => {
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

  it('moves files', async () => {
    await writeFile({ path: 'source.txt', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'mv source.txt target.txt',
    });

    const moved = await execute({
      script: 'test -e target.txt',
    });
    const original = await execute({
      script: 'test -e source.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(moved.result.exitCode).toBe(0);
    expect(original.result.exitCode).toBe(1);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mv source.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('mv: missing file operand');
    expect(stderr.text).toContain('usage: mv source destination');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mv --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Move or rename files');
    expect(stdout.text).toContain('usage: mv source destination');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
});
