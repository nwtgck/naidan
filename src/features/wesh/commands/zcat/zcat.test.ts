import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

async function gzipBytes({
  text,
}: {
  text: string,
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
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeBinaryFile({
    path,
    data,
  }: {
    path: string,
    data: Uint8Array,
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
    script: string,
    stdinBytes: Uint8Array | undefined,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
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
    expect(stdout.text).toContain('usage: zcat [OPTION]... [FILE]...');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('accepts gzip compatibility flags and force-copies plain input', async () => {
    await writeBinaryFile({
      path: 'plain.txt',
      data: new TextEncoder().encode('plain input\n'),
    });
    await writeBinaryFile({
      path: 'payload.gz',
      data: await gzipBytes({ text: 'compressed input\n' }),
    });

    const plain = await execute({
      script: 'zcat -qf plain.txt',
      stdinBytes: undefined,
    });
    const compressed = await execute({
      script: 'zcat -cd payload.gz',
      stdinBytes: undefined,
    });

    expect(plain.stdout.text).toBe('plain input\n');
    expect(plain.stderr.text).toBe('');
    expect(plain.result.exitCode).toBe(0);
    expect(compressed.stdout.text).toBe('compressed input\n');
    expect(compressed.stderr.text).toBe('');
    expect(compressed.result.exitCode).toBe(0);
  });

  it('preserves decompressed output before CRC and trailing-garbage errors', async () => {
    const valid = await gzipBytes({ text: 'partial output\n' });
    const badCrc = valid.slice();
    const crcOffset = badCrc.byteLength - 8;
    const crcByte = badCrc[crcOffset];
    if (crcByte === undefined) {
      throw new Error('gzip fixture is missing its CRC trailer');
    }
    badCrc[crcOffset] = crcByte ^ 0xFF;
    const trailing = new Uint8Array(valid.byteLength + 7);
    trailing.set(valid, 0);
    trailing.set(new TextEncoder().encode('garbage'), valid.byteLength);
    await writeBinaryFile({ path: 'bad-crc.gz', data: badCrc });
    await writeBinaryFile({ path: 'trailing.gz', data: trailing });

    const crc = await execute({
      script: 'zcat bad-crc.gz',
      stdinBytes: undefined,
    });
    const garbage = await execute({
      script: 'zcat trailing.gz',
      stdinBytes: undefined,
    });

    expect(crc.stdout.text).toBe('partial output\n');
    expect(crc.stderr.text).not.toBe('');
    expect(crc.result.exitCode).toBe(1);
    expect(garbage.stdout.text).toBe('partial output\n');
    expect(garbage.stderr.text).not.toBe('');
    expect(garbage.result.exitCode).toBe(2);
  });

  it('treats an incomplete following gzip member as invalid instead of trailing garbage', async () => {
    const valid = await gzipBytes({ text: 'first member\n' });
    const incompleteNextHeader = new Uint8Array(valid.byteLength + 3);
    incompleteNextHeader.set(valid, 0);
    incompleteNextHeader.set([0x1F, 0x8B, 0x08], valid.byteLength);

    const result = await execute({
      script: 'zcat',
      stdinBytes: incompleteNextHeader,
    });

    expect(result.stdout.text).toBe('first member\n');
    expect(result.stderr.text).not.toBe('');
    expect(result.stderr.text).not.toContain('trailing garbage ignored');
    expect(result.result.exitCode).toBe(1);
  });

  it('preserves all confirmed output before a truncated gzip footer', async () => {
    const payload = `${'0123456789abcdef'.repeat(256)}\n`;
    const valid = await gzipBytes({ text: payload });
    const truncated = valid.subarray(0, valid.byteLength - 3);

    const result = await execute({
      script: 'zcat',
      stdinBytes: truncated,
    });

    expect(result.stdout.text).toBe(payload);
    expect(result.stderr.text).not.toBe('');
    expect(result.result.exitCode).toBe(1);
  });

  it('returns a failure status after invalid gzip input while preserving prior output', async () => {
    await writeBinaryFile({
      path: 'valid.gz',
      data: await gzipBytes({ text: 'valid output\n' }),
    });
    await writeBinaryFile({
      path: 'invalid.gz',
      data: new TextEncoder().encode('not gzip\n'),
    });

    const { result, stdout, stderr } = await execute({
      script: 'zcat valid.gz invalid.gz',
      stdinBytes: undefined,
    });

    expect(stdout.text).toBe('valid output\n');
    expect(stderr.text).not.toBe('');
    expect(result.exitCode).toBe(1);
  });

});
