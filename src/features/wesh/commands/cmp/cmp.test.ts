import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import type { WeshFileHandle } from '@/features/wesh/types';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh cmp', () => {
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
    data: string | Uint8Array,
  }): Promise<void> {
    const handle = await rootHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinBytes,
    stdinHandle,
  }: {
    script: string,
    stdinBytes?: Uint8Array,
    stdinHandle?: WeshFileHandle,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdinHandle ?? createTestReadHandleFromBytes({
        bytes: stdinBytes ?? new Uint8Array(),
      }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return {
      result,
      stdout,
      stderr,
    };
  }

  it('validates option byte counts before a later help request', async () => {
    const invalidIgnore = await execute({ script: 'cmp -i bad --help' });
    const invalidLimit = await execute({ script: 'cmp -n bad --help' });
    const helpFirst = await execute({ script: 'cmp --help -i bad -n bad' });

    for (const execution of [invalidIgnore, invalidLimit]) {
      expect(execution.result.exitCode).toBe(2);
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).not.toBe('');
    }
    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');
  });

  it('prints help and version information', async () => {
    const help = await execute({ script: 'cmp --help' });
    const version = await execute({ script: 'cmp --version' });

    expect(help.stdout.text).toContain('Compare two files byte by byte');
    expect(help.stdout.text).toContain('usage: cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]');
    expect(help.stdout.text).toContain('-i SKIP, --ignore-initial=SKIP');
    expect(help.stdout.text).toContain('-n LIMIT, --bytes=LIMIT');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(version.stdout.text).toBe('cmp (wesh)\n');
    expect(version.stderr.text).toBe('');
    expect(version.result.exitCode).toBe(0);
  });

  it('uses the first help or version early exit in argv order', async () => {
    const versionThenInvalid = await execute({ script: 'cmp --version --definitely-invalid-option' });
    const versionThenHelp = await execute({ script: 'cmp --version --help' });

    expect(versionThenInvalid.stdout.text).toBe('cmp (wesh)\n');
    expect(versionThenInvalid.stderr.text).toBe('');
    expect(versionThenInvalid.result.exitCode).toBe(0);
    expect(versionThenHelp.stdout.text).toBe('cmp (wesh)\n');
    expect(versionThenHelp.stderr.text).toBe('');
    expect(versionThenHelp.result.exitCode).toBe(0);
  });

  it('reports usage errors with exit code 2', async () => {
    const missing = await execute({ script: 'cmp' });
    const extra = await execute({ script: 'cmp a b 0 0 extra' });
    const invalid = await execute({ script: 'cmp --unknown a b' });

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('cmp: missing operand');
    expect(missing.result.exitCode).toBe(2);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain("cmp: extra operand 'extra'");
    expect(extra.result.exitCode).toBe(2);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("cmp: unrecognized option '--unknown'");
    expect(invalid.result.exitCode).toBe(2);
  });

  it('returns 0 for equal files and reports the first differing byte and line', async () => {
    await writeFile({ name: 'left.txt', data: `\
a
b
` });
    await writeFile({ name: 'equal.txt', data: `\
a
b
` });
    await writeFile({ name: 'right.txt', data: `\
a
c
` });

    const equal = await execute({ script: 'cmp left.txt equal.txt' });
    const different = await execute({ script: 'cmp left.txt right.txt' });

    expect(equal.stdout.text).toBe('');
    expect(equal.stderr.text).toBe('');
    expect(equal.result.exitCode).toBe(0);

    expect(different.stdout.text).toBe('left.txt right.txt differ: char 3, line 2\n');
    expect(different.stderr.text).toBe('');
    expect(different.result.exitCode).toBe(1);
  });

  it('prints differing byte values with -b', async () => {
    await writeFile({ name: 'left.txt', data: `\
a
b
` });
    await writeFile({ name: 'right.txt', data: `\
a
c
` });

    const { result, stdout, stderr } = await execute({
      script: 'cmp -b left.txt right.txt',
    });

    expect(stdout.text).toBe('left.txt right.txt differ: byte 3, line 2 is 142 b 143 c\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('lists every differing byte with -l and GNU-style visible bytes with -b', async () => {
    await writeFile({
      name: 'left.bin',
      data: new Uint8Array([0x00, 0x7f, 0x80, 0xff]),
    });
    await writeFile({
      name: 'right.bin',
      data: new Uint8Array([0x01, 0x7e, 0x81, 0xfe]),
    });

    const plain = await execute({ script: 'cmp -l left.bin right.bin' });
    const visible = await execute({ script: 'cmp -lb left.bin right.bin' });

    expect(plain.stdout.text).toBe(`\
1   0   1
2 177 176
3 200 201
4 377 376
`);
    expect(plain.stderr.text).toBe('');
    expect(plain.result.exitCode).toBe(1);

    expect(visible.stdout.text).toBe(`\
1   0 ^@     1 ^A
2 177 ^?   176 ~
3 200 M-^@ 201 M-^A
4 377 M-^? 376 M-~
`);
    expect(visible.stderr.text).toBe('');
    expect(visible.result.exitCode).toBe(1);
  });

  it('reports EOF differences on stderr', async () => {
    await writeFile({ name: 'short.txt', data: 'a' });
    await writeFile({ name: 'long.txt', data: 'ab' });
    await writeFile({ name: 'empty.txt', data: '' });

    const normal = await execute({ script: 'cmp short.txt long.txt' });
    const empty = await execute({ script: 'cmp empty.txt long.txt' });
    const verbose = await execute({ script: 'cmp -l short.txt long.txt' });

    expect(normal.stdout.text).toBe('');
    expect(normal.stderr.text).toBe('cmp: EOF on short.txt after byte 1, in line 1\n');
    expect(normal.result.exitCode).toBe(1);

    expect(empty.stdout.text).toBe('');
    expect(empty.stderr.text).toBe('cmp: EOF on empty.txt which is empty\n');
    expect(empty.result.exitCode).toBe(1);

    expect(verbose.stdout.text).toBe('');
    expect(verbose.stderr.text).toBe('cmp: EOF on short.txt after byte 1\n');
    expect(verbose.result.exitCode).toBe(1);
  });

  it('lists byte differences before a later EOF difference', async () => {
    await writeFile({ name: 'short.txt', data: 'x' });
    await writeFile({ name: 'long.txt', data: 'yz' });

    const { result, stdout, stderr } = await execute({
      script: 'cmp -l short.txt long.txt',
    });

    expect(stdout.text).toBe('1 170 171\n');
    expect(stderr.text).toBe('cmp: EOF on short.txt after byte 1\n');
    expect(result.exitCode).toBe(1);
  });

  it('supports an omitted second file and explicit stdin operands', async () => {
    await writeFile({ name: 'same.txt', data: 'abc' });
    await writeFile({ name: 'different.txt', data: 'abd' });
    const stdin = new TextEncoder().encode('abc');

    const omitted = await execute({ script: 'cmp same.txt', stdinBytes: stdin });
    const explicit = await execute({ script: 'cmp - different.txt', stdinBytes: stdin });
    const repeated = await execute({ script: 'cmp - -', stdinBytes: stdin });

    expect(omitted.stdout.text).toBe('');
    expect(omitted.stderr.text).toBe('');
    expect(omitted.result.exitCode).toBe(0);

    expect(explicit.stdout.text).toBe('- different.txt differ: char 3, line 1\n');
    expect(explicit.stderr.text).toBe('');
    expect(explicit.result.exitCode).toBe(1);

    expect(repeated.stdout.text).toBe('');
    expect(repeated.stderr.text).toBe('');
    expect(repeated.result.exitCode).toBe(0);
  });

  it('uses the greatest positional and --ignore-initial skips for each input', async () => {
    await writeFile({ name: 'left.txt', data: 'xxABC' });
    await writeFile({ name: 'right.txt', data: 'yABC' });
    await writeFile({ name: 'repeat-left.txt', data: 'xaABC' });
    await writeFile({ name: 'repeat-right.txt', data: 'ybABC' });

    const positional = await execute({ script: 'cmp left.txt right.txt 2 1' });
    const shared = await execute({ script: 'cmp -i1 left.txt right.txt 2 0' });
    const separate = await execute({ script: 'cmp -i1:1 left.txt right.txt 2 0' });
    const repeated = await execute({
      script: 'cmp -i2 -i1 repeat-left.txt repeat-right.txt',
    });

    expect(positional.result.exitCode).toBe(0);
    expect(shared.result.exitCode).toBe(0);
    expect(separate.result.exitCode).toBe(0);
    expect(repeated.result.exitCode).toBe(0);
  });

  it('limits comparisons with decimal, octal, hexadecimal, and suffixed values', async () => {
    await writeFile({ name: 'left.txt', data: 'abcX' });
    await writeFile({ name: 'right.txt', data: 'abcY' });

    const decimal = await execute({ script: 'cmp -n3 left.txt right.txt' });
    const positive = await execute({ script: 'cmp -n+3 left.txt right.txt' });
    const octal = await execute({ script: 'cmp -n03 left.txt right.txt' });
    const hexadecimal = await execute({ script: 'cmp -n0x3 left.txt right.txt' });
    const suffix = await execute({ script: 'cmp -n1KB left.txt right.txt' });
    const repeated = await execute({ script: 'cmp -n1 -n4 left.txt right.txt' });

    expect(decimal.result.exitCode).toBe(0);
    expect(positive.result.exitCode).toBe(0);
    expect(octal.result.exitCode).toBe(0);
    expect(hexadecimal.result.exitCode).toBe(0);
    expect(suffix.stdout.text).toBe('left.txt right.txt differ: char 4, line 1\n');
    expect(suffix.result.exitCode).toBe(1);
    expect(repeated.result.exitCode).toBe(0);
  });

  it('accepts only leading C-locale whitespace in byte counts', async () => {
    await writeFile({ name: 'left.txt', data: 'abc' });
    await writeFile({ name: 'right.txt', data: 'abc' });

    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const limit = await execute({
        script: `cmp -n '${whitespace}1' left.txt right.txt`,
      });
      expect(limit.stdout.text).toBe('');
      expect(limit.stderr.text).toBe('');
      expect(limit.result.exitCode).toBe(0);

      const skip = await execute({
        script: `cmp -i '${whitespace}1:${whitespace}1' left.txt right.txt`,
      });
      expect(skip.stdout.text).toBe('');
      expect(skip.stderr.text).toBe('');
      expect(skip.result.exitCode).toBe(0);
    }

    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      const execution = await execute({
        script: `cmp -n '${operand}' left.txt right.txt`,
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid --bytes value');
      expect(execution.result.exitCode).toBe(2);
    }
  });

  it('validates byte counts and incompatible options', async () => {
    await writeFile({ name: 'left.txt', data: 'a' });
    await writeFile({ name: 'right.txt', data: 'a' });

    const invalidLimit = await execute({ script: 'cmp -n08 left.txt right.txt' });
    const unsupportedSuffix = await execute({ script: 'cmp -n0R left.txt right.txt' });
    const inheritedSuffix = await execute({ script: 'cmp -n1constructor left.txt right.txt' });
    const invalidSkip = await execute({ script: 'cmp -i1: left.txt right.txt' });
    const incompatible = await execute({ script: 'cmp -ls left.txt right.txt' });

    expect(invalidLimit.stderr.text).toContain("cmp: invalid --bytes value '08'");
    expect(invalidLimit.result.exitCode).toBe(2);
    expect(unsupportedSuffix.stderr.text).toContain("cmp: invalid --bytes value '0R'");
    expect(unsupportedSuffix.result.exitCode).toBe(2);
    expect(inheritedSuffix.stderr.text).toContain("cmp: invalid --bytes value '1constructor'");
    expect(inheritedSuffix.result.exitCode).toBe(2);
    expect(invalidSkip.stderr.text).toContain("cmp: invalid --ignore-initial value ''");
    expect(invalidSkip.result.exitCode).toBe(2);
    expect(incompatible.stderr.text).toContain('cmp: options -l and -s are incompatible');
    expect(incompatible.result.exitCode).toBe(2);
  });

  it('suppresses difference and runtime diagnostics in quiet mode', async () => {
    await writeFile({ name: 'short.txt', data: 'a' });
    await writeFile({ name: 'long.txt', data: 'ab' });

    const different = await execute({ script: 'cmp -s short.txt long.txt' });
    const missing = await execute({ script: 'cmp -s missing.txt long.txt' });

    expect(different.stdout.text).toBe('');
    expect(different.stderr.text).toBe('');
    expect(different.result.exitCode).toBe(1);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(2);
  });

  it('reports read failures in quiet mode after an input was opened', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ name: 'file.txt', data: 'data' });

    const { result, stdout, stderr } = await execute({
      script: 'cmp -s dir file.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('cmp: dir:');
    expect(result.exitCode).toBe(2);
  });

  it('closes an opened stdin stream when the second input cannot be opened', async () => {
    const state = {
      closeCalls: 0,
    };
    const stdinHandle: WeshFileHandle = {
      async read() {
        return { bytesRead: 0 };
      },
      async write() {
        throw new Error('test stdin is read-only');
      },
      async close() {
        state.closeCalls += 1;
      },
      async stat() {
        return {
          size: 0,
          mode: 0o644,
          type: 'file' as const,
          mtime: 0,
          ino: 0,
          uid: 0,
          gid: 0,
        };
      },
      async truncate() {
        throw new Error('test stdin is read-only');
      },
      async ioctl() {
        return { ret: 0 };
      },
      cloneReference() {
        return stdinHandle;
      },
    };

    const { result, stdout, stderr } = await execute({
      script: 'cmp - missing.txt',
      stdinHandle,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('cmp: missing.txt:');
    expect(result.exitCode).toBe(2);
    expect(state.closeCalls).toBeGreaterThan(0);
  });

  it('identifies which input failed during streaming reads', async () => {
    await writeFile({ name: 'right.txt', data: 'right' });
    const stdinHandle: WeshFileHandle = {
      async read() {
        throw new Error('test read failure');
      },
      async write() {
        throw new Error('test stdin is read-only');
      },
      async close() {
        // No external resource is held by this test handle.
      },
      async stat() {
        return {
          size: 0,
          mode: 0o644,
          type: 'file' as const,
          mtime: 0,
          ino: 0,
          uid: 0,
          gid: 0,
        };
      },
      async truncate() {
        throw new Error('test stdin is read-only');
      },
      async ioctl() {
        return { ret: 0 };
      },
      cloneReference() {
        return stdinHandle;
      },
    };

    const { result, stdout, stderr } = await execute({
      script: 'cmp - right.txt',
      stdinHandle,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('cmp: -: test read failure');
    expect(result.exitCode).toBe(2);
  });

  it('still validates both files when the byte limit is zero', async () => {
    await writeFile({ name: 'present.txt', data: 'a' });

    const valid = await execute({ script: 'cmp -n0 present.txt present.txt' });
    const missing = await execute({ script: 'cmp -n0 missing.txt present.txt' });

    expect(valid.result.exitCode).toBe(0);
    expect(missing.stderr.text).toContain('cmp: missing.txt:');
    expect(missing.result.exitCode).toBe(2);
  });

  it('compares binary data across the default stream chunk boundary', async () => {
    const left = new Uint8Array(64 * 1024 + 2).fill(0x41);
    const right = new Uint8Array(left);
    right[64 * 1024] = 0x42;
    await writeFile({ name: 'left.bin', data: left });
    await writeFile({ name: 'right.bin', data: right });

    const { result, stdout, stderr } = await execute({
      script: 'cmp left.bin right.bin',
    });

    expect(stdout.text).toBe('left.bin right.bin differ: char 65537, line 1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });


  it('stops after at most one prefetched chunk in normal mode', async () => {
    const input = new Uint8Array(128 * 1024).fill(0x00);
    const comparison = new Uint8Array(128 * 1024).fill(0x01);
    await writeFile({ name: 'comparison.bin', data: comparison });

    const state = {
      offset: 0,
      readCalls: 0,
      closeCalls: 0,
    };
    const stdinHandle: WeshFileHandle = {
      async read({ buffer, offset, length }) {
        state.readCalls += 1;
        if (state.readCalls > 2) {
          throw new Error('cmp read beyond one prefetched chunk');
        }

        const targetOffset = offset ?? 0;
        const requestedLength = length ?? (buffer.length - targetOffset);
        const copyLength = Math.min(requestedLength, input.length - state.offset);
        buffer.set(input.subarray(state.offset, state.offset + copyLength), targetOffset);
        state.offset += copyLength;
        return { bytesRead: copyLength };
      },
      async write() {
        throw new Error('test stdin is read-only');
      },
      async close() {
        state.closeCalls += 1;
      },
      async stat() {
        return {
          size: input.length,
          mode: 0o644,
          type: 'file' as const,
          mtime: 0,
          ino: 0,
          uid: 0,
          gid: 0,
        };
      },
      async truncate() {
        throw new Error('test stdin is read-only');
      },
      async ioctl() {
        return { ret: 0 };
      },
      cloneReference() {
        return stdinHandle;
      },
    };

    const { result, stdout, stderr } = await execute({
      script: 'cmp - comparison.bin',
      stdinHandle,
    });

    expect(stdout.text).toBe('- comparison.bin differ: char 1, line 1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
    expect(state.readCalls).toBeLessThanOrEqual(2);
    expect(state.closeCalls).toBeGreaterThan(0);
  });

  it('buffers verbose output instead of writing once per difference', async () => {
    const left = new Uint8Array(5000).fill(0x00);
    const right = new Uint8Array(5000).fill(0x01);
    await writeFile({ name: 'left.bin', data: left });
    await writeFile({ name: 'right.bin', data: right });

    const { result, stdout, stderr } = await execute({
      script: 'cmp -l left.bin right.bin',
    });

    expect(stdout.text.startsWith('   1   0   1\n')).toBe(true);
    expect(stdout.text.endsWith('5000   0   1\n')).toBe(true);
    expect(stdout.text.split('\n')).toHaveLength(5001);
    expect(stdout.chunkCount).toBeLessThan(100);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('resolves relative file operands from the current working directory', async () => {
    const directory = await rootHandle.getDirectoryHandle('work', { create: true });
    const left = await directory.getFileHandle('left.txt', { create: true });
    const leftWritable = await left.createWritable();
    await leftWritable.write('same');
    await leftWritable.close();
    const right = await directory.getFileHandle('right.txt', { create: true });
    const rightWritable = await right.createWritable();
    await rightWritable.write('same');
    await rightWritable.close();

    const { result, stdout, stderr } = await execute({
      script: 'cd work; cmp left.txt right.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts dash-prefixed file names after --', async () => {
    await writeFile({ name: '-left', data: 'same' });
    await writeFile({ name: 'right.txt', data: 'same' });

    const { result, stdout, stderr } = await execute({
      script: 'cmp -- -left right.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
  it('pads verbose byte positions from the known comparison span', async () => {
    const left = new Uint8Array(200);
    const right = new Uint8Array(200).fill(1);
    await writeFile({ name: 'left.bin', data: left });
    await writeFile({ name: 'right.bin', data: right });

    const full = await execute({ script: 'cmp -l left.bin right.bin' });
    const limited = await execute({ script: 'cmp -l -n 8 left.bin right.bin' });
    const skipped = await execute({ script: 'cmp -l -i 150 left.bin right.bin' });

    expect(full.stdout.text.split('\n')[0]).toBe('  1   0   1');
    expect(limited.stdout.text.split('\n')[0]).toBe('1   0   1');
    expect(skipped.stdout.text.split('\n')[0]).toBe(' 1   0   1');
    expect(full.result.exitCode).toBe(1);
    expect(limited.result.exitCode).toBe(1);
    expect(skipped.result.exitCode).toBe(1);
  });

  it('pads verbose positions from the shorter known input span', async () => {
    await writeFile({ name: 'long.bin', data: new Uint8Array(1_000).fill(1) });
    await writeFile({ name: 'short.bin', data: new Uint8Array(10).fill(2) });

    const { result, stdout, stderr } = await execute({
      script: 'cmp -l long.bin short.bin',
    });

    expect(stdout.text.split('\n')[0]).toBe(' 1   1   2');
    expect(stderr.text).toContain('cmp: EOF on short.bin after byte 10');
    expect(result.exitCode).toBe(1);
  });

  it('reports EOF on a trailing newline as the line that ended', async () => {
    await writeFile({ name: 'short.txt', data: 'x\n' });
    await writeFile({
      name: 'long.txt',
      data: `\
x
y`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'cmp short.txt long.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
cmp: EOF on short.txt after byte 2, line 1
`);
    expect(result.exitCode).toBe(1);
  });


});
