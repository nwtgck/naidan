import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh comm', () => {
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
    stdinText = '',
  }: {
    script: string,
    stdinText?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports missing operands', async () => {
    const help = await execute({ script: 'comm --help' });
    const missing = await execute({ script: 'comm only-one-file.txt' });

    expect(help.stdout.text).toContain('Compare two sorted files line by line');
    expect(help.stdout.text).toContain('usage: comm [OPTION]... FILE1 FILE2');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('comm: missing operand');
    expect(missing.stderr.text).toContain('usage: comm [OPTION]... FILE1 FILE2');
    expect(missing.result.exitCode).toBe(1);
  });

  it('compares sorted files and supports column suppression', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
alpha
beta
delta
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
beta
delta
gamma
`,
    });

    const plain = await execute({ script: 'comm left.txt right.txt' });
    const suppressed = await execute({ script: 'comm -1 left.txt right.txt' });

    expect(plain.stderr.text).toBe('');
    expect(suppressed.stderr.text).toBe('');
    expect(plain.result.exitCode).toBe(0);
    expect(suppressed.result.exitCode).toBe(0);
    expect(plain.stdout.text).toBe('alpha\n\t\tbeta\n\t\tdelta\n\tgamma\n');
    expect(suppressed.stdout.text).toBe('\tbeta\n\tdelta\ngamma\n');
  });

  it('accepts stdin for one of the inputs', async () => {
    await writeFile({
      path: 'right.txt',
      data: 'beta\n',
    });

    const { result, stdout, stderr } = await execute({
      script: 'comm - right.txt',
      stdinText: `\
alpha
beta
`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('alpha\n\t\tbeta\n');
  });

  it('emits the first stdin operand before rejecting the second', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'comm - -',
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
alpha
	beta
`);
    expect(stderr.text).toBe('comm: -: Bad file descriptor\n');
    expect(result.exitCode).toBe(1);
  });

  it('reports unsorted inputs after preserving comparison output', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
b
a
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
d
c
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'comm left.txt right.txt',
    });

    expect(stdout.text).toBe(`\
b
a
	d
	c
`);
    expect(stderr.text).toBe(`\
comm: file 1 is not in sorted order
comm: file 2 is not in sorted order
comm: input is not in sorted order
`);
    expect(result.exitCode).toBe(1);
  });

  it('does not diagnose pairable disorder unless --check-order is requested', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
b
a
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
b
a
`,
    });

    const defaultCheck = await execute({ script: 'comm left.txt right.txt' });
    const forcedCheck = await execute({ script: 'comm --check-order left.txt right.txt' });

    expect(defaultCheck.stdout.text).toBe('\t\tb\n\t\ta\n');
    expect(defaultCheck.stderr.text).toBe('');
    expect(defaultCheck.result.exitCode).toBe(0);

    expect(forcedCheck.stdout.text).toBe('\t\tb\n');
    expect(forcedCheck.stderr.text).toBe('comm: file 1 is not in sorted order\n');
    expect(forcedCheck.result.exitCode).toBe(1);
  });

  it('prints totals after the default order check reports disorder', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
b
a
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
c
d
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'comm --total left.txt right.txt',
    });

    expect(stdout.text).toBe(`\
b
a
	c
	d
2	2	0	total
`);
    expect(stderr.text).toBe(`\
comm: file 1 is not in sorted order
comm: input is not in sorted order
`);
    expect(result.exitCode).toBe(1);
  });

  it('supports custom and empty output delimiters with totals', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
a
c
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
b
c
`,
    });

    const custom = await execute({
      script: "comm --output-delimiter='|' --total left.txt right.txt",
    });
    const empty = await execute({
      script: "comm --output-delimiter='' left.txt right.txt",
    });
    const duplicate = await execute({
      script: "comm --output-delimiter='|' --output-delimiter='' left.txt right.txt",
    });

    expect(custom.stderr.text).toBe('');
    expect(custom.result.exitCode).toBe(0);
    expect(custom.stdout.text).toBe(`\
a
|b
||c
1|1|1|total
`);
    expect(empty.stderr.text).toBe('');
    expect(empty.result.exitCode).toBe(0);
    expect(empty.stdout.text).toBe('a\n\0b\n\0\0c\n');
    expect(duplicate.stdout.text).toBe('');
    expect(duplicate.stderr.text).toBe('comm: multiple output delimiters specified\n');
    expect(duplicate.result.exitCode).toBe(1);
  });

  it('supports NUL-delimited records and totals', async () => {
    await writeFile({ path: 'left.bin', data: 'a\0c\0' });
    await writeFile({ path: 'right.bin', data: 'b\0c\0' });

    const { result, stdout, stderr } = await execute({
      script: 'comm -z --total left.bin right.bin',
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(['a', '\tb', '\t\tc', '1\t1\t1\ttotal', ''].join('\0'));
  });

  it('stops immediately when --check-order detects disorder', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
b
a
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
c
d
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'comm --check-order left.txt right.txt',
    });

    expect(stdout.text).toBe('b\n');
    expect(stderr.text).toBe('comm: file 1 is not in sorted order\n');
    expect(result.exitCode).toBe(1);
  });

  it('suppresses order diagnostics with --nocheck-order', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
b
a
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
c
d
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'comm --nocheck-order left.txt right.txt',
    });

    expect(stdout.text).toBe(`\
b
a
	c
	d
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('preserves CR bytes and invalid UTF-8 while comparing in byte order', async () => {
    await writeFile({
      path: 'left-crlf.bin',
      data: new Uint8Array([0x61, 0x0d, 0x0a]),
    });
    await writeFile({
      path: 'right-lf.bin',
      data: new Uint8Array([0x61, 0x0a]),
    });
    await writeFile({
      path: 'left-invalid.bin',
      data: new Uint8Array([0x61, 0xff, 0x0a]),
    });
    await writeFile({
      path: 'right-invalid.bin',
      data: new Uint8Array([0x61, 0xfe, 0x0a]),
    });

    const crlf = await execute({
      script: 'comm left-crlf.bin right-lf.bin',
    });
    const invalid = await execute({
      script: 'comm left-invalid.bin right-invalid.bin',
    });

    expect(crlf.stderr.text).toBe('');
    expect(crlf.result.exitCode).toBe(0);
    expect(crlf.stdout.buffer).toEqual(new Uint8Array([
      0x09, 0x61, 0x0a,
      0x61, 0x0d, 0x0a,
    ]));
    expect(invalid.stderr.text).toBe('');
    expect(invalid.result.exitCode).toBe(0);
    expect(invalid.stdout.buffer).toEqual(new Uint8Array([
      0x09, 0x61, 0xfe, 0x0a,
      0x61, 0xff, 0x0a,
    ]));
  });

});
