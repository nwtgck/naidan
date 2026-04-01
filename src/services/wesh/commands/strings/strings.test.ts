import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh strings', () => {
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
    data: string | Uint8Array;
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
    stdinBytes?: Uint8Array;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const stdinText = stdinBytes === undefined ? '' : new TextDecoder().decode(stdinBytes);

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('extracts printable strings from binary input', async () => {
    await writeFile({
      path: 'sample.bin',
      data: new Uint8Array([0x00, 0x41, 0x6c, 0x70, 0x68, 0x61, 0x00, 0x42, 0x65, 0x74, 0x61, 0x00]),
    });

    const { result, stdout, stderr } = await execute({
      script: 'strings sample.bin',
    });

    expect(stdout.text).toBe(`\
Alpha
Beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports custom minimum length and file-name prefixes', async () => {
    await writeFile({
      path: 'left.bin',
      data: new Uint8Array([0x00, 0x41, 0x42, 0x43, 0x00]),
    });
    await writeFile({
      path: 'right.bin',
      data: new Uint8Array([0x00, 0x78, 0x79, 0x7a, 0x00]),
    });

    const { result, stdout, stderr } = await execute({
      script: 'strings -f -n 3 left.bin right.bin',
    });

    expect(stdout.text).toBe(`\
left.bin: ABC
right.bin: xyz
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports offset prefixes with -t x', async () => {
    await writeFile({
      path: 'offsets.bin',
      data: new Uint8Array([0x00, 0x41, 0x6c, 0x70, 0x68, 0x61, 0x00]),
    });

    const { result, stdout, stderr } = await execute({
      script: 'strings -t x offsets.bin',
    });

    expect(stdout.text).toBe('1 Alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports custom output separators', async () => {
    await writeFile({
      path: 'sample.bin',
      data: new Uint8Array([0x41, 0x6c, 0x70, 0x68, 0x61, 0x00, 0x42, 0x65, 0x74, 0x61]),
    });

    const { result, stdout, stderr } = await execute({
      script: "strings -s '|' sample.bin",
    });

    expect(stdout.text).toBe('Alpha|Beta|');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads from standard input by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'strings',
      stdinBytes: new Uint8Array([0x00, 0x54, 0x65, 0x73, 0x74, 0x00]),
    });

    expect(stdout.text).toBe('Test\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
