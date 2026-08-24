import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh history', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string,
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

  it('prints help and reports invalid options', async () => {
    const help = await execute({ script: 'history --help' });
    expect(help.stdout.text).toContain('Display the command history list');
    expect(help.stdout.text).toContain('usage: history');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'history --bogus' });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('history: unrecognized option');
    expect(invalid.stderr.text).toContain('usage: history');
    expect(invalid.stderr.text).toContain('--help');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('keeps history output stable', async () => {
    await execute({ script: 'echo one' });
    await execute({ script: 'echo two' });

    const { result, stdout, stderr } = await execute({ script: 'history' });

    expect(stdout.text).toContain('echo one');
    expect(stdout.text).toContain('echo two');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('limits output to the requested signed count while preserving history numbers', async () => {
    await execute({ script: 'echo one' });
    await execute({ script: 'echo two' });

    const limited = await execute({ script: 'history 2' });
    expect(limited.stdout.text).toBe(`\
    2  echo two
    3  history 2
`);
    expect(limited.stderr.text).toBe('');
    expect(limited.result.exitCode).toBe(0);

    const zero = await execute({ script: 'history 0' });
    expect(zero.stdout.text).toBe('');
    expect(zero.stderr.text).toBe('');
    expect(zero.result.exitCode).toBe(0);

    const negativeAfterOptions = await execute({ script: 'history -- -2' });
    expect(negativeAfterOptions.stdout.text).toBe(`\
    4  history 0
    5  history -- -2
`);
    expect(negativeAfterOptions.stderr.text).toBe('');
    expect(negativeAfterOptions.result.exitCode).toBe(0);
  });

  it('rejects non-integer, out-of-range, and extra count operands', async () => {
    const nonInteger = await execute({ script: 'history 1.0' });
    expect(nonInteger.stdout.text).toBe('');
    expect(nonInteger.stderr.text).toBe('history: 1.0: numeric argument required\n');
    expect(nonInteger.result.exitCode).toBe(1);

    const outOfRange = await execute({ script: 'history 9223372036854775808' });
    expect(outOfRange.stdout.text).toBe('');
    expect(outOfRange.stderr.text).toBe(
      'history: 9223372036854775808: numeric argument required\n',
    );
    expect(outOfRange.result.exitCode).toBe(1);

    const veryLarge = '9'.repeat(4096);
    const veryLargeResult = await execute({ script: `history ${veryLarge}` });
    expect(veryLargeResult.stdout.text).toBe('');
    expect(veryLargeResult.stderr.text).toBe(
      `history: ${veryLarge}: numeric argument required\n`,
    );
    expect(veryLargeResult.result.exitCode).toBe(1);

    const extra = await execute({ script: 'history 1 2' });
    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toBe('history: too many arguments\n');
    expect(extra.result.exitCode).toBe(1);


    const optionLikeExtra = await execute({ script: 'history 0 --help' });
    expect(optionLikeExtra.stdout.text).toBe('');
    expect(optionLikeExtra.stderr.text).toBe('history: too many arguments\n');
    expect(optionLikeExtra.result.exitCode).toBe(1);

    const unknownOptionLikeExtra = await execute({ script: 'history 0 --bogus' });
    expect(unknownOptionLikeExtra.stdout.text).toBe('');
    expect(unknownOptionLikeExtra.stderr.text).toBe('history: too many arguments\n');
    expect(unknownOptionLikeExtra.result.exitCode).toBe(1);
  });
});
