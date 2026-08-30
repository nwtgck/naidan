import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { createTextShellSource } from '@/features/wesh/shell/source';
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
      source: createTextShellSource({ text: script }),
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


  it('accepts leading C-locale whitespace in numeric options', async () => {
    const { result, stdout, stderr } = await execute({
      script: "split -l ' 2' -a '\t3' --numeric-suffixes='\v7' - chunk_",
      stdinText: `\
a
b
c
`,
    });

    expect(await readFile({ path: 'chunk_007' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'chunk_008' })).toBe(`\
c
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts explicit plus signs only for positive size and suffix-length options', async () => {
    await writeFile({ path: 'input.txt', data: `\
a
b
` });

    const lineCount = await execute({
      script: "split -l '+1' input.txt line-",
    });
    const byteCount = await execute({
      script: "split -b '+2' input.txt byte-",
    });
    const suffixLength = await execute({
      script: "split -a '+3' input.txt suffix-",
    });
    const numericSuffixStart = await execute({
      script: "split --numeric-suffixes='+1' input.txt numeric-",
    });

    expect(lineCount.stderr.text).toBe('');
    expect(lineCount.result.exitCode).toBe(0);
    expect(await readFile({ path: 'line-aa' })).toBe('a\n');
    expect(await readFile({ path: 'line-ab' })).toBe('b\n');
    expect(byteCount.stderr.text).toBe('');
    expect(byteCount.result.exitCode).toBe(0);
    expect(await readFile({ path: 'byte-aa' })).toBe('a\n');
    expect(await readFile({ path: 'byte-ab' })).toBe('b\n');
    expect(suffixLength.stderr.text).toBe('');
    expect(suffixLength.result.exitCode).toBe(0);
    expect(await readFile({ path: 'suffix-aaa' })).toBe(`\
a
b
`);
    expect(numericSuffixStart.stdout.text).toBe('');
    expect(numericSuffixStart.stderr.text).toContain("invalid numeric suffix start: '+1'");
    expect(numericSuffixStart.result.exitCode).toBe(1);
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

  it('splits by line bytes without breaking records that fit the limit', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'split -C 4 - part_',
      stdinText: `\
aa
bbb
c
`,
    });

    expect(await readFile({ path: 'part_aa' })).toBe('aa\n');
    expect(await readFile({ path: 'part_ab' })).toBe('bbb\n');
    expect(await readFile({ path: 'part_ac' })).toBe('c\n');
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('starts a record in a new output when it exactly reaches the line-byte limit', async () => {
    await writeFile({
      path: 'exact.txt',
      data: `\
12345
xx`,
    });
    await writeFile({
      path: 'below.txt',
      data: `\
1234
xx`,
    });
    await writeFile({
      path: 'complete.txt',
      data: `\
12345
x
`,
    });

    const exact = await execute({
      script: 'split -C 8 exact.txt exact_',
    });
    const below = await execute({
      script: 'split -C 8 below.txt below_',
    });
    const complete = await execute({
      script: 'split -C 8 complete.txt complete_',
    });

    expect(await readFile({ path: 'exact_aa' })).toBe('12345\n');
    expect(await readFile({ path: 'exact_ab' })).toBe('xx');
    expect(await readFile({ path: 'below_aa' })).toBe(`\
1234
xx`);
    expect(await readFile({ path: 'complete_aa' })).toBe(`\
12345
x
`);
    expect(await listRootFiles()).toEqual([
      'below.txt',
      'below_aa',
      'complete.txt',
      'complete_aa',
      'exact.txt',
      'exact_aa',
      'exact_ab',
    ]);
    expect(exact.stdout.text).toBe('');
    expect(exact.stderr.text).toBe('');
    expect(exact.result.exitCode).toBe(0);
    expect(below.stdout.text).toBe('');
    expect(below.stderr.text).toBe('');
    expect(below.result.exitCode).toBe(0);
    expect(complete.stdout.text).toBe('');
    expect(complete.stderr.text).toBe('');
    expect(complete.result.exitCode).toBe(0);
  });

  it('splits a record that exceeds the line-byte limit at byte boundaries', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'split --line-bytes=4 - part_',
      stdinText: 'abcdef\n',
    });

    expect(await readFile({ path: 'part_aa' })).toBe('abcd');
    expect(await readFile({ path: 'part_ab' })).toBe('ef\n');
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies line-byte limits to raw UTF-8 bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'split -C4 - part_',
      stdinText: `\
あ
い
`,
    });

    expect(await readFileBytes({ path: 'part_aa' })).toEqual([0xe3, 0x81, 0x82, 0x0a]);
    expect(await readFileBytes({ path: 'part_ab' })).toEqual([0xe3, 0x81, 0x84, 0x0a]);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('automatically extends default alphabetic suffixes beyond yz', async () => {
    const lineCount = 651;
    await writeFile({
      path: 'input.txt',
      data: Array.from({ length: lineCount }, (_, index) => `${index}\n`).join(''),
    });

    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 input.txt alpha-',
    });

    expect(await readFile({ path: 'alpha-yz' })).toBe('649\n');
    expect(await readFile({ path: 'alpha-zaaa' })).toBe('650\n');
    expect((await listRootFiles()).filter((name) => name.startsWith('alpha-'))).toHaveLength(lineCount);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('automatically extends default numeric suffixes after 89', async () => {
    const lineCount = 91;
    await writeFile({
      path: 'input.txt',
      data: Array.from({ length: lineCount }, (_, index) => `${index}\n`).join(''),
    });

    const { result, stdout, stderr } = await execute({
      script: 'split -d -l 1 input.txt numeric-',
    });

    expect(await readFile({ path: 'numeric-89' })).toBe('89\n');
    expect(await readFile({ path: 'numeric-9000' })).toBe('90\n');
    expect((await listRootFiles()).filter((name) => name.startsWith('numeric-'))).toHaveLength(lineCount);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps explicitly sized or explicitly started suffixes fixed length', async () => {
    await writeFile({
      path: 'alphabetic.txt',
      data: Array.from({ length: 27 }, (_, index) => `${index}\n`).join(''),
    });
    await writeFile({
      path: 'numeric.txt',
      data: Array.from({ length: 101 }, (_, index) => `${index}\n`).join(''),
    });

    const alphabetic = await execute({
      script: 'split -a 1 -l 1 alphabetic.txt alpha-',
    });
    const numeric = await execute({
      script: 'split --numeric-suffixes=0 -l 1 numeric.txt numeric-',
    });

    expect((await listRootFiles()).filter((name) => name.startsWith('alpha-'))).toHaveLength(26);
    expect(alphabetic.stdout.text).toBe('');
    expect(alphabetic.stderr.text).toBe('split: output file suffixes exhausted\n');
    expect(alphabetic.result.exitCode).toBe(1);
    expect((await listRootFiles()).filter((name) => name.startsWith('numeric-'))).toHaveLength(100);
    expect(numeric.stdout.text).toBe('');
    expect(numeric.stderr.text).toBe('split: output file suffixes exhausted\n');
    expect(numeric.result.exitCode).toBe(1);
  });

  it('parses bundled short options and obsolete line-count forms', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
`,
    });

    const bundled = await execute({ script: 'split -da2 -l2 input.txt bundled-' });
    const legacy = await execute({ script: 'split -2 input.txt legacy-' });
    const numericLegacy = await execute({ script: 'split -d2 input.txt numeric-' });

    expect(await readFile({ path: 'bundled-00' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'bundled-01' })).toBe(`\
c
`);
    expect(await readFile({ path: 'legacy-aa' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'legacy-ab' })).toBe(`\
c
`);
    expect(await readFile({ path: 'numeric-00' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'numeric-01' })).toBe(`\
c
`);
    expect(bundled.result.exitCode).toBe(0);
    expect(legacy.result.exitCode).toBe(0);
    expect(numericLegacy.result.exitCode).toBe(0);
    expect(bundled.stderr.text).toBe('');
    expect(legacy.stderr.text).toBe('');
    expect(numericLegacy.stderr.text).toBe('');
  });

  it('rejects repeated split modes and preserves an explicit numeric suffix start', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
`,
    });

    const repeated = await execute({ script: 'split -l 2 -l 2 input.txt repeated-' });
    const legacyOverride = await execute({ script: 'split -3 -d2 input.txt legacy-override-' });
    const preserved = await execute({
      script: 'split --numeric-suffixes=7 -d -a 3 -l 2 input.txt preserved-',
    });

    expect(repeated.stdout.text).toBe('');
    expect(repeated.stderr.text).toContain('split: cannot split in more than one way');
    expect(repeated.result.exitCode).toBe(1);
    expect(await readFile({ path: 'legacy-override-00' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'legacy-override-01' })).toBe(`\
c
`);
    expect(legacyOverride.stderr.text).toBe('');
    expect(legacyOverride.result.exitCode).toBe(0);
    expect(await readFile({ path: 'preserved-007' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'preserved-008' })).toBe(`\
c
`);
    expect(preserved.stderr.text).toBe('');
    expect(preserved.result.exitCode).toBe(0);
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

  it('refuses to overwrite the input through an existing output symlink alias', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
first
second
`,
    });
    await wesh.vfs.symlink({ path: '/part_aa', targetPath: 'input.txt' });

    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 input.txt part_',
    });

    expect(await readFile({ path: 'input.txt' })).toBe(`\
first
second
`);
    expect(await wesh.vfs.readlink({ path: '/part_aa' })).toBe('input.txt');
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("split: 'part_aa' would overwrite input; aborting\n");
    expect(result.exitCode).toBe(1);
  });

  it('refuses to overwrite a canonical input through an input symlink alias', async () => {
    await writeFile({
      path: 'xaa',
      data: `\
first
second
`,
    });
    await wesh.vfs.symlink({ path: '/input-link', targetPath: 'xaa' });

    const { result, stdout, stderr } = await execute({
      script: 'split -l 1 input-link',
    });

    expect(await readFile({ path: 'xaa' })).toBe(`\
first
second
`);
    expect(await wesh.vfs.readlink({ path: '/input-link' })).toBe('xaa');
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

  it('lets an early --help ignore later invalid options but not earlier errors', async () => {
    const helpFirst = await execute({ script: 'split --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'split --definitely-invalid-option --help' });
    const consumedHelp = await execute({ script: 'split -l --help' });

    expect(helpFirst.stdout.text).toContain('Split a file into pieces');
    expect(helpFirst.stderr.text).toBe('');
    expect(helpFirst.result.exitCode).toBe(0);
    expect(invalidFirst.stdout.text).toBe('');
    expect(invalidFirst.stderr.text).toContain("split: unrecognized option '--definitely-invalid-option'");
    expect(invalidFirst.result.exitCode).toBe(1);
    expect(consumedHelp.stdout.text).toBe('');
    expect(consumedHelp.stderr.text).toContain("split: invalid number of lines: '--help'");
    expect(consumedHelp.result.exitCode).toBe(1);
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
