import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('set command', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    wesh = new Wesh({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
    });
    await wesh.init();
  });

  async function execute({ script }: { script: string }) {
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

  it('supports --help without advertising unsupported state mutation', async () => {
    const { result, stdout, stderr } = await execute({ script: 'set --help' });

    expect(stdout.text).toContain('usage: set\n');
    expect(stdout.text).not.toContain('pipefail');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints shell variables in sorted reusable assignment form', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
WESH_Z=last
WESH_A='alpha beta'
WESH_Q="a'b"
set | grep '^WESH_[AQZ]='`,
    });

    expect(stdout.text).toBe(`\
WESH_A='alpha beta'
WESH_Q='a'\\''b'
WESH_Z=last
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('sorts shell variable names in C byte order', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
Z=1
a=2
A=3
_x=4
aa=5
set | grep -E '^(A|Z|_x|a|aa)='`,
    });

    expect(stdout.text).toBe(`\
A=3
Z=1
_x=4
a=2
aa=5
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses ANSI-C quoting for control characters in variable values', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
WESH_NEWLINE=$(printf 'line\\nnext')
WESH_TAB=$(printf 'left\\tright')
set | grep '^WESH_'`,
    });

    expect(stdout.text).toBe(`\
WESH_NEWLINE=$'line\\nnext'
WESH_TAB=$'left\\tright'
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('quotes non-ASCII and control values according to the active locale', async () => {
    const nbsp = '\u00a0';
    const unassigned = String.fromCodePoint(0x39728);
    const ascii = await execute({
      script: `\
LC_ALL=C
WESH_E='é'
WESH_COMBINING='é'
set | grep -E '^WESH_(E|COMBINING)='`,
    });
    const unicode = await execute({
      script: `\
LC_ALL=C.utf8
unset WESH_COMBINING
WESH_E='é'
WESH_NBSP=$(printf '\\u00a0')
WESH_C1=$(printf '\\u0085')
WESH_LINE=$(printf '\\u2028')
WESH_UNASSIGNED='${unassigned}'
set | grep '^WESH_'`,
    });

    expect(ascii.stdout.text).toBe([
      String.raw`WESH_COMBINING=$'e\314\201'`,
      String.raw`WESH_E=$'\303\251'`,
      '',
    ].join('\n'));
    expect(ascii.stderr.text).toBe('');
    expect(ascii.result.exitCode).toBe(0);

    expect(unicode.stdout.text).toBe([
      String.raw`WESH_C1=$'\302\205'`,
      'WESH_E=é',
      String.raw`WESH_LINE=$'\342\200\250'`,
      `WESH_NBSP=${nbsp}`,
      String.raw`WESH_UNASSIGNED=$'\360\271\234\250'`,
      '',
    ].join('\n'));
    expect(unicode.stderr.text).toBe('');
    expect(unicode.result.exitCode).toBe(0);
  });

});
