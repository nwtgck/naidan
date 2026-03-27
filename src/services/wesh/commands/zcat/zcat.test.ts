import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

async function gzipBytes({
  text,
}: {
  text: string;
}): Promise<Uint8Array> {
  const inputBytes = new TextEncoder().encode(text);
  const compressedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (inputBytes.length > 0) {
        controller.enqueue(inputBytes);
      }
      controller.close();
    },

  }).pipeThrough(new CompressionStream('gzip') as any);
  const response = new Response(compressedStream);
  return new Uint8Array(await response.arrayBuffer());
}

describe('wesh zcat', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeBinaryFile({
    path,
    data,
  }: {
    path: string;
    data: Uint8Array;
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
    stdinBytes,
  }: {
    script: string;
    stdinBytes: Uint8Array | undefined;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromBytes({
        bytes: stdinBytes ?? new Uint8Array(0),
      }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('decompresses gzip files from file operands', async () => {
    await writeBinaryFile({
      path: 'payload.txt.gz',
      data: await gzipBytes({ text: 'hello zcat\n' }),
    });

    const { result, stdout, stderr } = await execute({
      script: 'zcat payload.txt.gz',
      stdinBytes: undefined,
    });

    expect(stdout.text).toBe('hello zcat\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('decompresses gzip data from stdin when no operands are provided', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'zcat',
      stdinBytes: await gzipBytes({ text: 'stdin payload\n' }),
    });

    expect(stdout.text).toBe('stdin payload\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'zcat --help',
      stdinBytes: undefined,
    });

    expect(stdout.text).toContain('Decompress and print files to standard output');
    expect(stdout.text).toContain('usage: zcat [file...]');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
