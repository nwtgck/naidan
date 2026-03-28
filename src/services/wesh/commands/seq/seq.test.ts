import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/services/wesh/utils/test-stream';

describe('seq command', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help output', async () => {
    const { result, stdout, stderr } = await execute({ script: 'seq --help' });

    expect(stdout.text).toContain('Print a sequence of numbers');
    expect(stdout.text).toContain('usage: seq [OPTION]... LAST');
    expect(stdout.text).toContain('--equal-width');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports basic sequences, custom separators, equal width, and increments', async () => {
    const one = await execute({ script: 'seq 3' });
    const two = await execute({ script: 'seq 2 5' });
    const three = await execute({ script: 'seq 5 -2 1' });
    const sep = await execute({ script: "seq -s ',' 1 3" });
    const width = await execute({ script: 'seq -w 8 10' });
    const format = await execute({ script: "seq -f '%.2f' 1 2" });

    expect(one.stdout.text).toBe(`\
1
2
3
`);
    expect(two.stdout.text).toBe(`\
2
3
4
5
`);
    expect(three.stdout.text).toBe(`\
5
3
1
`);
    expect(sep.stdout.text).toBe('1,2,3');
    expect(width.stdout.text).toBe(`\
08
09
10
`);
    expect(format.stdout.text).toBe(`\
1.00
2.00
`);

    expect(one.stderr.text).toBe('');
    expect(two.stderr.text).toBe('');
    expect(three.stderr.text).toBe('');
    expect(sep.stderr.text).toBe('');
    expect(width.stderr.text).toBe('');
    expect(format.stderr.text).toBe('');
    expect(one.result.exitCode).toBe(0);
    expect(two.result.exitCode).toBe(0);
    expect(three.result.exitCode).toBe(0);
    expect(sep.result.exitCode).toBe(0);
    expect(width.result.exitCode).toBe(0);
    expect(format.result.exitCode).toBe(0);
  });

  it('rejects invalid increments, missing operands, and invalid options', async () => {
    const zero = await execute({ script: 'seq 1 0 3' });
    const missing = await execute({ script: 'seq' });
    const invalid = await execute({ script: 'seq -x 1 2' });
    const invalidLong = await execute({ script: 'seq --bogus 1 2' });

    expect(zero.stdout.text).toBe('');
    expect(zero.stderr.text).toContain('seq: invalid zero increment');
    expect(zero.stderr.text).toContain('usage: seq');
    expect(zero.result.exitCode).toBe(1);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('seq: missing operand');
    expect(missing.stderr.text).toContain('usage: seq');
    expect(missing.result.exitCode).toBe(1);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("seq: invalid option -- 'x'");
    expect(invalid.stderr.text).toContain('usage: seq');
    expect(invalid.result.exitCode).toBe(1);

    expect(invalidLong.stdout.text).toBe('');
    expect(invalidLong.stderr.text).toContain("seq: unrecognized option '--bogus'");
    expect(invalidLong.stderr.text).toContain('usage: seq');
    expect(invalidLong.result.exitCode).toBe(1);
  });

  it('treats attached values only as values for known options', async () => {
    const format = await execute({ script: "seq -f%.1f 1 2" });
    const separator = await execute({ script: "seq -s, 1 3" });

    expect(format.stdout.text).toBe(`\
1.0
2.0
`);
    expect(format.stderr.text).toBe('');
    expect(format.result.exitCode).toBe(0);

    expect(separator.stdout.text).toBe('1,2,3');
    expect(separator.stderr.text).toBe('');
    expect(separator.result.exitCode).toBe(0);
  });
});
