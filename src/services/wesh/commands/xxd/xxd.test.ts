import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh xxd', () => {
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
    stdinText,
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('renders a canonical xxd-style dump by default', async () => {
    await writeFile({ path: 'hello.bin', data: 'hello\n' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd hello.bin',
    });

    expect(stdout.text).toBe('00000000: 6865 6c6c 6f0a                           hello.\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports plain output with -p', async () => {
    await writeFile({ path: 'hello.bin', data: 'hello\n' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -p hello.bin',
    });

    expect(stdout.text).toBe('68656c6c6f0a\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports autoskip for repeated nul lines with -a', async () => {
    await writeFile({
      path: 'zeros.bin',
      data: new Uint8Array([
        ...new Uint8Array(16),
        ...new Uint8Array(16),
        0x41,
      ]),
    });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -a zeros.bin',
    });

    expect(stdout.text).toBe(`\
*
00000020: 41                                       A
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports seek and length limits', async () => {
    await writeFile({ path: 'letters.bin', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -s 2 -l 3 letters.bin',
    });

    expect(stdout.text).toBe('00000002: 6364 65                                  cde\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads from standard input when no file is provided', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -p',
      stdinText: 'AB',
    });

    expect(stdout.text).toBe('4142\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd --help',
    });

    expect(stdout.text).toContain('usage: xxd [OPTION]... [FILE]');
    expect(stdout.text).toContain('-p');
    expect(stdout.text).toContain('-s SEEK');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
