import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { TEST_ONLY as ECHO_TEST_ONLY } from '@/features/wesh/commands/echo';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh echo', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script }: { script: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('supports -n, -e, -E, and bundled options', async () => {
    const result = await execute({
      script: `\
echo -n alpha
echo -e 'a\\tb\\n'
echo -E 'a\\tb'
echo -ne 'x\\ty'
`,
    });

    expect(result.stdout.text).toBe('alphaa\tb\n\na\\tb\nx\ty');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports GNU octal, hexadecimal, and stop-output escapes', async () => {
    const combined = await execute({ script: "echo -e '\\0101\\x42'" });
    const shortOctal = await execute({ script: "echo -e '\\101'" });
    const overflow = await execute({ script: "echo -e '\\777'" });
    const stopped = await execute({ script: "echo -e 'before\\cafter'" });

    expect(combined.stdout.text).toBe('AB\n');
    expect(combined.stderr.text).toBe('');
    expect(combined.result.exitCode).toBe(0);
    expect(shortOctal.stdout.text).toBe('A\n');
    expect(shortOctal.stderr.text).toBe('');
    expect(shortOctal.result.exitCode).toBe(0);
    expect(overflow.stdout.buffer).toEqual(new Uint8Array([0xFF, 0x0A]));
    expect(overflow.stderr.text).toBe('');
    expect(overflow.result.exitCode).toBe(0);
    expect(stopped.stdout.text).toBe('before');
    expect(stopped.stderr.text).toBe('');
    expect(stopped.result.exitCode).toBe(0);
  });

  it('leaves uppercase E as an unknown escape', async () => {
    const result = await execute({ script: String.raw`echo -e '\E'` });

    expect(result.stdout.text).toBe('\\E\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves a non-ASCII code point after an unknown escape backslash', async () => {
    const result = await execute({ script: String.raw`echo -e '\😀'` });

    expect(result.stdout.text).toBe('\\😀\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });
  it('stops option parsing at the first non-option and treats unknown options as text', async () => {
    const afterWord = await execute({ script: 'echo alpha -n' });
    const unknown = await execute({ script: 'echo -z alpha' });
    const shortHelpLookalike = await execute({ script: 'echo -h alpha' });
    const doubleDash = await execute({ script: 'echo -- -n' });
    const helpWithOperand = await execute({ script: 'echo --help alpha' });
    const noNewlineThenUnknown = await execute({ script: 'echo -n -h alpha' });

    expect(afterWord.stdout.text).toBe('alpha -n\n');
    expect(afterWord.stderr.text).toBe('');
    expect(afterWord.result.exitCode).toBe(0);
    expect(unknown.stdout.text).toBe('-z alpha\n');
    expect(unknown.stderr.text).toBe('');
    expect(unknown.result.exitCode).toBe(0);
    expect(shortHelpLookalike.stdout.text).toBe('-h alpha\n');
    expect(shortHelpLookalike.stderr.text).toBe('');
    expect(shortHelpLookalike.result.exitCode).toBe(0);
    expect(doubleDash.stdout.text).toBe('-- -n\n');
    expect(doubleDash.stderr.text).toBe('');
    expect(doubleDash.result.exitCode).toBe(0);
    expect(helpWithOperand.stdout.text).toBe('--help alpha\n');
    expect(helpWithOperand.stderr.text).toBe('');
    expect(helpWithOperand.result.exitCode).toBe(0);
    expect(noNewlineThenUnknown.stdout.text).toBe('-h alpha');
    expect(noNewlineThenUnknown.stderr.text).toBe('');
    expect(noNewlineThenUnknown.result.exitCode).toBe(0);
  });

  it('stops escaped output before later arguments while preserving argument separators', async () => {
    const stoppedInSecond = await execute({
      script: String.raw`echo -e first 'before\cafter' ignored`,
    });
    const escapedBackslash = await execute({
      script: String.raw`echo -e '\\c' tail`,
    });
    const tripleBackslash = await execute({
      script: String.raw`echo -e '\\\c' tail`,
    });

    expect(stoppedInSecond.stdout.text).toBe('first before');
    expect(stoppedInSecond.stderr.text).toBe('');
    expect(stoppedInSecond.result.exitCode).toBe(0);
    expect(escapedBackslash.stdout.text).toBe('\\c tail\n');
    expect(escapedBackslash.stderr.text).toBe('');
    expect(escapedBackslash.result.exitCode).toBe(0);
    expect(tripleBackslash.stdout.text).toBe('\\');
    expect(tripleBackslash.stderr.text).toBe('');
    expect(tripleBackslash.result.exitCode).toBe(0);
  });

  it('preserves plain-text output through escape-enabled fast paths', async () => {
    const ordinary = await execute({
      script: `\
echo -e plain
echo -ne compact
echo -e alpha beta gamma
echo -e 'a\\tb' tail
`,
    });
    const posix = await execute({
      script: `\
export POSIXLY_CORRECT=
echo plain
echo -n compact
`,
    });

    expect(ordinary.stdout.text).toBe(`\
plain
compactalpha beta gamma
a\tb tail
`);
    expect(ordinary.stderr.text).toBe('');
    expect(ordinary.result.exitCode).toBe(0);
    expect(posix.stdout.text).toBe(`\
plain
compact`);
    expect(posix.stderr.text).toBe('');
    expect(posix.result.exitCode).toBe(0);
  });

  it('does not read from stdin', async () => {
    const stdin = createTestReadHandleFromText({ text: 'unread' });
    const read = vi.spyOn(stdin, 'read').mockRejectedValue(new Error('echo must not read stdin'));
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: 'echo hello' }),
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('hello\n');
    expect(stderr.text).toBe('');
    expect(read).not.toHaveBeenCalled();
  });

  it('handles empty output paths without changing newline semantics', async () => {
    const ordinary = await execute({
      script: `\
echo
echo -n
printf '|'
echo -e
echo -ne
printf '|'
`,
    });
    const posix = await execute({
      script: `\
export POSIXLY_CORRECT=
echo
echo -n
printf '|'
echo -e
`,
    });

    expect(ordinary.stdout.text).toBe(`\

|
|`);
    expect(ordinary.stderr.text).toBe('');
    expect(ordinary.result.exitCode).toBe(0);
    expect(posix.stdout.text).toBe(`\

|-e
`);
    expect(posix.stderr.text).toBe('');
    expect(posix.result.exitCode).toBe(0);
  });

  it('honors POSIXLY_CORRECT presence for option recognition and escape defaults', async () => {
    const result = await execute({
      script: String.raw`export POSIXLY_CORRECT=
echo 'a\tb'
echo -e 'a\tb'
echo -n -E 'x\ty'
printf '|'
echo -ne 'a\tb'
echo --help
`,
    });

    expect(result.stdout.text).toBe('a\tb\n-e a\tb\nx\ty|-ne a\tb\n--help\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps the stop-output pre-scan equivalent to escape interpretation', () => {
    const fragments = [
      'a', 'c', 'x', '0', '7', '😀',
      String.raw`\a`, String.raw`\b`, String.raw`\c`, String.raw`\e`,
      String.raw`\n`, String.raw`\t`, String.raw`\\`, String.raw`\x`,
      String.raw`\x41`, String.raw`\0`, String.raw`\0101`, String.raw`\777`,
      String.raw`\q`,
    ] as const;
    let state = 0xEC40_1761;
    const next = (): number => {
      let value = state >>> 0;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      state = value >>> 0;
      return state;
    };

    for (let caseIndex = 0; caseIndex < 5_000; caseIndex += 1) {
      const fragmentCount = 1 + (next() % 10);
      let value = '';
      for (let index = 0; index < fragmentCount; index += 1) {
        value += fragments[next() % fragments.length]!;
      }

      const scan = ECHO_TEST_ONLY.scanEchoArgumentEscapes({ value });
      const interpreted = ECHO_TEST_ONLY.interpretEscapes({ value });
      expect(typeof scan === 'number').toBe(interpreted.suppressNewline);

      if (typeof scan === 'number') {
        const reachablePrefix = value.slice(0, scan + 2);
        const prefixResult = ECHO_TEST_ONLY.interpretEscapes({ value: reachablePrefix });
        expect(prefixResult.suppressNewline).toBe(true);
        expect(prefixResult.output).toEqual(interpreted.output);
      }
    }
  });

});
