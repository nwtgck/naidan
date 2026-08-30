import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { TEST_ONLY as SORT_INDEX_TEST_ONLY } from './index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('external sort run ordering', () => {
  it('preserves source order when active runs occupy different merge levels', () => {
    expect(SORT_INDEX_TEST_ONLY.orderSortRunPaths({
      paths: ['late-level-zero', 'early-level-one', 'latest-level-zero'],
      inputOrderByPath: new Map([
        ['early-level-one', 0],
        ['late-level-zero', 32],
        ['latest-level-zero', 33],
      ]),
    })).toEqual([
      'early-level-one',
      'late-level-zero',
      'latest-level-zero',
    ]);
  });

  it('rejects active runs without source-order metadata', () => {
    expect(() => SORT_INDEX_TEST_ONLY.orderSortRunPaths({
      paths: ['missing'],
      inputOrderByPath: new Map(),
    })).toThrow('Missing sort run input order');
  });
});

describe('wesh sort', () => {
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
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function readFile({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
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

  it('sorts stdin lexically by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort`,
      stdinText: `\
beta
alpha
`,
    });

    expect(stdout.text).toBe(`\
alpha
beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('combines stdin, - operand, and files in argument order', async () => {
    await writeFile({ path: 'file.txt', data: 'beta\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
sort file.txt -`,
      stdinText: `\
gamma
alpha
`,
    });

    expect(stdout.text).toBe(`\
alpha
beta
gamma
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports numeric sort with -n and last-resort line ordering', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -n`,
      stdinText: `\
b2
a2
`,
    });

    expect(stdout.text).toBe(`\
a2
b2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long sort options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sort --numeric-sort --reverse',
      stdinText: `\
2
10
1
`,
    });

    expect(stdout.text).toBe(`\
10
2
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves input order among equal keys with -s', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -sn`,
      stdinText: `\
b2
a2
`,
    });

    expect(stdout.text).toBe(`\
b2
a2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('deduplicates lines with -u', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -n -u`,
      stdinText: `\
02
2
1
`,
    });

    expect(stdout.text).toBe(`\
1
02
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports reverse sorting with -r', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -r`,
      stdinText: `\
beta
alpha
gamma
`,
    });

    expect(stdout.text).toBe(`\
gamma
beta
alpha
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('sorts by key definition and field separator with -b, -t, and -k', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -b -t: -k2,2`,
      stdinText: `\
row: b
row:a
`,
    });

    expect(stdout.text).toBe(`\
row:a
row: b
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long key and field-separator options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sort --ignore-leading-blanks --field-separator=: --key=2,2',
      stdinText: `\
row: b
row:a
`,
    });

    expect(stdout.text).toBe(`\
row:a
row: b
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports dictionary order with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -d`,
      stdinText: `\
a!b
a1b
`,
    });

    expect(stdout.text).toBe(`\
a1b
a!b
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports ignore nonprinting with -i', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -i`,
      stdinText: `a\x01b\na1b\n`,
    });

    expect(stdout.text).toBe(`a1b\na\x01b\n`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports general numeric sort with -g', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -g`,
      stdinText: `\
2e2
9
10
`,
    });

    expect(stdout.text).toBe(`\
9
10
2e2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('orders NaN before numeric values with -g', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -g`,
      stdinText: `\
9
NaN
-3.5
1e2
Infinity
`,
    });

    expect(stdout.text).toBe(`\
NaN
-3.5
9
1e2
Infinity
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports human numeric sort with -h', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -h`,
      stdinText: `\
2K
500
1K
`,
    });

    expect(stdout.text).toBe(`\
500
1K
2K
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats only lowercase k as a lowercase human-numeric suffix', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -h`,
      stdinText: `\
3M
1e2
2
1m
`,
    });

    expect(stdout.text).toBe(`\
1e2
1m
2
3M
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports month sort with -M', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -M`,
      stdinText: `\
Dec
Feb
Jan
`,
    });

    expect(stdout.text).toBe(`\
Jan
Feb
Dec
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

  });

  it('orders invalid month names before valid months with -M', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -M`,
      stdinText: `\
Feb
invalid
Dec
Jan
`,
    });

    expect(stdout.text).toBe(`\
invalid
Jan
Feb
Dec
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('treats all invalid month names as one key with -M -u', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -M -u`,
      stdinText: `\
invalid

other
Jan
`,
    });

    expect(stdout.text).toBe(`\
invalid
Jan
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports version sort with -V', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -V`,
      stdinText: `\
v1.10
v1.2
v1.9
`,
    });

    expect(stdout.text).toBe(`\
v1.2
v1.9
v1.10
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('orders an empty record before dot-prefixed records with -V', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'LC_ALL=C sort -V',
      stdinText: `\
.5

..
`,
    });

    expect(stdout.text).toBe(`\

..
.5
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports merge mode with already sorted files', async () => {
    await writeFile({ path: 'left.txt', data: `\
a
c
` });
    await writeFile({ path: 'right.txt', data: `\
b
d
` });

    const { result, stdout, stderr } = await execute({
      script: `\
sort -m left.txt right.txt`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a
b
c
d
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports merge mode together with key selection', async () => {
    await writeFile({ path: 'left.txt', data: `\
a2
b1
` });
    await writeFile({ path: 'right.txt', data: `\
a3
b0
` });

    const { result, stdout, stderr } = await execute({
      script: 'sort -m -k1,1 left.txt right.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a2
a3
b0
b1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['-o first -o second'],
    ['--output=first --output=second'],
    ['-ofirst --output=second'],
  ])('rejects distinct output file selections: %s', async (outputArguments) => {
    const { result, stdout, stderr } = await execute({
      script: `printf 'b\na\n' | sort ${outputArguments}`,
    });

    expect(result.exitCode).toBe(2);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sort: multiple output files specified');
    expect(await execute({ script: 'test ! -e first && test ! -e second && test ! -e same' })).toMatchObject({
      result: { exitCode: 0 },
    });
  });

  it('allows the same output path to be selected repeatedly', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf 'b
a
' | sort -o same --output=same && cat same`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
a
b
`);
    expect(stderr.text).toBe('');
  });

  it('writes output to a file with -o', async () => {
    await writeFile({ path: 'input.txt', data: `\
beta
alpha
` });

    const { result, stdout, stderr } = await execute({
      script: `\
sort -o output.txt input.txt`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'output.txt' })).toBe(`\
alpha
beta
`);
  });

  it('reports an invalid TMPDIR when a large merge requires temporary files', async () => {
    const fileNames: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const value = index.toString().padStart(2, '0');
      const fileName = `merge-${value}.txt`;
      fileNames.push(fileName);
      await writeFile({ path: fileName, data: `${value}\n` });
    }

    const { result, stdout, stderr } = await execute({
      script: `TMPDIR=missing sort -m ${fileNames.join(' ')}`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sort: cannot create temporary file in 'missing':");
    expect(result.exitCode).toBe(2);
  });

  it('supports the long --output form', async () => {
    await writeFile({ path: 'input.txt', data: `\
beta
alpha
` });

    const { result, stdout, stderr } = await execute({
      script: 'sort --output=output.txt input.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'output.txt' })).toBe(`\
alpha
beta
`);
  });

  it('supports root-relative input and output paths from /', async () => {
    await writeFile({ path: 'root-input.txt', data: `\
beta
alpha
` });

    const { result, stdout, stderr } = await execute({
      script: 'cd /; sort /root-input.txt -o root-output.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'root-output.txt' })).toBe(`\
alpha
beta
`);
  });

  it('preserves and distinguishes arbitrary record bytes', async () => {
    await writeFile({
      path: 'invalid.txt',
      data: new Uint8Array([
        98, 255, 10,
        97, 255, 10,
        97, 254, 10,
      ]),
    });
    await writeFile({
      path: 'invalid-zero.txt',
      data: new Uint8Array([98, 255, 0, 97, 254, 0]),
    });
    await writeFile({
      path: 'numeric-invalid.txt',
      data: new Uint8Array([50, 255, 10, 50, 254, 10]),
    });

    const sorted = await execute({ script: 'LC_ALL=C sort invalid.txt' });
    const unique = await execute({ script: 'LC_ALL=C sort -u invalid.txt' });
    const zero = await execute({ script: 'LC_ALL=C sort -z invalid-zero.txt' });
    const numericUnique = await execute({
      script: 'LC_ALL=C sort -n -u numeric-invalid.txt',
    });
    const numericStable = await execute({
      script: 'LC_ALL=C sort -n -s numeric-invalid.txt',
    });

    expect([...sorted.stdout.buffer]).toEqual([
      97, 254, 10,
      97, 255, 10,
      98, 255, 10,
    ]);
    expect([...unique.stdout.buffer]).toEqual([
      97, 254, 10,
      97, 255, 10,
      98, 255, 10,
    ]);
    expect([...zero.stdout.buffer]).toEqual([
      97, 254, 0,
      98, 255, 0,
    ]);
    expect([...numericUnique.stdout.buffer]).toEqual([50, 255, 10]);
    expect([...numericStable.stdout.buffer]).toEqual([
      50, 255, 10,
      50, 254, 10,
    ]);
    for (const outcome of [
      sorted,
      unique,
      zero,
      numericUnique,
      numericStable,
    ]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('preserves carriage returns as sortable record bytes', async () => {
    await writeFile({
      path: 'crlf.txt',
      data: new Uint8Array([98, 13, 10, 97, 10]),
    });

    const { result, stdout, stderr } = await execute({
      script: 'LC_ALL=C sort crlf.txt',
    });

    expect([...stdout.buffer]).toEqual([97, 10, 98, 13, 10]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves arbitrary bytes through multi-level merge runs', async () => {
    const fileNames: string[] = [];
    for (let index = 32; index >= 0; index -= 1) {
      const fileName = `invalid-merge-${index}.txt`;
      fileNames.push(fileName);
      await writeFile({
        path: fileName,
        data: new Uint8Array([97, 128 + index, 10]),
      });
    }

    const { result, stdout, stderr } = await execute({
      script: `LC_ALL=C TMPDIR=. sort -m ${fileNames.join(' ')}`,
    });
    const expected: number[] = [];
    for (let index = 0; index <= 32; index += 1) {
      expected.push(97, 128 + index, 10);
    }

    expect([...stdout.buffer]).toEqual(expected);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports zero-terminated input and output with -z', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -z`,
      stdinText: 'b\0a\0',
    });

    expect(stdout.text).toBe('a\0b\0');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports unsorted input with -c and exits 1', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -c`,
      stdinText: `\
beta
alpha
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sort: disorder at line 2: alpha');
    expect(result.exitCode).toBe(1);
  });

  it('checks silently with -C', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -C`,
      stdinText: `\
beta
alpha
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('treats duplicate keys as disorder in check mode when -u is active', async () => {
    for (const option of ['-c -u', '-C -u']) {
      const { result, stdout, stderr } = await execute({
        script: `sort ${option}`,
        stdinText: `\
alpha
alpha
beta
`,
      });

      expect(stdout.text).toBe('');
      expect(result.exitCode).toBe(1);
      if (option.startsWith('-c')) {
        expect(stderr.text).toContain('sort: disorder at line 2: alpha');
      } else {
        expect(stderr.text).toBe('');
      }
    }
  });

  it('rejects multiple input files in check modes before reading them', async () => {
    await writeFile({ path: 'left', data: 'alpha\n' });
    await writeFile({ path: 'right', data: 'beta\n' });

    for (const { option, diagnosticOption } of [
      { option: '-c', diagnosticOption: '-c' },
      { option: '-C', diagnosticOption: '-C' },
      { option: '--check', diagnosticOption: '-c' },
      { option: '--check=quiet', diagnosticOption: '-C' },
    ]) {
      const { result, stdout, stderr } = await execute({
        script: `sort ${option} left right`,
      });

      expect(stdout.text).toBe('');
      expect(stderr.text).toContain(`sort: extra operand 'right' not allowed with ${diagnosticOption}`);
      expect(result.exitCode).toBe(2);
    }
  });

  it('supports the long --check form', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --check`,
      stdinText: `\
beta
alpha
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sort: disorder at line 2: alpha');
    expect(result.exitCode).toBe(1);
  });

  it('supports the quiet long check form', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --check=quiet`,
      stdinText: `\
beta
alpha
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('reports invalid options with usage and help hints', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --no-such-option`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sort: unrecognized option '--no-such-option'");
    expect(stderr.text).toContain('usage: sort [OPTION]... [FILE]...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(2);
  });

  it('validates malformed key syntax before a later --help without moving semantic mode conflicts ahead of help', async () => {
    const malformedKey = await execute({ script: 'sort -k bogus --help' });
    const helpFirst = await execute({ script: 'sort --help -k bogus' });
    const incompatibleKeyModes = await execute({ script: 'sort -k 1n,1h --help' });

    expect(malformedKey.result.exitCode).toBe(2);
    expect(malformedKey.stderr.text).toContain("invalid key definition: 'bogus'");
    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stderr.text).toBe('');
    expect(incompatibleKeyModes.result.exitCode).toBe(0);
    expect(incompatibleKeyModes.stderr.text).toBe('');
  });

  it('validates fatal sort option relationships before a later --help', async () => {
    const invalidSeparator = await execute({ script: 'sort -t xx --help' });
    const distinctSeparators = await execute({ script: 'sort -t x -t y --help' });
    const duplicateSeparator = await execute({ script: 'sort -t x -t x --help' });
    const distinctOutputs = await execute({ script: 'sort -o a -o b --help' });
    const duplicateOutput = await execute({ script: 'sort -o a -o a --help' });
    const conflictingChecks = await execute({ script: 'sort -c -C --help' });
    const duplicateCheck = await execute({ script: 'sort -c -c --help' });

    for (const execution of [invalidSeparator, distinctSeparators, distinctOutputs, conflictingChecks]) {
      expect(execution.result.exitCode).toBe(2);
      expect(execution.stdout.text).toBe('');
    }
    expect(invalidSeparator.stderr.text).toContain('multi-character field separator');
    expect(distinctSeparators.stderr.text).toContain('incompatible field separators');
    expect(distinctOutputs.stderr.text).toContain('multiple output files specified');
    expect(conflictingChecks.stderr.text).toContain("options '-cC' are incompatible");

    for (const execution of [duplicateSeparator, duplicateOutput, duplicateCheck]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stderr.text).toBe('');
      expect(execution.stdout.text).toContain('usage: sort [OPTION]... [FILE]...');
    }
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({
      script: `\
sort --help --no-such-option`,
      stdinText: undefined,
    });
    const invalidFirst = await execute({
      script: `\
sort --no-such-option --help`,
      stdinText: undefined,
    });

    expect(helpFirst.stdout.text).toContain('usage: sort [OPTION]... [FILE]...');
    expect(helpFirst.stderr.text).toBe('');
    expect(helpFirst.result.exitCode).toBe(0);
    expect(invalidFirst.stdout.text).toBe('');
    expect(invalidFirst.stderr.text).toContain("sort: unrecognized option '--no-such-option'");
    expect(invalidFirst.result.exitCode).toBe(2);
  });

  it('reports missing key operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -k`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sort: -k requires a value for KEYDEF');
    expect(stderr.text).toContain('usage: sort [OPTION]... [FILE]...');
    expect(stderr.text).toContain('try:');
    expect(result.exitCode).toBe(2);
  });

  it('prints structured help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --help`,
      stdinText: undefined,
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Sort lines of text files');
    expect(stdout.text).toContain('usage: sort [OPTION]... [FILE]...');
    expect(stdout.text).toContain('-k KEYDEF, --key=KEYDEF');
    expect(stdout.text).toContain('-n, --numeric-sort');
    expect(result.exitCode).toBe(0);
  });

  it('uses the original line as the last-resort comparison after normalization', async () => {
    const dictionary = await execute({
      script: 'sort -d',
      stdinText: `\
a-b
ab
a.b
a b
`,
    });
    const folded = await execute({
      script: 'sort -f',
      stdinText: `\
beta
Alpha
alpha
ALPHA
`,
    });

    expect(dictionary.stdout.text).toBe(`\
a b
a-b
a.b
ab
`);
    expect(folded.stdout.text).toBe(`\
ALPHA
Alpha
alpha
beta
`);
    expect(dictionary.stderr.text).toBe('');
    expect(folded.stderr.text).toBe('');
    expect(dictionary.result.exitCode).toBe(0);
    expect(folded.result.exitCode).toBe(0);
  });

  it('matches GNU numeric, general numeric, human numeric, and version ordering boundaries', async () => {
    const numeric = await execute({
      script: 'sort -n',
      stdinText: `\
1e2
100
2
.5
-.25
+3x
text
`,
    });
    const general = await execute({
      script: 'sort -g',
      stdinText: `\
NaN
-nan
inf
-inf
Infinity
1e3
2
text
`,
    });
    const human = await execute({
      script: 'sort -h',
      stdinText: `\
1023
1K
1KB
1KiB
1k
2M
0.5K
`,
    });
    const version = await execute({
      script: 'sort -V',
      stdinText: `\
a1.10
a1.9
a01
a1
a~1
a-1
a.1
`,
    });

    expect(numeric.stdout.text).toBe(`\
-.25
+3x
text
.5
1e2
2
100
`);
    expect(general.stdout.text).toBe(`\
text
-nan
NaN
-inf
2
1e3
Infinity
inf
`);
    expect(human.stdout.text).toBe(`\
1023
0.5K
1K
1KB
1KiB
1k
2M
`);
    expect(version.stdout.text).toBe(`\
a~1
a01
a1
a1.9
a1.10
a-1
a.1
`);
    for (const execution of [numeric, general, human, version]) {
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('rejects incompatible global ordering modes and multi-character field separators', async () => {
    const modes = await execute({ script: 'sort -n -V', stdinText: `\
2
10
` });
    const separator = await execute({ script: "sort -t '::'", stdinText: 'a::b\n' });
    const multibyteSeparator = await execute({
      script: "LC_ALL=C.utf8 sort -t 'é'",
      stdinText: `\
aé2
bé1
`,
    });

    expect(modes.stdout.text).toBe('');
    expect(modes.stderr.text).toContain('multiple ordering options are incompatible');
    expect(modes.result.exitCode).toBe(2);
    for (const execution of [separator, multibyteSeparator]) {
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('multi-character field separator');
      expect(execution.result.exitCode).toBe(2);
    }
  });

  it('accepts a key range whose end precedes its start as an empty key', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sort -k2,1',
      stdinText: `\
b z
a y
`,
    });

    expect(stdout.text).toBe(`\
a y
b z
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('orders arbitrary-precision negative numbers and fractions without Number rounding', async () => {
    const integers = await execute({
      script: 'sort -n',
      stdinText: `\
-9007199254740992
-9007199254740993
-90071992547409920
`,
    });
    const fractions = await execute({
      script: 'sort -n',
      stdinText: `\
-1.0000000000000001
-1.0000000000000002
-1.00000000000000001
`,
    });

    expect(integers.stdout.text).toBe(`\
-90071992547409920
-9007199254740993
-9007199254740992
`);
    expect(fractions.stdout.text).toBe(`\
-1.0000000000000002
-1.0000000000000001
-1.00000000000000001
`);
    for (const execution of [integers, fractions]) {
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('orders negative human-readable values by signed magnitude', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sort -h',
      stdinText: `\
-1K
-1M
-2K
-1024
-0.5M
0
1K
1M
`,
    });

    expect(stdout.text).toBe(`\
-1M
-0.5M
-2K
-1K
-1024
0
1K
1M
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches GNU version ordering for leading zeros, hidden names, and releases', async () => {
    const leadingZeros = await execute({
      script: 'sort -V',
      stdinText: `\
a0
a00
a000
a01
a001
a1
a10
a010
`,
    });
    const hiddenNames = await execute({
      script: 'sort -V',
      stdinText: `\
.
..
.a
.a1
.a~1
a
`,
    });
    const releases = await execute({
      script: 'sort -V',
      stdinText: `\
pkg-1.0
pkg-1.0~rc1
pkg-1.0-1
pkg-1.0.1
pkg-1.0+git
pkg-1.00
`,
    });

    expect(leadingZeros.stdout.text).toBe(`\
a0
a00
a000
a001
a01
a1
a010
a10
`);
    expect(hiddenNames.stdout.text).toBe(`\
.
..
.a~1
.a
.a1
a
`);
    expect(releases.stdout.text).toBe(`\
pkg-1.0~rc1
pkg-1.0
pkg-1.00
pkg-1.0+git
pkg-1.0-1
pkg-1.0.1
`);
    for (const execution of [leadingZeros, hiddenNames, releases]) {
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('deduplicates version-equivalent leading-zero forms with -u', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sort -Vu',
      stdinText: `\
a01
a1
a001
a1
`,
    });

    expect(stdout.text).toBe('a01\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

});

describe('wesh sort Linux character classification compatibility', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { LC_ALL: 'C' },
    });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText: string;
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

  it('accepts only ASCII blanks before numeric, general numeric, human numeric, and month keys', async () => {
    const numeric = await execute({ script: 'sort -n', stdinText: `\
 10
2
` });
    expect(numeric.stdout.text).toBe(`\
2
 10
`);

    const generalUnicode = await execute({ script: 'sort -g', stdinText: '\u00A010\n2\n' });
    expect(generalUnicode.stdout.text).toBe('\u00A010\n2\n');

    const humanUnicode = await execute({ script: 'sort -h', stdinText: '\u200310K\n2K\n' });
    expect(humanUnicode.stdout.text).toBe('\u200310K\n2K\n');

    const monthUnicode = await execute({ script: 'sort -M', stdinText: '\u00A0Dec\nJan\n' });
    expect(monthUnicode.stdout.text).toBe('\u00A0Dec\nJan\n');

    for (const execution of [numeric, generalUnicode, humanUnicode, monthUnicode]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stderr.text).toBe('');
    }
  });

  it('folds ASCII case only and treats non-ASCII code points as nonprinting', async () => {
    const fold = await execute({
      script: 'sort -fu',
      stdinText: `\
É
é
β
B
b
`,
    });
    expect(fold.stdout.text).toBe(`\
B
É
é
β
`);

    const ignore = await execute({
      script: 'sort -iu',
      stdinText: `\
É
é
β
B
b
`,
    });
    expect(ignore.stdout.text).toBe(`\
É
B
b
`);

    const combined = await execute({
      script: 'sort -ifu',
      stdinText: `\
É
é
β
B
b
`,
    });
    expect(combined.stdout.text).toBe(`\
É
B
`);

    for (const execution of [fold, ignore, combined]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stderr.text).toBe('');
    }
  });
});

