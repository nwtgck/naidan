import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh shuf', () => {
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

  async function readFile({ path }: { path: string }): Promise<string> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return file.text();
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

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'shuf --help' });
    const invalid = await execute({ script: 'shuf -x' });
    const extra = await execute({ script: 'shuf - -', stdinText: `\
one
two
` });

    expect(help.stdout.text).toContain('Randomly shuffle lines');
    expect(help.stdout.text).toContain('usage: shuf [OPTION]... [FILE]');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('shuf: invalid option');
    expect(invalid.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain("shuf: extra operand '-'");
    expect(extra.result.exitCode).toBe(1);
  });

  it('shuffles file input and honors -n without depending on exact order', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
alpha
beta
gamma
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'shuf -n 2 input.txt',
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

    const lines = stdout.text.trim().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => ['alpha', 'beta', 'gamma'].includes(line))).toBe(true);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('supports bounded repeated output and input ranges', async () => {
    const repeated = await execute({
      script: 'shuf -r -n 3',
      stdinText: 'only\n',
    });
    const range = await execute({
      script: 'shuf -r -n 3 -i 7-7',
    });

    expect(repeated.stdout.text).toBe(`\
only
only
only
`);
    expect(repeated.stderr.text).toBe('');
    expect(repeated.result.exitCode).toBe(0);
    expect(range.stdout.text).toBe(`\
7
7
7
`);
    expect(range.stderr.text).toBe('');
    expect(range.result.exitCode).toBe(0);
  });

  it('supports NUL records and preserves carriage returns as input bytes', async () => {
    const nul = await execute({
      script: 'shuf -z',
      stdinText: 'alpha\0',
    });
    const carriageReturn = await execute({
      script: 'shuf',
      stdinText: 'alpha\r\n',
    });

    expect(nul.stdout.text).toBe('alpha\0');
    expect(nul.stderr.text).toBe('');
    expect(nul.result.exitCode).toBe(0);

    expect(carriageReturn.stdout.text).toBe('alpha\r\n');
    expect(carriageReturn.stderr.text).toBe('');
    expect(carriageReturn.result.exitCode).toBe(0);
  });

  it('rejects distinct repeated output paths and allows the same path', async () => {
    const distinct = await execute({
      script: 'shuf -e -o first --output=second alpha',
    });
    const repeated = await execute({
      script: 'shuf -e -o same --output=same alpha',
    });

    expect(distinct.stdout.text).toBe('');
    expect(distinct.stderr.text).toContain('shuf: multiple output files specified');
    expect(distinct.result.exitCode).toBe(1);
    expect(repeated.stdout.text).toBe('');
    expect(repeated.stderr.text).toBe('');
    expect(repeated.result.exitCode).toBe(0);
    expect(await readFile({ path: 'same' })).toBe('alpha\n');
  });

  it('writes to an output file without duplicating output on stdout', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shuf -e -o output.txt alpha',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'output.txt' })).toBe('alpha\n');
  });

  it('does not allocate an output array proportional to head count', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shuf -n 999999999999999999999999',
      stdinText: 'only\n',
    });

    expect(stdout.text).toBe('only\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats a one-step descending input range as empty and rejects lower ranges', async () => {
    const empty = await execute({
      script: 'shuf -i 3-2',
    });
    const invalid = await execute({
      script: 'shuf -i 3-1',
    });

    expect(empty.stdout.text).toBe('');
    expect(empty.stderr.text).toBe('');
    expect(empty.result.exitCode).toBe(0);
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("shuf: invalid input range '3-1'");
    expect(invalid.result.exitCode).toBe(1);
  });

  it('parses uint64 input ranges without materializing values excluded by the head count', async () => {
    for (const operand of [
      '+7-+7',
      ' 7- 7',
      '\t7-\v+7',
      '18446744073709551615-18446744073709551615',
    ]) {
      const execution = await execute({
        script: `shuf -i '${operand}' -n 0`,
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    const singleton = await execute({
      script: 'shuf -i 18446744073709551615-18446744073709551615 -n 1',
    });
    expect(singleton.stdout.text).toBe('18446744073709551615\n');
    expect(singleton.stderr.text).toBe('');
    expect(singleton.result.exitCode).toBe(0);
  });

  it('samples unique values from a uint64 range without materializing the full range', async () => {
    const execution = await execute({
      script: 'shuf -i 18446744073709551614-18446744073709551615 -n 2',
    });

    expect(execution.stdout.text.split('\n').filter(Boolean).sort()).toEqual([
      '18446744073709551614',
      '18446744073709551615',
    ]);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('rejects overflowing and impractically large full-range materialization', async () => {
    const overflow = await execute({
      script: 'shuf -i 18446744073709551616-18446744073709551616 -n 0',
    });
    const unboundedMaterialization = await execute({
      script: 'shuf -i 0-1000000',
    });

    expect(overflow.stdout.text).toBe('');
    expect(overflow.stderr.text).toContain('invalid input range');
    expect(overflow.result.exitCode).toBe(1);
    expect(unboundedMaterialization.stdout.text).toBe('');
    expect(unboundedMaterialization.stderr.text).toContain('use a smaller --head-count');
    expect(unboundedMaterialization.result.exitCode).toBe(1);
  });

  it('shuffles stdin input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shuf',
      stdinText: `\
red
green
blue
`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

    const lines = stdout.text.trim().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => ['red', 'green', 'blue'].includes(line))).toBe(true);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('handles more input records than the JavaScript argument limit', async () => {
    const execution = await execute({
      script: 'shuf -n 1',
      stdinText: 'x\n'.repeat(200_000),
    });

    expect(execution.stdout.text).toBe('x\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('rejects negative input range boundaries', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shuf -r -n 2 -i -1--1',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("shuf: invalid input range '-1--1'");
    expect(result.exitCode).toBe(1);
  });


  it('accepts only leading C-locale whitespace in head counts', async () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await execute({
        script: `shuf -n '${whitespace}1'`,
        stdinText: 'alpha\n',
      });
      expect(execution.stdout.text).toBe('alpha\n');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      const execution = await execute({
        script: `shuf -n '${operand}'`,
        stdinText: 'alpha\n',
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid count');
      expect(execution.result.exitCode).toBe(1);
    }
  });


  it('accepts explicit positive signs and arbitrarily large head counts', async () => {
    for (const operand of ['+1', '18446744073709551616']) {
      const execution = await execute({
        script: `shuf -n '${operand}'`,
        stdinText: 'alpha\n',
      });
      expect(execution.stdout.text).toBe('alpha\n');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('validates fatal range and output semantics before a later --help', async () => {
    const invalidRange = await execute({ script: 'shuf -i bad --help' });
    const reversedRange = await execute({ script: 'shuf -i 5-1 --help' });
    const multipleOutputs = await execute({ script: 'shuf -o a -o b --help' });
    const helpFirst = await execute({ script: 'shuf --help -i bad' });
    const modeConflict = await execute({ script: 'shuf -e -i 1-2 --help' });

    for (const execution of [invalidRange, reversedRange, multipleOutputs]) {
      expect(execution.result.exitCode).toBe(1);
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).not.toBe('');
    }

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(modeConflict.result.exitCode).toBe(0);
    expect(modeConflict.stdout.text).not.toBe('');
    expect(modeConflict.stderr.text).toBe('');
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'shuf --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'shuf --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
