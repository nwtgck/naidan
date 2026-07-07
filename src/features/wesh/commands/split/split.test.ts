import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh split', () => {
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
  }): Promise<void> {
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

  async function readFileHandle({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    return dir.getFileHandle(fileName);
  }

  async function readFile({
    path,
  }: {
    path: string,
  }): Promise<string> {
    return (await (await readFileHandle({ path })).getFile()).text();
  }

  async function readFileBytes({
    path,
  }: {
    path: string,
  }): Promise<number[]> {
    const file = await (await readFileHandle({ path })).getFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }

  async function listRootFiles(): Promise<string[]> {
    const names: string[] = [];
    for await (const [name, handle] of rootHandle.entries()) {
      if (handle.kind === 'file') {
        names.push(name);
      }
    }
    return names.sort();
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

  it('splits files by lines using the requested prefix', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'split -l 2 input.txt out_',
    });

    expect(await readFile({ path: 'out_aa' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'out_ab' })).toBe(`\
c
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses stdin and the default x prefix when no input operand is provided', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'split -l 2',
      stdinText: `\
one
two
three
`,
    });

    expect(await readFile({ path: 'xaa' })).toBe(`\
one
two
`);
    expect(await readFile({ path: 'xab' })).toBe(`\
three
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats single dash as stdin when a prefix operand is present', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 - chunk_',
      stdinText: `\
alpha
beta
`,
    });

    expect(await readFile({ path: 'chunk_aa' })).toBe(`\
alpha
`);
    expect(await readFile({ path: 'chunk_ab' })).toBe(`\
beta
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not create output files for empty input', async () => {
    await writeFile({ path: 'empty.txt', data: '' });

    const { result, stdout, stderr } = await execute({
      script: 'split empty.txt out_',
    });

    expect(await listRootFiles()).toEqual(['empty.txt']);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not create output files for empty stdin', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 - out_',
      stdinText: '',
    });

    expect(await listRootFiles()).toEqual([]);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('splits by bytes without decoding text', async () => {
    await writeFile({
      path: 'bytes.bin',
      data: new Uint8Array([0, 1, 2, 3, 4, 5, 6]),
    });

    const { result, stdout, stderr } = await execute({
      script: 'split -b 3 bytes.bin part_',
    });

    expect(await readFileBytes({ path: 'part_aa' })).toEqual([0, 1, 2]);
    expect(await readFileBytes({ path: 'part_ab' })).toEqual([3, 4, 5]);
    expect(await readFileBytes({ path: 'part_ac' })).toEqual([6]);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports suffix length, numeric suffixes, additional suffix, and verbose output', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 -a 3 --numeric-suffixes=7 --additional-suffix=.part --verbose input.txt out_',
    });

    expect(await readFile({ path: 'out_007.part' })).toBe(`\
a
`);
    expect(await readFile({ path: 'out_008.part' })).toBe(`\
b
`);
    expect(await readFile({ path: 'out_009.part' })).toBe(`\
c
`);
    expect(stdout.text).toBe(`\
creating file 'out_007.part'
creating file 'out_008.part'
creating file 'out_009.part'
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid options and operands with usage output', async () => {
    const invalidLines = await execute({ script: 'split -l 0' });
    const extraOperand = await execute({ script: 'split a b c' });

    expect(invalidLines.stderr.text).toContain("split: invalid number of lines: '0'");
    expect(invalidLines.stderr.text).toContain('usage: split [OPTION]... [FILE [PREFIX]]');
    expect(invalidLines.result.exitCode).toBe(1);
    expect(extraOperand.stderr.text).toContain("split: extra operand 'c'");
    expect(extraOperand.result.exitCode).toBe(1);
  });

  it('refuses to overwrite the input file with the first default output', async () => {
    await writeFile({
      path: 'xaa',
      data: `\
payload
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 xaa',
    });

    expect(await readFile({ path: 'xaa' })).toBe(`\
payload
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("split: 'xaa' would overwrite input; aborting\n");
    expect(result.exitCode).toBe(1);
  });

  it('refuses to overwrite the input file after creating earlier pieces', async () => {
    await writeFile({
      path: 'xab',
      data: `\
first
second
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 xab',
    });

    expect(await readFile({ path: 'xaa' })).toBe(`\
first
`);
    expect(await readFile({ path: 'xab' })).toBe(`\
first
second
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("split: 'xab' would overwrite input; aborting\n");
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'split --help',
    });

    expect(stdout.text).toContain('Split a file into pieces');
    expect(stdout.text).toContain('usage: split [OPTION]... [FILE [PREFIX]]');
    expect(stdout.text).toContain('--lines');
    expect(stdout.text).toContain('--bytes');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
