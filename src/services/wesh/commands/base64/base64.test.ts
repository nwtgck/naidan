import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh base64', () => {
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

  it('encodes stdin as base64', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64',
      stdinText: 'hello',
    });

    expect(stdout.text).toBe('aGVsbG8=\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('decodes wrapped base64 input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64 -d',
      stdinText: `\
aGVs
bG8=
`,
    });

    expect(stdout.text).toBe('hello');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports configurable wrap width and wrap disabling', async () => {
    const wrapped = await execute({
      script: 'base64 -w 4',
      stdinText: 'abcdefghijklmnop',
    });
    const unwrapped = await execute({
      script: 'base64 --wrap=0',
      stdinText: 'hello',
    });

    expect(wrapped.stdout.text).toBe(`\
YWJj
ZGVm
Z2hp
amts
bW5v
cA==
`);
    expect(unwrapped.stdout.text).toBe('aGVsbG8=\n');
    expect(wrapped.stderr.text).toBe('');
    expect(unwrapped.stderr.text).toBe('');
    expect(wrapped.result.exitCode).toBe(0);
    expect(unwrapped.result.exitCode).toBe(0);
  });

  it('reads files and preserves operand order with explicit stdin', async () => {
    await writeFile({ path: 'sample.txt', data: 'world' });

    const { result, stdout, stderr } = await execute({
      script: 'base64 - - sample.txt',
      stdinText: 'hello',
    });

    expect(stdout.text).toBe(`\
aGVsbG8=
d29ybGQ=
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports invalid base64 input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64 --decode',
      stdinText: '%%%invalid%%%',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('base64: standard input: invalid input');
    expect(result.exitCode).toBe(1);
  });

  it('continues after missing file errors and returns a failing exit code', async () => {
    await writeFile({ path: 'present.txt', data: 'ok' });

    const { result, stdout, stderr } = await execute({
      script: 'base64 missing.txt present.txt',
    });

    expect(stdout.text).toBe('b2s=\n');
    expect(stderr.text).toContain('base64: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64 --help',
    });

    expect(stdout.text).toContain('Base64 encode or decode data');
    expect(stdout.text).toContain('usage: base64 [OPTION]... [FILE]...');
    expect(stdout.text).toContain('--decode');
    expect(stdout.text).toContain('--wrap');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