describe('wesh sort UTF-8 lexical compatibility', () => {
  it('orders valid Unicode scalar values by UTF-8-compatible code-point order', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: 'sort' }),
      stdin: createTestReadHandleFromText({ text: '\u{10000}\n\uE000\n' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('\uE000\n\u{10000}\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the same order for the last-resort whole-line comparison', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: 'sort -n' }),
      stdin: createTestReadHandleFromText({ text: '2\u{10000}\n2\uE000\n' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('2\uE000\n2\u{10000}\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});

describe('wesh sort key character positions', () => {
  it('counts key character positions as bytes in multibyte locales', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: 'LC_ALL=C.utf8 sort -k1.2,1.2' }),
      stdin: createTestReadHandleFromText({ text: `\
éA
ê0
` }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
éA
ê0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('uses byte positions and permits character offsets past a field boundary in the C locale', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: 'LC_ALL=C sort -k1.2,1.4' }),
      stdin: createTestReadHandleFromText({ text: `\
#
!\t4KiB
_ # Feb
0 4KiB x
 v1.2 3M 01
` }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
#
!\t4KiB
_ # Feb
0 4KiB x
 v1.2 3M 01
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps leading blanks significant in the first key field unless -b is used', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    const significantStdout = createTestWriteCaptureHandle();
    const ignoredStdout = createTestWriteCaptureHandle();
    const significant = await wesh.execute({
      source: createTextShellSource({ text: 'LC_ALL=C sort -f -k1,1 -s' }),
      stdin: createTestReadHandleFromText({ text: `\
 -1 inf
! z
- a
` }),
      stdout: significantStdout.handle,
      stderr: createTestWriteCaptureHandle().handle,
    });
    const ignored = await wesh.execute({
      source: createTextShellSource({ text: 'LC_ALL=C sort -b -f -k1,1 -s' }),
      stdin: createTestReadHandleFromText({ text: `\
 -1 inf
! z
- a
` }),
      stdout: ignoredStdout.handle,
      stderr: createTestWriteCaptureHandle().handle,
    });

    expect(significantStdout.text).toBe(`\
 -1 inf
! z
- a
`);
    expect(ignoredStdout.text).toBe(`\
! z
- a
 -1 inf
`);
    expect(significant.exitCode).toBe(0);
    expect(ignored.exitCode).toBe(0);
  });
});
