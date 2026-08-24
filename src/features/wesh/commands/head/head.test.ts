import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('head command', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    name,
    data,
  }: {
    name: string,
    data: string,
  }) {
    const handle = await rootHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinText,
    stdinBytes,
  }: {
    script: string,
    stdinText: string | undefined,
    stdinBytes?: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: stdinBytes === undefined
        ? createTestReadHandleFromText({ text: stdinText ?? '' })
        : createTestReadHandleFromBytes({ bytes: stdinBytes }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints headers for multiple files by default', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
a3
` });
    await writeFile({ name: 'b.txt', data: `\
b1
b2
b3
` });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a1

==> b.txt <==
b1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('suppresses headers with -q', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
` });
    await writeFile({ name: 'b.txt', data: `\
b1
b2
` });

    const { result, stdout, stderr } = await execute({
      script: 'head -q -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a1
b1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports long option aliases for header and line selection', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
` });
    await writeFile({ name: 'b.txt', data: `\
b1
b2
` });

    const { result, stdout, stderr } = await execute({
      script: 'head --silent --lines=1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a1
b1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('forces headers with -v for a single file', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
` });

    const { result, stdout, stderr } = await execute({
      script: 'head -v -n 1 a.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats - as stdin among files', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
` });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 1 - a.txt',
      stdinText: `\
stdin1
stdin2
`,
    });

    expect(stdout.text).toBe(`\
==> standard input <==
stdin1

==> a.txt <==
a1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero when any file is missing', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
` });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 1 a.txt missing.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toContain('==> a.txt <==');
    expect(stderr.text).toContain('head: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('does not print headers for files that fail to open', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
` });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 1 missing.txt a.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a1
`);
    expect(stderr.text).toContain('head: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('supports NUL-delimited records with -z', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'head -z -n 2',
      stdinText: 'a\0b\0c\0',
    });

    expect(stdout.text).toBe('a\0b\0');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves invalid UTF-8 bytes and CRLF in line and NUL record modes', async () => {
    const lineResult = await execute({
      script: 'head -n 1',
      stdinText: undefined,
      stdinBytes: Uint8Array.from([0xff, 0x0d, 0x0a, 0x61, 0x0a]),
    });
    const nulResult = await execute({
      script: 'head -z -n 1',
      stdinText: undefined,
      stdinBytes: Uint8Array.from([0xfe, 0x00, 0x61, 0x00]),
    });

    expect([...lineResult.stdout.buffer]).toEqual([0xff, 0x0d, 0x0a]);
    expect(lineResult.stderr.text).toBe('');
    expect(lineResult.result.exitCode).toBe(0);
    expect([...nulResult.stdout.buffer]).toEqual([0xfe, 0x00]);
    expect(nulResult.stderr.text).toBe('');
    expect(nulResult.result.exitCode).toBe(0);
  });

  it('accepts an explicit plus sign for line and byte counts', async () => {
    const linesResult = await execute({
      script: 'head -n +2',
      stdinText: `\
alpha
beta
gamma
`,
    });
    const bytesResult = await execute({
      script: 'head -c +2',
      stdinText: 'abcdef',
    });

    expect(linesResult.stdout.text).toBe(`\
alpha
beta
`);
    expect(linesResult.stderr.text).toBe('');
    expect(linesResult.result.exitCode).toBe(0);
    expect(bytesResult.stdout.text).toBe('ab');
    expect(bytesResult.stderr.text).toBe('');
    expect(bytesResult.result.exitCode).toBe(0);
  });

  it('omits the requested number of trailing lines and bytes for negative counts', async () => {
    const linesResult = await execute({
      script: 'head -n -1',
      stdinText: `\
alpha
beta
gamma`,
    });
    const bytesResult = await execute({
      script: 'head -c -2',
      stdinText: 'abcdef',
    });

    expect(linesResult.stdout.text).toBe(`\
alpha
beta
`);
    expect(linesResult.stderr.text).toBe('');
    expect(linesResult.result.exitCode).toBe(0);
    expect(bytesResult.stdout.text).toBe('abcd');
    expect(bytesResult.stderr.text).toBe('');
    expect(bytesResult.result.exitCode).toBe(0);
  });

  it('rejects invalid line counts with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'head --lines=1x',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("head: invalid number of lines: '1x'");
    expect(stderr.text).toContain('usage: head');
    expect(result.exitCode).toBe(1);
  });

  it('supports GNU decimal and binary count suffixes', async () => {
    const input = `${'a'.repeat(999)}B${'c'.repeat(24)}D`;
    const decimal = await execute({
      script: 'head -c 1kB',
      stdinText: input,
    });
    const binary = await execute({
      script: 'head -c 1KiB',
      stdinText: input,
    });

    expect(decimal.stdout.text).toBe(`${'a'.repeat(999)}B`);
    expect(decimal.stderr.text).toBe('');
    expect(decimal.result.exitCode).toBe(0);
    expect(binary.stdout.text).toBe(`${'a'.repeat(999)}B${'c'.repeat(24)}`);
    expect(binary.stderr.text).toBe('');
    expect(binary.result.exitCode).toBe(0);
  });

  it('uses the last modern line or byte count option', async () => {
    const byteThenLine = await execute({
      script: 'head -c2 -n1',
      stdinText: `\
alpha
beta
`,
    });
    const lineThenByte = await execute({
      script: 'head -n1 -c2',
      stdinText: `\
alpha
beta
`,
    });
    const obsoleteLineThenByte = await execute({
      script: 'head -1 -c2',
      stdinText: `\
alpha
beta
`,
    });

    expect(byteThenLine.stdout.text).toBe('alpha\n');
    expect(lineThenByte.stdout.text).toBe('al');
    expect(obsoleteLineThenByte.stdout.text).toBe('al');
    expect(byteThenLine.stderr.text).toBe('');
    expect(lineThenByte.stderr.text).toBe('');
    expect(obsoleteLineThenByte.stderr.text).toBe('');
    expect(byteThenLine.result.exitCode).toBe(0);
    expect(lineThenByte.result.exitCode).toBe(0);
    expect(obsoleteLineThenByte.result.exitCode).toBe(0);
  });

  it('rejects obsolete line-count syntax after another option', async () => {
    const result = await execute({
      script: 'head -c2 -1',
      stdinText: `\
alpha
beta
`,
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('head: invalid trailing option -- 1');
    expect(result.result.exitCode).toBe(1);
  });

  it('prints the standard input header when verbose is forced without operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'head -v -n 1',
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
==> standard input <==
alpha
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('preserves unread stdin bytes across repeated byte-limited operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'head -c 1 - -',
      stdinText: 'abc',
    });

    expect(stdout.text).toBe(`\
==> standard input <==
a
==> standard input <==
b`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('validates zero-count operands without reading existing directories', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ name: 'data', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 0 missing dir data',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> dir <==

==> data <==
`);
    expect(stderr.text).toContain('head: missing:');
    expect(stderr.text).not.toContain('head: dir:');
    expect(result.exitCode).toBe(1);
  });

  it('prints an existing directory header before reporting its read error', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ name: 'data', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 1 dir data',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> dir <==

==> data <==
alpha
`);
    expect(stderr.text).toContain('head: dir:');
    expect(result.exitCode).toBe(1);
  });

});
