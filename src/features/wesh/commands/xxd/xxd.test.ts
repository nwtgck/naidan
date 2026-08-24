import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import type { WeshFileHandle } from '@/features/wesh/types';
import { createReadHandleFromStream } from '@/features/wesh/utils/stream';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh xxd', () => {
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

  async function readFile({ path }: { path: string }): Promise<Uint8Array> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');
    let dir = rootHandle;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    const file = await (await dir.getFileHandle(fileName)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async function execute({
    script,
    stdinText,
    stdin,
  }: {
    script: string,
    stdinText?: string,
    stdin?: WeshFileHandle,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: stdin ?? createTestReadHandleFromText({ text: stdinText ?? '' }),
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

  it('supports Vim plain-output aliases', async () => {
    await writeFile({ path: 'input.bin', data: 'abc' });

    const postscript = await execute({ script: 'xxd -ps input.bin' });
    const plain = await execute({ script: 'xxd -plain input.bin' });
    const longPostscript = await execute({ script: 'xxd -postscript input.bin' });

    expect(postscript.stdout.text).toBe('616263\n');
    expect(plain.stdout.text).toBe('616263\n');
    expect(longPostscript.stdout.text).toBe('616263\n');
    expect(postscript.stderr.text).toBe('');
    expect(plain.stderr.text).toBe('');
    expect(longPostscript.stderr.text).toBe('');
    expect(postscript.result.exitCode).toBe(0);
    expect(plain.result.exitCode).toBe(0);
    expect(longPostscript.result.exitCode).toBe(0);
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

  it('treats a zero column count as the mode-specific default', async () => {
    await writeFile({ path: 'hello.bin', data: 'hello\n' });

    const normal = await execute({ script: 'xxd -c 0 hello.bin' });
    const plainPayload = new Uint8Array(31).fill(0x41);
    await writeFile({ path: 'plain.bin', data: plainPayload });
    const plain = await execute({ script: 'xxd -p -c 0 plain.bin' });

    expect(normal.stdout.text).toBe('00000000: 6865 6c6c 6f0a                           hello.\n');
    expect(plain.stdout.text).toBe(`${'41'.repeat(30)}\n41\n`);
    expect(normal.stderr.text).toBe('');
    expect(plain.stderr.text).toBe('');
    expect(normal.result.exitCode).toBe(0);
    expect(plain.result.exitCode).toBe(0);
  });

  it('treats a zero group size as ungrouped hexadecimal output', async () => {
    await writeFile({ path: 'letters.bin', data: 'ABCD' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -g 0 letters.bin',
    });

    expect(stdout.text.startsWith('00000000: 41424344')).toBe(true);
    expect(stdout.text).not.toContain('4142 4344');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('parses column and group counts as decimal even with leading zeroes', async () => {
    const payload = Uint8Array.from({ length: 30 }, (_, index) => index);
    await writeFile({ path: 'bytes.bin', data: payload });

    const columns = await execute({ script: 'xxd -c 020 bytes.bin' });
    const groups = await execute({ script: 'xxd -c 30 -g 020 bytes.bin' });
    const groupedHex = `${Array.from(payload.subarray(0, 20), byte => byte.toString(16).padStart(2, '0')).join('')} ${Array.from(payload.subarray(20), byte => byte.toString(16).padStart(2, '0')).join('')}`;

    expect(columns.stdout.text.split('\n')[1]).toMatch(/^00000014:/u);
    expect(groups.stdout.text.slice('00000000: '.length, '00000000: '.length + groupedHex.length)).toBe(groupedHex);
    expect(columns.stderr.text).toBe('');
    expect(groups.stderr.text).toBe('');
    expect(columns.result.exitCode).toBe(0);
    expect(groups.result.exitCode).toBe(0);
  });

  it('rejects non-decimal column and group counts', async () => {
    const columns = await execute({ script: 'xxd -c 0x10' });
    const groups = await execute({ script: 'xxd -g 0x2' });

    expect(columns.stderr.text).toContain("invalid column count: '0x10'");
    expect(groups.stderr.text).toContain("invalid group size: '0x2'");
    expect(columns.result.exitCode).toBe(1);
    expect(groups.result.exitCode).toBe(1);
  });

  it('adds a signed display offset without changing the input seek', async () => {
    await writeFile({ path: 'letters.bin', data: 'abcdef' });

    const positive = await execute({ script: 'xxd -s 2 -l 2 -o 0x10 letters.bin' });
    const negative = await execute({ script: 'xxd -l 2 -o -1 letters.bin' });

    expect(positive.stdout.text).toBe('00000012: 6364                                     cd\n');
    expect(negative.stdout.text).toBe('ffffffffffffffff: 6162                                     ab\n');
    expect(positive.stderr.text).toBe('');
    expect(negative.stderr.text).toBe('');
    expect(positive.result.exitCode).toBe(0);
    expect(negative.result.exitCode).toBe(0);
  });

  it('rejects an unsafe display offset', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -o 999999999999999999999',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("invalid display offset: '999999999999999999999'");
    expect(result.exitCode).toBe(1);
  });

  it('accepts a 64-bit length beyond the JavaScript safe-integer range', async () => {
    await writeFile({ path: 'letters.bin', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -l 0x7fffffffffffffff letters.bin',
    });

    expect(stdout.text).toBe('00000000: 6162 6364 6566                           abcdef\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts the bounded Vim xxd maximum column count', async () => {
    await writeFile({ path: 'bytes.bin', data: new Uint8Array(257).fill(0x41) });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -c 256 bytes.bin',
    });

    expect(stdout.text.split('\n').filter(line => line.length > 0)).toHaveLength(2);
    expect(stdout.text).toContain('00000100: 41');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects a column count above the bounded Vim xxd limit', async () => {
    await writeFile({ path: 'letters.bin', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -c 257 letters.bin',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("invalid column count: '257'");
    expect(result.exitCode).toBe(1);
  });

  it('accepts an uppercase hexadecimal length', async () => {
    await writeFile({ path: 'letters.bin', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -l 0X2 letters.bin',
    });

    expect(stdout.text).toBe('00000000: 6162                                     ab\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps display addresses exact beyond the JavaScript safe-integer range', async () => {
    await writeFile({ path: 'input.bin', data: new Uint8Array(17) });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -o 9007199254740992 input.bin',
    });

    expect(stdout.text).toBe(`\
20000000000000: 0000 0000 0000 0000 0000 0000 0000 0000  ................
20000000000010: 00                                       .
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects an out-of-range display offset before opening the output', async () => {
    await writeFile({ path: 'input.bin', data: 'A' });
    await writeFile({ path: 'dump.txt', data: 'preserve me' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -o 9223372036854775808 input.bin dump.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("invalid display offset: '9223372036854775808'");
    expect(new TextDecoder().decode(await readFile({ path: 'dump.txt' }))).toBe('preserve me');
    expect(result.exitCode).toBe(1);
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

  it('supports a negative forward seek relative to the end of an input file', async () => {
    await writeFile({ path: 'letters.bin', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -s -0x2 letters.bin',
    });

    expect(stdout.text).toBe('00000004: 6566                                     ef\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats a positive 64-bit seek beyond a regular file as end of input', async () => {
    await writeFile({ path: 'letters.bin', data: 'abc' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -s 0x7fffffffffffffff letters.bin',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('truncates a forward output for a valid 64-bit seek beyond end of input', async () => {
    await writeFile({ path: 'letters.bin', data: 'abc' });
    await writeFile({ path: 'dump.txt', data: 'stale' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -s 9007199254740992 letters.bin dump.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect((await readFile({ path: 'dump.txt' })).byteLength).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  it('supports a negative forward seek on regular-file stdin', async () => {
    await writeFile({ path: 'letters.bin', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -s -2 < letters.bin',
    });

    expect(stdout.text).toBe('00000004: 6566                                     ef\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects a negative forward seek before the beginning of an input file', async () => {
    await writeFile({ path: 'letters.bin', data: 'abc' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -s -4 letters.bin',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('xxd: letters.bin: Sorry, cannot seek.\n');
    expect(result.exitCode).toBe(1);
  });

  it('rejects a negative forward seek on standard input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -s -1',
      stdinText: 'ABC',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('xxd: stdin: Illegal seek\n');
    expect(result.exitCode).toBe(1);
  });

  it('rejects a forward seek on non-seekable standard input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -s 1',
      stdinText: 'ABC',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('xxd: stdin: Illegal seek\n');
    expect(result.exitCode).toBe(1);
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

  it('reverses plain hexadecimal input to binary with -r -p', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -p',
      stdinText: '41 42\n43\t00ff\n',
    });

    expect(Array.from(stdout.buffer)).toEqual([0x41, 0x42, 0x43, 0x00, 0xff]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches xxd plain reverse handling for malformed separators', async () => {
    const cases = [
      { input: '61zz62', expected: [0x61] },
      { input: '61z62', expected: [0x61, 0x62] },
      { input: 'a:b:c', expected: [] },
      { input: 'ab cd ef', expected: [0xab, 0xcd, 0xef] },
      { input: `\
a
b`, expected: [0xab] },
      { input: `\
zz
61zz62
77`, expected: [0x61, 0x77] },
      { input: '6z1', expected: [] },
      { input: '6 1z62', expected: [0x61, 0x62] },
    ] as const;

    for (const testCase of cases) {
      const { result, stdout, stderr } = await execute({
        script: 'xxd -r -p',
        stdinText: testCase.input,
      });

      expect(Array.from(stdout.buffer), testCase.input).toEqual(testCase.expected);
      expect(stderr.text, testCase.input).toBe('');
      expect(result.exitCode, testCase.input).toBe(0);
    }
  });

  it('treats nul bytes as input record boundaries in plain reverse mode', async () => {
    await writeFile({
      path: 'nul-boundaries.hex',
      data: Uint8Array.of(0x36, 0x31, 0x00, 0x36, 0x32, 0x00, 0x36, 0x00, 0x31),
    });
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -p nul-boundaries.hex',
    });

    expect(Array.from(stdout.buffer)).toEqual([0x61, 0x62, 0x61]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves plain reverse parser state across one-byte stream chunks', async () => {
    const input = Uint8Array.of(
      0x36, 0x31, 0x7a, 0x36, 0x32, 0x00,
      0x36, 0x0a, 0x31, 0x7a, 0x7a, 0x36, 0x32,
    );
    const stdin = createReadHandleFromStream({
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of input) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -p',
      stdin,
    });

    expect(Array.from(stdout.buffer)).toEqual([0x61, 0x62, 0x61]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('streams reversed bytes through a pipeline without closing stdout', async () => {
    const { result, stdout, stderr } = await execute({
      script: "printf '61z62' | xxd -r -p | xxd -p",
    });

    expect(stdout.text).toBe('6162\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reverses plain hexadecimal input from a file and ignores an odd trailing nibble', async () => {
    await writeFile({ path: 'dump.hex', data: '4142434\n' });

    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -p dump.hex',
    });

    expect(stdout.text).toBe('ABC');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reverses canonical xxd lines and materializes forward address gaps', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r',
      stdinText: `00000000: 4142 43                                  ABC
00000005: 44                                       D
`,
    });

    expect(Array.from(stdout.buffer)).toEqual([0x41, 0x42, 0x43, 0x00, 0x00, 0x44]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects an autoskip marker that is not part of BusyBox xxd reverse syntax', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r',
      stdinText: `*
00000004: 41  A
`,
    });

    expect(stdout.buffer.byteLength).toBe(0);
    expect(stderr.text).toContain("invalid number '*'");
    expect(result.exitCode).toBe(1);
  });

  it('does not combine normal-dump nibbles across whitespace', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r',
      stdinText: '00000000: 4 1\n',
    });

    expect(stdout.buffer.byteLength).toBe(0);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the hexadecimal prefix before address whitespace but ignores line bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r',
      stdinText: '00000002 : 41\n',
    });

    expect(Array.from(stdout.buffer)).toEqual([0x00, 0x00]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('adds the reverse-mode seek value to normal dump addresses', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -s 2',
      stdinText: '00000000: 4142  AB\n',
    });

    expect(Array.from(stdout.buffer)).toEqual([0x00, 0x00, 0x41, 0x42]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts a negative hexadecimal reverse offset when dump addresses remain non-negative', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -s -0x2',
      stdinText: '00000002: 4142  AB\n',
    });

    expect(stdout.text).toBe('AB');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects a negative reverse offset whose resulting output position is negative', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -s -1',
      stdinText: '00000000: 41  A\n',
    });

    expect(stdout.buffer.byteLength).toBe(0);
    expect(stderr.text).toContain('invalid output position');
    expect(result.exitCode).toBe(1);
  });

  it('rejects a negative plain reverse offset before writing output', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -p -s -1',
      stdinText: '41',
    });

    expect(stdout.buffer.byteLength).toBe(0);
    expect(stderr.text).toContain('invalid output position');
    expect(result.exitCode).toBe(1);
  });

  it('fails rather than overwriting earlier bytes for a backwards normal-dump address', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r',
      stdinText: `00000002: 43  C
00000000: 4142  AB
`,
    });

    expect(Array.from(stdout.buffer)).toEqual([0x00, 0x00, 0x43]);
    expect(stderr.text).toContain('cannot seek backwards in output');
    expect(result.exitCode).toBe(1);
  });

  it('reverses plain input incrementally without retaining the complete input', async () => {
    const payload = '41'.repeat(40 * 1024);
    const { result, stdout, stderr } = await execute({
      script: 'xxd -r -p',
      stdinText: payload,
    });

    expect(stdout.buffer.byteLength).toBe(40 * 1024);
    expect(stdout.buffer[0]).toBe(0x41);
    expect(stdout.buffer.at(-1)).toBe(0x41);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('writes a forward dump to an output file and truncates existing content', async () => {
    await writeFile({ path: 'input.bin', data: 'AB' });
    await writeFile({ path: 'dump.txt', data: 'stale trailing data' });

    const { result, stdout, stderr } = await execute({ script: 'xxd input.bin dump.txt' });

    expect(stdout.text).toBe('');
    expect(new TextDecoder().decode(await readFile({ path: 'dump.txt' })))
      .toBe('00000000: 4142                                     AB\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('does not truncate the output when the forward input cannot be opened', async () => {
    await writeFile({ path: 'dump.txt', data: 'preserve me' });

    const { result, stdout, stderr } = await execute({ script: 'xxd missing.bin dump.txt' });

    expect(stdout.text).toBe('');
    expect(new TextDecoder().decode(await readFile({ path: 'dump.txt' }))).toBe('preserve me');
    expect(stderr.text).toContain('xxd: missing.bin:');
    expect(result.exitCode).toBe(1);
  });

  it('patches an existing reverse output file without truncating its tail', async () => {
    await writeFile({ path: 'dump.txt', data: '00000002: 4142  AB\n' });
    await writeFile({ path: 'output.bin', data: '01234567' });

    const { result, stdout, stderr } = await execute({ script: 'xxd -r dump.txt output.bin' });

    expect(stdout.text).toBe('');
    expect(new TextDecoder().decode(await readFile({ path: 'output.bin' }))).toBe('01AB4567');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('does not create a reverse output when the input cannot be opened', async () => {
    const { result, stdout, stderr } = await execute({ script: 'xxd -r missing.hex output.bin' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xxd: missing.hex:');
    expect(result.exitCode).toBe(1);
    await expect(readFile({ path: 'output.bin' })).rejects.toThrow();
  });

  it('applies plain reverse seek to an output file', async () => {
    await writeFile({ path: 'plain.hex', data: '4142' });
    await writeFile({ path: 'output.bin', data: '012345' });

    const { result, stdout, stderr } = await execute({ script: 'xxd -r -p -s 3 plain.hex output.bin' });

    expect(stdout.text).toBe('');
    expect(new TextDecoder().decode(await readFile({ path: 'output.bin' }))).toBe('012AB5');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('attributes a forward output-open failure to the output operand', async () => {
    await writeFile({ path: 'input.bin', data: 'AB' });
    await rootHandle.getDirectoryHandle('output-dir', { create: true });

    const { result, stdout, stderr } = await execute({ script: 'xxd input.bin output-dir' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xxd: output-dir:');
    expect(stderr.text).not.toContain('xxd: input.bin:');
    expect(result.exitCode).toBe(1);
  });

  it('attributes a reverse output-open failure to the output operand', async () => {
    await writeFile({ path: 'dump.txt', data: '00000000: 4142  AB\n' });
    await rootHandle.getDirectoryHandle('output-dir', { create: true });

    const { result, stdout, stderr } = await execute({ script: 'xxd -r dump.txt output-dir' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xxd: output-dir:');
    expect(stderr.text).not.toContain('xxd: dump.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('truncates a forward output that names the same file as the input', async () => {
    await writeFile({ path: 'same.bin', data: 'AB' });

    const { result, stdout, stderr } = await execute({ script: 'xxd same.bin same.bin' });

    expect(stdout.text).toBe('');
    expect((await readFile({ path: 'same.bin' })).byteLength).toBe(0);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('truncates a forward output reached through a symlink to the input', async () => {
    await writeFile({ path: 'same.bin', data: 'AB' });
    const linked = await execute({ script: 'ln -s same.bin alias.bin' });
    expect(linked.result.exitCode).toBe(0);

    const { result, stdout, stderr } = await execute({ script: 'xxd same.bin alias.bin' });

    expect(stdout.text).toBe('');
    expect((await readFile({ path: 'same.bin' })).byteLength).toBe(0);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xxd --help',
    });

    expect(stdout.text).toContain('usage: xxd [OPTION]... [INFILE [OUTFILE]]');
    expect(stdout.text).toContain('-p');
    expect(stdout.text).toContain('-r');
    expect(stdout.text).toContain('-s SEEK');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
