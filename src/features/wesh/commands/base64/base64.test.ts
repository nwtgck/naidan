import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh base64', () => {
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
    stdinText,
  }: {
    script: string,
    stdinText?: string,
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
    expect(unwrapped.stdout.text).toBe('aGVsbG8=');
    expect(wrapped.stderr.text).toBe('');
    expect(unwrapped.stderr.text).toBe('');
    expect(wrapped.result.exitCode).toBe(0);
    expect(unwrapped.result.exitCode).toBe(0);
  });

  it('rejects more than one input operand before reading data', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });

    const { result, stdout, stderr } = await execute({
      script: 'base64 first.txt second.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("base64: extra operand 'second.txt'");
    expect(result.exitCode).toBe(1);
  });

  it('rejects non-newline whitespace unless ignore-garbage is enabled', async () => {
    for (const whitespace of [' ', '\t', '\v', '\f', '\r']) {
      const rejected = await execute({
        script: 'base64 -d',
        stdinText: `Y${whitespace}Q==`,
      });
      const ignored = await execute({
        script: 'base64 -di',
        stdinText: `Y${whitespace}Q==`,
      });

      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toContain('invalid input');
      expect(rejected.result.exitCode).toBe(1);
      expect(ignored.stdout.text).toBe('a');
      expect(ignored.stderr.text).toBe('');
      expect(ignored.result.exitCode).toBe(0);
    }
  });

  it('decodes concatenated padded blocks', async () => {
    const plain = await execute({
      script: 'base64 -d',
      stdinText: 'YQ==Yg==',
    });
    const ignoredGarbage = await execute({
      script: 'base64 -di',
      stdinText: 'YQ==$Yg==',
    });

    expect(plain.stdout.text).toBe('ab');
    expect(plain.stderr.text).toBe('');
    expect(plain.result.exitCode).toBe(0);
    expect(ignoredGarbage.stdout.text).toBe('ab');
    expect(ignoredGarbage.stderr.text).toBe('');
    expect(ignoredGarbage.result.exitCode).toBe(0);
  });

  it('ignores non-alphabet bytes while decoding with -i', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64 --decode --ignore-garbage',
      stdinText: 'Y!W@J#j$Cg==\n',
    });

    expect(stdout.text).toBe('abc\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints complete and partial decoded groups before malformed input', async () => {
    const complete = await execute({ script: 'base64 -d', stdinText: 'YWJj$' });
    const twoCharacters = await execute({ script: 'base64 -d', stdinText: 'YQ$' });
    const threeCharacters = await execute({ script: 'base64 -d', stdinText: 'YWI$' });

    expect(complete.stdout.text).toBe('abc');
    expect(complete.stderr.text).toContain('invalid input');
    expect(complete.result.exitCode).toBe(1);
    expect(twoCharacters.stdout.text).toBe('a');
    expect(twoCharacters.stderr.text).toContain('invalid input');
    expect(twoCharacters.result.exitCode).toBe(1);
    expect(threeCharacters.stdout.text).toBe('ab');
    expect(threeCharacters.stderr.text).toContain('invalid input');
    expect(threeCharacters.result.exitCode).toBe(1);
  });

  it('preserves GNU partial output while rejecting invalid final quanta', async () => {
    const incompletePadding = await execute({ script: 'base64 -d', stdinText: 'YQ=' });
    const interiorPadding = await execute({ script: 'base64 -d', stdinText: 'AA=A' });
    const nonzeroTrailingBits = await execute({ script: 'base64 -d', stdinText: 'AB' });
    const ignoredGarbageWithTrailingSextet = await execute({
      script: 'base64 -di',
      stdinText: 'YW!JjA',
    });

    expect(incompletePadding.stdout.text).toBe('a');
    expect(incompletePadding.stderr.text).toContain('invalid input');
    expect(incompletePadding.result.exitCode).toBe(1);
    expect([...interiorPadding.stdout.buffer]).toEqual([0]);
    expect(interiorPadding.stderr.text).toContain('invalid input');
    expect(interiorPadding.result.exitCode).toBe(1);
    expect([...nonzeroTrailingBits.stdout.buffer]).toEqual([0]);
    expect(nonzeroTrailingBits.stderr.text).toContain('invalid input');
    expect(nonzeroTrailingBits.result.exitCode).toBe(1);
    expect(ignoredGarbageWithTrailingSextet.stdout.text).toBe('abc');
    expect(ignoredGarbageWithTrailingSextet.stderr.text).toContain('invalid input');
    expect(ignoredGarbageWithTrailingSextet.result.exitCode).toBe(1);
  });

  it('accepts unpadded final quanta only when their unused bits are zero', async () => {
    const oneByte = await execute({ script: 'base64 -d', stdinText: 'YQ' });
    const twoBytes = await execute({ script: 'base64 -d', stdinText: 'YWI' });

    expect(oneByte.stdout.text).toBe('a');
    expect(oneByte.stderr.text).toBe('');
    expect(oneByte.result.exitCode).toBe(0);
    expect(twoBytes.stdout.text).toBe('ab');
    expect(twoBytes.stderr.text).toBe('');
    expect(twoBytes.result.exitCode).toBe(0);
  });

  it('reports invalid base64 input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64 --decode',
      stdinText: '%%%invalid%%%',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('base64: invalid input\n');
    expect(result.exitCode).toBe(1);
  });

  it('reports a missing input file', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64 missing.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('base64: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'base64 --help',
    });

    expect(stdout.text).toContain('Base64 encode or decode data');
    expect(stdout.text).toContain('usage: base64 [OPTION]... [FILE]');
    expect(stdout.text).toContain('--decode');
    expect(stdout.text).toContain('--ignore-garbage');
    expect(stdout.text).toContain('--wrap');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts only leading C-locale whitespace in wrap widths', async () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await execute({
        script: `base64 -w '${whitespace}1'`,
        stdinText: 'x',
      });
      expect(execution.stdout.text).toBe(`\
e
A
=
=
`);
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      const execution = await execute({
        script: `base64 -w '${operand}'`,
        stdinText: 'x',
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid wrap size');
      expect(execution.result.exitCode).toBe(1);
    }
  });


  it('accepts an explicit positive sign in wrap widths', async () => {
    const execution = await execute({
      script: 'base64 -w +1',
      stdinText: 'x',
    });

    expect(execution.stdout.text).toBe(`\
e
A
=
=
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

});
