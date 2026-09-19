import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh column', () => {
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
    data: string,
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

  it('prints help with the implemented option surface', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column --help',
    });
    const shortHelp = await execute({
      script: 'column -h',
    });

    expect(stdout.text).toContain('Columnate lists or create aligned tables');
    expect(stdout.text).toContain('usage: column [OPTION]... [FILE]...');
    expect(stdout.text).toContain('--table');
    expect(stdout.text).toContain('--fillrows');
    expect(stdout.text).toContain('--table-columns');
    expect(stdout.text).toContain('--table-right');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(shortHelp.stdout.text).toBe(stdout.text);
    expect(shortHelp.stderr.text).toBe('');
    expect(shortHelp.result.exitCode).toBe(0);
  });

  it('creates a whitespace-delimited table from stdin', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t',
      stdinText: `\
NAME COUNT
apple 9
banana 12
`,
    });

    expect(stdout.text).toBe(`\
NAME    COUNT
apple   9
banana  12
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads files and explicit stdin operands in order', async () => {
    await writeFile({
      path: 'right.txt',
      data: `\
b 2
c 3
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'column -t - right.txt',
      stdinText: `\
a 1
`,
    });

    expect(stdout.text).toBe(`\
a  1
b  2
c  3
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('consumes repeated stdin operands sequentially instead of replaying cached input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t - -',
      stdinText: `\
a 1
`,
    });

    expect(stdout.text).toBe(`\
a  1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues after missing file errors and formats readable inputs', async () => {
    await writeFile({
      path: 'present.txt',
      data: `\
ok 1
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'column -t missing.txt present.txt',
    });

    expect(stdout.text).toBe(`\
ok  1
`);
    expect(stderr.text).toContain('column: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('preserves empty fields for explicit table separators', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t -s :',
      stdinText: `\
a:b:c
1::3
`,
    });

    expect(stdout.text).toBe(`\
a  b  c
1     3
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats explicit separators as literal Unicode characters', async () => {
    const hyphenRange = await execute({
      script: "column -t -s 'x-z'",
      stdinText: 'leftymiddle-rightxendzlast\n',
    });
    const emoji = await execute({
      script: "column -t -s '😀'",
      stdinText: 'a😀b\n',
    });
    const limitedEmoji = await execute({
      script: "column -t -s '😀' -l 2",
      stdinText: 'a😀b😀c\n',
    });

    expect(hyphenRange.stdout.text).toBe('leftymiddle  right  end  last\n');
    expect(emoji.stdout.text).toBe('a  b\n');
    expect(limitedEmoji.stdout.text).toBe('a  b😀c\n');
    expect(hyphenRange.stderr.text).toBe('');
    expect(emoji.stderr.text).toBe('');
    expect(limitedEmoji.stderr.text).toBe('');
    expect(hyphenRange.result.exitCode).toBe(0);
    expect(emoji.result.exitCode).toBe(0);
    expect(limitedEmoji.result.exitCode).toBe(0);
  });

  it('supports table headers, hidden headings, and header input rows', async () => {
    const explicit = await execute({
      script: 'column -t -s , -N NAME,COUNT',
      stdinText: `\
apple,9
banana,12
`,
    });
    const hidden = await execute({
      script: 'column -t -s , -N NAME,COUNT -d',
      stdinText: `\
apple,9
banana,12
`,
    });
    const headerAsColumns = await execute({
      script: 'column -t -s , -K',
      stdinText: `\
NAME,COUNT
apple,9
banana,12
`,
    });

    expect(explicit.stdout.text).toBe(`\
NAME    COUNT
apple   9
banana  12
`);
    expect(hidden.stdout.text).toBe(`\
apple   9
banana  12
`);
    expect(headerAsColumns.stdout.text).toBe(explicit.stdout.text);
    expect(explicit.stderr.text).toBe('');
    expect(hidden.stderr.text).toBe('');
    expect(headerAsColumns.stderr.text).toBe('');
    expect(explicit.result.exitCode).toBe(0);
    expect(hidden.result.exitCode).toBe(0);
    expect(headerAsColumns.result.exitCode).toBe(0);
  });

  it('right-aligns selected table columns by index or header name', async () => {
    const byIndex = await execute({
      script: 'column -t -s , -R 2',
      stdinText: `\
name,count
apple,9
banana,12
`,
    });
    const byName = await execute({
      script: 'column -t -s , -K -R count',
      stdinText: `\
name,count
apple,9
banana,12
`,
    });

    expect(byIndex.stdout.text).toBe(`\
name    count
apple       9
banana     12
`);
    expect(byName.stdout.text).toBe(byIndex.stdout.text);
    expect(byIndex.stderr.text).toBe('');
    expect(byName.stderr.text).toBe('');
    expect(byIndex.result.exitCode).toBe(0);
    expect(byName.result.exitCode).toBe(0);
  });

  it('keeps hidden explicit header columns in last-column selector resolution', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t -s , -N A,B,C -d -R -1',
      stdinText: `\
a,9
bb,10
`,
    });

    expect(stdout.text).toBe(`\
a   9
bb  10
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('limits parsed table columns by joining the remaining fields into the final column', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t -s : -l 3',
      stdinText: `\
a:b:c:d
1:2:3:4
`,
    });
    const multipleSeparators = await execute({
      script: "column -t -s ':;' -l 2",
      stdinText: `\
key:a;b
x:1;2
`,
    });

    expect(stdout.text).toBe(`\
a  b  c:d
1  2  3:4
`);
    expect(multipleSeparators.stdout.text).toBe(`\
key  a;b
x    1;2
`);
    expect(stderr.text).toBe('');
    expect(multipleSeparators.stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(multipleSeparators.result.exitCode).toBe(0);
  });

  it('formats list mode by filling columns before rows and rows before columns', async () => {
    const columnsFirst = await execute({
      script: 'column -S 2 -c 14',
      stdinText: `\
one two three four five six
`,
    });
    const rowsFirst = await execute({
      script: 'column -S 2 -c 14 -x',
      stdinText: `\
one two three four five six
`,
    });

    expect(columnsFirst.stdout.text).toBe(`\
one    four
two    five
three  six
`);
    expect(rowsFirst.stdout.text).toBe(`\
one    two
three  four
five   six
`);
    expect(columnsFirst.stderr.text).toBe('');
    expect(rowsFirst.stderr.text).toBe('');
    expect(columnsFirst.result.exitCode).toBe(0);
    expect(rowsFirst.result.exitCode).toBe(0);
  });

  it('supports the deprecated --columns alias for output width', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -S 2 --columns=14',
      stdinText: `\
one two three four five six
`,
    });

    expect(stdout.text).toBe(`\
one    four
two    five
three  six
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the COLUMNS environment value when output width is not provided', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
export COLUMNS=14
column -S 2
`,
      stdinText: `\
one two three four five six
`,
    });

    expect(stdout.text).toBe(`\
one    four
two    five
three  six
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps empty lines when requested', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t -L',
      stdinText: `\
a 1

b 2
`,
    });

    expect(stdout.text).toBe(`\
a  1

b  2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accounts for CJK display width in table padding', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t',
      stdinText: `\
名前 値
abc 1
`,
    });

    expect(stdout.text).toBe(`\
名前  値
abc   1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accounts for emoji and combining marks in table padding', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t',
      stdinText: '😀 x\ne\u0301 y\na z\n',
    });

    expect(stdout.text).toBe('😀  x\ne\u0301   y\na   z\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('formats large list inputs without testing every possible column count', async () => {
    const itemCount = 20_000;
    const { result, stdout, stderr } = await execute({
      script: 'column',
      stdinText: 'x '.repeat(itemCount),
    });
    const outputItems = stdout.text.trim().split(/\s+/u);

    expect(outputItems).toHaveLength(itemCount);
    expect(outputItems.every((item) => item === 'x')).toBe(true);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles table row counts above the JavaScript function argument limit', async () => {
    const input = 'x\n'.repeat(150_000);
    const { result, stdout, stderr } = await execute({
      script: 'column -t',
      stdinText: input,
    });

    expect(stdout.text).toBe(input);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('formats input that does not end with a newline', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'column -t',
      stdinText: 'a 1',
    });

    expect(stdout.text).toBe(`\
a  1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('stops option parsing at -- so dash-prefixed file names can be read', async () => {
    await writeFile({
      path: '-t',
      data: `\
file 1
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'column -t -- -t',
    });

    expect(stdout.text).toBe(`\
file  1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports special and range table-right selectors', async () => {
    const last = await execute({
      script: 'column -t -s , -R -1',
      stdinText: `\
a,b
xx,3
z,10
`,
    });
    const range = await execute({
      script: 'column -t -s , -R 1-2',
      stdinText: `\
a,b
xx,3
z,10
`,
    });
    const all = await execute({
      script: 'column -t -s , -R 0',
      stdinText: `\
a,b
xx,3
z,10
`,
    });

    expect(last.stdout.text).toBe(`\
a    b
xx   3
z   10
`);
    expect(range.stdout.text).toBe(`\
 a   b
xx   3
 z  10
`);
    expect(all.stdout.text).toBe(range.stdout.text);
    expect(last.stderr.text).toBe('');
    expect(range.stderr.text).toBe('');
    expect(all.stderr.text).toBe('');
    expect(last.result.exitCode).toBe(0);
    expect(range.result.exitCode).toBe(0);
    expect(all.result.exitCode).toBe(0);
  });

  it('reports invalid options, missing option values, and incompatible table header options as usage errors', async () => {
    const invalidOption = await execute({ script: 'column -Z' });
    const missingValue = await execute({ script: 'column -c' });
    const incompatible = await execute({ script: 'column -t -K -N A,B' });

    expect(invalidOption.stdout.text).toBe('');
    expect(invalidOption.stderr.text).toContain("column: invalid option -- 'Z'");
    expect(invalidOption.stderr.text).toContain('usage: column [OPTION]... [FILE]...');
    expect(invalidOption.result.exitCode).toBe(1);

    expect(missingValue.stdout.text).toBe('');
    expect(missingValue.stderr.text).toContain('column: -c requires a value for width');
    expect(missingValue.stderr.text).toContain('usage: column [OPTION]... [FILE]...');
    expect(missingValue.result.exitCode).toBe(1);

    expect(incompatible.stdout.text).toBe('');
    expect(incompatible.stderr.text).toContain('column: --table-header-as-columns cannot be used with --table-columns');
    expect(incompatible.stderr.text).toContain('usage: column [OPTION]... [FILE]...');
    expect(incompatible.result.exitCode).toBe(1);
  });

  it('accepts numeric options at the documented safety boundary', async () => {
    const width = await execute({ script: 'column -c 1000000', stdinText: 'x\n' });
    const spacing = await execute({ script: 'column -S 1000000', stdinText: 'x\n' });
    const columnLimit = await execute({ script: 'column -t -l 1000000', stdinText: 'x\n' });

    for (const observed of [width, spacing, columnLimit]) {
      expect(observed.stdout.text).toBe('x\n');
      expect(observed.stderr.text).toBe('');
      expect(observed.result.exitCode).toBe(0);
    }
  });

  it('reports invalid numeric, separator, and table selector option values', async () => {
    const invalidWidth = await execute({ script: 'column --output-width=bad' });
    const excessiveWidth = await execute({ script: 'column --output-width=1000001' });
    const excessiveSpacing = await execute({ script: 'column -S 1000001' });
    const excessiveColumnLimit = await execute({ script: 'column -t -l 1000001' });
    const emptySeparator = await execute({ script: "column -s ''" });
    const invalidRange = await execute({ script: 'column -R 3-2' });

    expect(invalidWidth.stdout.text).toBe('');
    expect(invalidWidth.stderr.text).toContain("column: --output-width requires a positive integer, 0, or 'unlimited'");
    expect(invalidWidth.result.exitCode).toBe(1);

    expect(excessiveWidth.stdout.text).toBe('');
    expect(excessiveWidth.stderr.text).toContain('column: --output-width exceeds safety limit 1000000');
    expect(excessiveWidth.result.exitCode).toBe(1);
    expect(excessiveSpacing.stdout.text).toBe('');
    expect(excessiveSpacing.stderr.text).toContain('column: --use-spaces exceeds safety limit 1000000');
    expect(excessiveSpacing.result.exitCode).toBe(1);
    expect(excessiveColumnLimit.stdout.text).toBe('');
    expect(excessiveColumnLimit.stderr.text).toContain('column: --table-columns-limit exceeds safety limit 1000000');
    expect(excessiveColumnLimit.result.exitCode).toBe(1);

    expect(emptySeparator.stdout.text).toBe('');
    expect(emptySeparator.stderr.text).toContain('column: --separator requires a non-empty separator list');
    expect(emptySeparator.result.exitCode).toBe(1);

    expect(invalidRange.stdout.text).toBe('');
    expect(invalidRange.stderr.text).toContain('column: --table-right requires valid 1-based column ranges');
    expect(invalidRange.result.exitCode).toBe(1);
  });
});
