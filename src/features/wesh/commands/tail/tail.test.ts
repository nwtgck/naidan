import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('tail command', () => {
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
      script: 'tail -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a3

==> b.txt <==
b3
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
      script: 'tail -q -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a2
b2
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
      script: 'tail --silent --lines=1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a2
b2
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
      script: 'tail -v -n 1 a.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a2
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
      script: 'tail -n 1 - a.txt',
      stdinText: `\
stdin1
stdin2
`,
    });

    expect(stdout.text).toBe(`\
==> standard input <==
stdin2

==> a.txt <==
a2
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
      script: 'tail -n 1 a.txt missing.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toContain('==> a.txt <==');
    expect(stderr.text).toContain('tail: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('does not print headers for files that fail to open', async () => {
    await writeFile({ name: 'a.txt', data: `\
a1
a2
` });

    const { result, stdout, stderr } = await execute({
      script: 'tail -n 1 missing.txt a.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a2
`);
    expect(stderr.text).toContain('tail: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('supports NUL-delimited records with -z', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tail -z -n 2',
      stdinText: 'a\0b\0c\0',
    });

    expect(stdout.text).toBe('b\0c\0');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves invalid UTF-8 bytes and CRLF in line and NUL record modes', async () => {
    const lineResult = await execute({
      script: 'tail -n 1',
      stdinText: undefined,
      stdinBytes: Uint8Array.from([0x61, 0x0a, 0xff, 0x0d, 0x0a]),
    });
    const nulResult = await execute({
      script: 'tail -z -n 1',
      stdinText: undefined,
      stdinBytes: Uint8Array.from([0x61, 0x00, 0xfe, 0x00]),
    });

    expect([...lineResult.stdout.buffer]).toEqual([0xff, 0x0d, 0x0a]);
    expect(lineResult.stderr.text).toBe('');
    expect(lineResult.result.exitCode).toBe(0);
    expect([...nulResult.stdout.buffer]).toEqual([0xfe, 0x00]);
    expect(nulResult.stderr.text).toBe('');
    expect(nulResult.result.exitCode).toBe(0);
  });

  it('supports byte counts with -c', async () => {
    await writeFile({ name: 'bytes.txt', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -c 3 bytes.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('def');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports +N byte counts with -c', async () => {
    await writeFile({ name: 'bytes.txt', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -c +3 bytes.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('cdef');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports long byte-count options', async () => {
    await writeFile({ name: 'bytes.txt', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'tail --bytes=3 bytes.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('def');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU decimal and binary count suffixes', async () => {
    const input = `A${'b'.repeat(23)}C${'d'.repeat(999)}`;
    const decimal = await execute({
      script: 'tail -c 1kB',
      stdinText: input,
    });
    const binary = await execute({
      script: 'tail -c 1K',
      stdinText: input,
    });

    expect(decimal.stdout.text).toBe(`${'d'.repeat(999)}`.padStart(1000, 'C'));
    expect(decimal.stderr.text).toBe('');
    expect(decimal.result.exitCode).toBe(0);
    expect(binary.stdout.text).toBe(input);
    expect(binary.stderr.text).toBe('');
    expect(binary.result.exitCode).toBe(0);
  });

  it('uses the last modern line or byte count option', async () => {
    const byteThenLine = await execute({
      script: 'tail -c2 -n1',
      stdinText: `\
alpha
beta
`,
    });
    const lineThenByte = await execute({
      script: 'tail -n1 -c2',
      stdinText: `\
alpha
beta
`,
    });
    expect(byteThenLine.stdout.text).toBe('beta\n');
    expect(lineThenByte.stdout.text).toBe('a\n');
    expect(byteThenLine.stderr.text).toBe('');
    expect(lineThenByte.stderr.text).toBe('');
    expect(byteThenLine.result.exitCode).toBe(0);
    expect(lineThenByte.result.exitCode).toBe(0);
  });

  it('supports a standalone obsolete count but rejects mixed obsolete syntax', async () => {
    const standalone = await execute({
      script: 'tail -1',
      stdinText: `\
alpha
beta
`,
    });
    const byteThenObsoleteLine = await execute({
      script: 'tail -c2 -1',
      stdinText: `\
alpha
beta
`,
    });
    const obsoleteLineThenByte = await execute({
      script: 'tail -1 -c2',
      stdinText: `\
alpha
beta
`,
    });

    expect(standalone.stdout.text).toBe('beta\n');
    expect(standalone.stderr.text).toBe('');
    expect(standalone.result.exitCode).toBe(0);
    expect(byteThenObsoleteLine.stdout.text).toBe('');
    expect(byteThenObsoleteLine.stderr.text).toContain('tail: option used in invalid context -- 1');
    expect(byteThenObsoleteLine.result.exitCode).toBe(1);
    expect(obsoleteLineThenByte.stdout.text).toBe('');
    expect(obsoleteLineThenByte.stderr.text).toContain('tail: option used in invalid context -- 1');
    expect(obsoleteLineThenByte.result.exitCode).toBe(1);
  });

  it('uses leading +N as obsolete syntax only in its one-file context', async () => {
    await writeFile({ name: 'a.txt', data: `\
a
b
c
` });
    await writeFile({ name: '+2', data: 'named-plus\n' });

    const obsolete = await execute({
      script: 'tail +2 a.txt',
      stdinText: undefined,
    });
    const positional = await execute({
      script: 'tail -q +2 a.txt',
      stdinText: undefined,
    });

    expect(obsolete.stdout.text).toBe(`\
b
c
`);
    expect(obsolete.stderr.text).toBe('');
    expect(obsolete.result.exitCode).toBe(0);
    expect(positional.stdout.text).toBe(`\
named-plus
a
b
c
`);
    expect(positional.stderr.text).toBe('');
    expect(positional.result.exitCode).toBe(0);
  });

  it('prints the standard input header when verbose output can contain data', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'tail -v -n 1',
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
==> standard input <==
beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('suppresses every header when a zero tail count guarantees no output', async () => {
    await writeFile({ name: 'a.txt', data: 'alpha\n' });
    await writeFile({ name: 'b.txt', data: 'beta\n' });

    const lines = await execute({
      script: 'tail -v -n 0 a.txt b.txt',
      stdinText: undefined,
    });
    const bytes = await execute({
      script: 'tail -c 0 a.txt b.txt',
      stdinText: undefined,
    });

    expect(lines.stdout.text).toBe('');
    expect(bytes.stdout.text).toBe('');
    expect(lines.stderr.text).toBe('');
    expect(bytes.stderr.text).toBe('');
    expect(lines.result.exitCode).toBe(0);
    expect(bytes.result.exitCode).toBe(0);
  });


  it('does not inspect missing files or directories when a zero count suppresses all output', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });

    const { result, stdout, stderr } = await execute({
      script: 'tail -v -n 0 missing dir',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints an existing directory header before reporting its read error', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ name: 'data', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -n 1 dir data',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> dir <==

==> data <==
alpha
`);
    expect(stderr.text).toContain('tail: dir:');
    expect(result.exitCode).toBe(1);
  });

  it('stops after a directory read error in from-start line mode', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ name: 'data', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -n +1 dir data',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> dir <==
`);
    expect(stderr.text).toContain('tail: dir:');
    expect(result.exitCode).toBe(1);
  });

  it('stops after a directory read error in byte mode', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ name: 'data', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -c 1 dir data',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> dir <==
`);
    expect(stderr.text).toContain('tail: dir:');
    expect(result.exitCode).toBe(1);
  });

});
