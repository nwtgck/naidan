import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh paste', () => {
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
      script,
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports invalid delimiter usage', async () => {
    const help = await execute({ script: 'paste --help' });
    const invalid = await execute({ script: 'paste -d' });

    expect(help.stdout.text).toContain('Merge lines of files in parallel or serially');
    expect(help.stdout.text).toContain('usage: paste [OPTION]... [FILE]...');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('paste: -d requires a value for list');
    expect(invalid.stderr.text).toContain('usage: paste [OPTION]... [FILE]...');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('merges files in parallel and serially', async () => {
    await writeFile({
      path: 'left.txt',
      data: `\
a
b
`,
    });
    await writeFile({
      path: 'right.txt',
      data: `\
1
2
3
`,
    });

    const parallel = await execute({ script: 'paste left.txt right.txt' });
    const serial = await execute({ script: "paste -s -d ',;' left.txt right.txt" });

    expect(parallel.stderr.text).toBe('');
    expect(serial.stderr.text).toBe('');
    expect(parallel.result.exitCode).toBe(0);
    expect(serial.result.exitCode).toBe(0);
    expect(parallel.stdout.text).toBe('a\t1\nb\t2\n\t3\n');
    expect(serial.stdout.text).toBe(`\
a,b
1,2;3
`);
  });

  it('accepts stdin input', async () => {
    const { result, stdout, stderr } = await execute({
      script: "paste -s -d ',;' -",
      stdinText: `\
alpha
beta
gamma
`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('alpha,beta;gamma\n');
  });

  it('decodes escaped delimiter characters', async () => {
    await writeFile({ path: 'left.txt', data: 'left\n' });
    await writeFile({ path: 'right.txt', data: 'right\n' });

    const newline = await execute({ script: "paste -d '\\n' left.txt right.txt" });
    const tab = await execute({ script: "paste -d '\\t' left.txt right.txt" });
    const none = await execute({ script: "paste -d '\\0' left.txt right.txt" });

    expect(newline.stdout.text).toBe(`\
left
right
`);
    expect(tab.stdout.text).toBe('left\tright\n');
    expect(none.stdout.text).toBe('leftright\n');
    expect(newline.stderr.text).toBe('');
    expect(tab.stderr.text).toBe('');
    expect(none.stderr.text).toBe('');
    expect(newline.result.exitCode).toBe(0);
    expect(tab.result.exitCode).toBe(0);
    expect(none.result.exitCode).toBe(0);
  });

  it('cycles multibyte delimiter arguments byte by byte', async () => {
    await writeFile({ path: 'records', data: `\
a
b
c
` });
    await writeFile({ path: 'left', data: `\
a
b
` });
    await writeFile({ path: 'middle', data: `\
1
2
` });
    await writeFile({ path: 'right', data: `\
x
y
` });

    const supplementary = await execute({ script: "paste -s -d '😀' records" });
    const multibyteCycle = await execute({ script: "paste -s -d 'éX' records" });
    const parallel = await execute({ script: "paste -d '😀' left middle right" });

    expect(supplementary.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0xf0, 0x62, 0x9f, 0x63, 0x0a,
    ]));
    expect(multibyteCycle.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0xc3, 0x62, 0xa9, 0x63, 0x0a,
    ]));
    expect(parallel.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0xf0, 0x31, 0x9f, 0x78, 0x0a,
      0x62, 0xf0, 0x32, 0x9f, 0x79, 0x0a,
    ]));
    expect(supplementary.stderr.text).toBe('');
    expect(multibyteCycle.stderr.text).toBe('');
    expect(parallel.stderr.text).toBe('');
    expect(supplementary.result.exitCode).toBe(0);
    expect(multibyteCycle.result.exitCode).toBe(0);
    expect(parallel.result.exitCode).toBe(0);
  });

  it('preserves arbitrary record bytes and carriage returns', async () => {
    await writeFile({ path: 'left', data: Uint8Array.from([0x61, 0xff, 0x0a, 0x62, 0xfe, 0x0a]) });
    await writeFile({ path: 'right', data: Uint8Array.from([0x31, 0x0a, 0x32, 0x0a]) });
    await writeFile({ path: 'zero', data: Uint8Array.from([0x61, 0xff, 0x00, 0x62, 0xfe, 0x00]) });
    await writeFile({ path: 'crlf', data: Uint8Array.from([0x61, 0x0d, 0x0a, 0x62, 0x0a]) });

    const parallel = await execute({ script: 'paste left right' });
    const serial = await execute({ script: 'paste -s left' });
    const zeroTerminated = await execute({ script: 'paste -zs zero' });
    const carriageReturn = await execute({ script: 'paste -s crlf' });

    expect(parallel.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0xff, 0x09, 0x31, 0x0a,
      0x62, 0xfe, 0x09, 0x32, 0x0a,
    ]));
    expect(serial.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0xff, 0x09, 0x62, 0xfe, 0x0a,
    ]));
    expect(zeroTerminated.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0xff, 0x09, 0x62, 0xfe, 0x00,
    ]));
    expect(carriageReturn.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0x0d, 0x09, 0x62, 0x0a,
    ]));
    expect(parallel.stderr.text).toBe('');
    expect(serial.stderr.text).toBe('');
    expect(zeroTerminated.stderr.text).toBe('');
    expect(carriageReturn.stderr.text).toBe('');
    expect(parallel.result.exitCode).toBe(0);
    expect(serial.result.exitCode).toBe(0);
    expect(zeroTerminated.result.exitCode).toBe(0);
    expect(carriageReturn.result.exitCode).toBe(0);
  });

  it('rejects a delimiter list ending with an unescaped backslash', async () => {
    await writeFile({ path: 'left.txt', data: 'left\n' });
    await writeFile({ path: 'right.txt', data: 'right\n' });

    const { result, stdout, stderr } = await execute({
      script: 'paste -d "\\\\" left.txt right.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('paste: delimiter list ends with an unescaped backslash: \\\n');
    expect(result.exitCode).toBe(1);
  });

  it('supports NUL-delimited parallel and serial records', async () => {
    await writeFile({ path: 'left', data: 'a\u0000b\u0000' });
    await writeFile({ path: 'right', data: '1\u00002\u0000' });

    const parallel = await execute({ script: 'paste -z left right' });
    const serial = await execute({ script: 'paste -zs left' });

    expect(parallel.stdout.text).toBe('a\t1\u0000b\t2\u0000');
    expect(parallel.stderr.text).toBe('');
    expect(parallel.result.exitCode).toBe(0);
    expect(serial.stdout.text).toBe('a\tb\u0000');
    expect(serial.stderr.text).toBe('');
    expect(serial.result.exitCode).toBe(0);
  });

  it('continues other parallel inputs after a directory operand', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ path: 'valid', data: 'one\n' });

    const { result, stdout, stderr } = await execute({
      script: 'paste dir valid',
    });

    expect(stdout.text).toBe('\tone\n');
    expect(stderr.text).toBe('paste: dir: Is a directory\n');
    expect(result.exitCode).toBe(1);
  });

  it('consumes repeated stdin operands sequentially', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'paste - -',
      stdinText: `\
a
b
c
d
`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('a\tb\nc\td\n');
  });
});
