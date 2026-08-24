import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh strings', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string | Uint8Array,
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
    stdinBytes?: Uint8Array,
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

  it('validates minimum length and radix before a later help request', async () => {
    const invalidMinimum = await execute({ script: 'strings -n bogus --help' });
    const zeroMinimum = await execute({ script: 'strings -n 0 --help' });
    const invalidRadix = await execute({ script: 'strings -t z --help' });
    const helpFirst = await execute({ script: 'strings --help -n bogus' });
    const invalidEncodingBeforeHelp = await execute({ script: 'strings -e z --help' });

    for (const execution of [invalidMinimum, zeroMinimum, invalidRadix]) {
      expect(execution.result.exitCode).toBe(1);
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text.length).toBeGreaterThan(0);
    }
    for (const execution of [helpFirst, invalidEncodingBeforeHelp]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stderr.text).toBe('');
      expect(execution.stdout.text).toContain('usage: strings [OPTION]... [FILE]...');
    }
  });

  it('lets help stop argv processing before a later invalid option', async () => {
    const helpFirst = await execute({
      script: 'strings --help --definitely-invalid-option',
    });
    const shortHelpFirst = await execute({
      script: 'strings -h --definitely-invalid-option',
    });
    const invalidFirst = await execute({
      script: 'strings --definitely-invalid-option --help',
    });

    expect(helpFirst.stdout.text).toContain('Print the printable strings in files');
    expect(shortHelpFirst.stdout.text).toContain('Print the printable strings in files');
    expect(shortHelpFirst.stderr.text).toBe('');
    expect(shortHelpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stderr.text).toBe('');
    expect(helpFirst.result.exitCode).toBe(0);
    expect(invalidFirst.stdout.text).toBe('');
    expect(invalidFirst.stderr.text).toContain("unrecognized option '--definitely-invalid-option'");
    expect(invalidFirst.result.exitCode).toBe(1);
  });

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

  it('supports 8-bit and wide-character encodings without UTF-8 re-encoding', async () => {
    await writeFile({
      path: 'eight-bit.bin',
      data: new Uint8Array([0x00, 0x80, 0x81, 0x82, 0x00]),
    });
    await writeFile({
      path: 'little-endian.bin',
      data: new Uint8Array([0x00, 0x00, 0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x00, 0x00]),
    });

    const eightBit = await execute({ script: 'strings -e S -n 3 eight-bit.bin' });
    const littleEndian = await execute({ script: 'strings -e l -n 3 little-endian.bin' });

    expect(eightBit.stdout.buffer).toEqual(new Uint8Array([0x80, 0x81, 0x82, 0x0a]));
    expect(eightBit.stderr.text).toBe('');
    expect(eightBit.result.exitCode).toBe(0);

    expect(littleEndian.stdout.text).toBe('ABC\n');
    expect(littleEndian.stderr.text).toBe('');
    expect(littleEndian.result.exitCode).toBe(0);
  });

  it('resynchronizes wide strings at each byte boundary after invalid code units', async () => {
    await writeFile({
      path: 'unaligned-16.bin',
      data: new Uint8Array([0x00, 0x41, 0x00, 0x42, 0x00, 0x00]),
    });
    await writeFile({
      path: 'unaligned-32.bin',
      data: new Uint8Array([0x00, 0x41, 0x00, 0x42, 0x00, 0x00, 0x00, 0x00]),
    });

    const little16 = await execute({ script: 'strings -a -n 1 -e l -t d unaligned-16.bin' });
    const little32 = await execute({ script: 'strings -a -n 1 -e L -t d unaligned-32.bin' });

    expect(little16.stdout.text).toBe('      1 AB\n');
    expect(little16.stderr.text).toBe('');
    expect(little16.result.exitCode).toBe(0);
    expect(little32.stdout.text).toBe('      3 B\n');
    expect(little32.stderr.text).toBe('');
    expect(little32.result.exitCode).toBe(0);
  });

  it('resynchronizes an unaligned wide string across a stream chunk boundary', async () => {
    const data = new Uint8Array(65_542);
    data.set([0x41, 0x00, 0x42, 0x00, 0x43, 0x00], 65_535);
    await writeFile({ path: 'unaligned-boundary.bin', data });

    const { result, stdout, stderr } = await execute({
      script: 'strings -a -e l -t x -n 3 unaligned-boundary.bin',
    });

    expect(stdout.text).toBe('   ffff ABC\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves wide-string offsets across stream chunk boundaries', async () => {
    const data = new Uint8Array(65_542);
    data.set([0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x00, 0x00], 65_534);
    await writeFile({ path: 'boundary.bin', data });

    const { result, stdout, stderr } = await execute({
      script: 'strings -e l -t x -n 3 boundary.bin',
    });

    expect(stdout.text).toBe('   fffe ABC\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects minimum lengths that exceed the safe numeric range', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'strings -n 999999999999999999999999',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('minimum string length is too big');
    expect(result.exitCode).toBe(1);
  });

  it('treats tab as printable without requiring -w', async () => {
    await writeFile({
      path: 'tabs.bin',
      data: new Uint8Array([0x00, 0x09, 0x00, 0x41, 0x09, 0x42, 0x00]),
    });

    const plain = await execute({ script: 'strings -n 1 tabs.bin' });
    const withOffsets = await execute({ script: 'strings -n 1 -t d tabs.bin' });

    expect(plain.stdout.text).toBe('\t\nA\tB\n');
    expect(withOffsets.stdout.text).toBe('      1 \t\n      3 A\tB\n');
    expect(plain.stderr.text).toBe('');
    expect(withOffsets.stderr.text).toBe('');
    expect(plain.result.exitCode).toBe(0);
    expect(withOffsets.result.exitCode).toBe(0);
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

    expect(stdout.text).toBe('      1 Alpha\n');
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

  it('supports attached and legacy short option values', async () => {
    await writeFile({
      path: 'sample.bin',
      data: new Uint8Array([0x00, 0x41, 0x42, 0x43, 0x00]),
    });

    const attached = await execute({
      script: "strings -n3 -tx -s, sample.bin",
    });
    const legacy = await execute({
      script: 'strings -3 sample.bin',
    });

    expect(attached.stdout.text).toBe('      1 ABC,');
    expect(attached.stderr.text).toBe('');
    expect(attached.result.exitCode).toBe(0);
    expect(legacy.stdout.text).toBe('ABC\n');
    expect(legacy.stderr.text).toBe('');
    expect(legacy.result.exitCode).toBe(0);
  });

  it('rejects an explicit dash operand while retaining implicit stdin', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'strings -',
      stdinBytes: new Uint8Array([0x54, 0x65, 0x73, 0x74, 0x00]),
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("strings: invalid option -- '-'");
    expect(result.exitCode).toBe(1);
  });

  it('accepts only leading C-locale whitespace in minimum lengths', async () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await execute({
        script: `strings -n '${whitespace}1'`,
        stdinBytes: new TextEncoder().encode('abc\0'),
      });
      expect(execution.stdout.text).toBe('abc\n');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      const execution = await execute({
        script: `strings -n '${operand}'`,
        stdinBytes: new TextEncoder().encode('abc\0'),
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid minimum string length');
      expect(execution.result.exitCode).toBe(1);
    }
  });


  it('accepts an explicit positive sign in minimum lengths', async () => {
    const execution = await execute({
      script: 'strings -n +1',
      stdinBytes: new TextEncoder().encode('abc\0'),
    });

    expect(execution.stdout.text).toBe('abc\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

});
