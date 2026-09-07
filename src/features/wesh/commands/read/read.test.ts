import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh read', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText = '',
    stdinBytes,
  }: {
    script: string,
    stdinText?: string,
    stdinBytes?: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdinBytes === undefined
        ? createTestReadHandleFromText({ text: stdinText })
        : createTestReadHandleFromBytes({ bytes: stdinBytes }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports bad file descriptors', async () => {
    const help = await execute({
      script: 'read --help',
      stdinText: '',
    });
    const badFd = await execute({
      script: `\
read -u 9 value
status=$?
echo "$status"`,
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Read a line from standard input or a file descriptor into shell variables');
    expect(help.stdout.text).toContain('usage: read [-r] [-d delim] [-n nchars] [-N nchars] [-s] [-p prompt] [-u fd] [name...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(badFd.stderr.text).toContain('read: 9: bad file descriptor');
    expect(badFd.stdout.text).toBe('1\n');
    expect(badFd.result.exitCode).toBe(0);
  });

  it('suppresses -p prompts and treats -s as a no-op for non-character input', async () => {
    const prompted = await execute({
      script: `\
read -p "Name: " value
echo "$value"`,
      stdinText: 'alice\n',
    });
    const silent = await execute({
      script: 'read -s secret',
      stdinText: 'value\n',
    });

    expect(prompted.stdout.text).toBe('alice\n');
    expect(prompted.stderr.text).toBe('');
    expect(prompted.result.exitCode).toBe(0);

    expect(silent.stdout.text).toBe('');
    expect(silent.stderr.text).toBe('');
    expect(silent.result.exitCode).toBe(0);
  });

  it('assigns REPLY verbatim when no variable names are given', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
read
echo "$REPLY"`,
      stdinText: '  keep  spacing  \n',
    });

    expect(stdout.text).toBe('  keep  spacing  \n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('splits fields across multiple names and leaves the remainder in the last one', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
read first second third
echo "$first|$second|$third"`,
      stdinText: 'alpha beta gamma delta\n',
    });

    expect(stdout.text).toBe('alpha|beta|gamma delta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('respects IFS and raw mode', async () => {
    const ifsResult = await execute({
      script: `\
IFS=, read first second
echo "$first|$second"`,
      stdinText: 'left,right,value\n',
    });
    const rawResult = await execute({
      script: `\
read -r value
echo "$value"`,
      stdinText: 'a\\ b\n',
    });

    expect(ifsResult.stdout.text).toBe('left|right,value\n');
    expect(ifsResult.stderr.text).toBe('');
    expect(ifsResult.result.exitCode).toBe(0);

    expect(rawResult.stdout.text).toBe('a\\ b\n');
    expect(rawResult.stderr.text).toBe('');
    expect(rawResult.result.exitCode).toBe(0);
  });

  it('preserves empty fields for non-whitespace IFS delimiters', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
IFS=, read first second third
echo "$first|$second|$third"`,
      stdinText: ',,tail\n',
    });

    expect(stdout.text).toBe('||tail\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles mixed whitespace and non-whitespace IFS delimiters', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
IFS=" ," read first second third
echo "$first|$second|$third"`,
      stdinText: '  alpha, beta,,gamma delta\n',
    });

    expect(stdout.text).toBe('alpha|beta|,gamma delta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('joins escaped characters by default and continues on backslash-newline', async () => {
    const escapedSpace = await execute({
      script: `\
read value
echo "$value"`,
      stdinText: 'a\\ b\n',
    });
    const continuedLine = await execute({
      script: `\
read value
echo "$value"`,
      stdinText: `\
hello\\
world
`,
    });

    expect(escapedSpace.stdout.text).toBe('a b\n');
    expect(escapedSpace.stderr.text).toBe('');
    expect(escapedSpace.result.exitCode).toBe(0);

    expect(continuedLine.stdout.text).toBe('helloworld\n');
    expect(continuedLine.stderr.text).toBe('');
    expect(continuedLine.result.exitCode).toBe(0);
  });

  it('returns failure on EOF while still assigning the partial line', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
read value
echo "$?"
echo "$value"`,
      stdinText: 'partial-without-newline',
    });

    expect(stdout.text).toBe(`\
1
partial-without-newline
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats empty IFS as no splitting', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
IFS= read first second
echo "$first|$second"`,
      stdinText: 'alpha beta gamma\n',
    });

    expect(stdout.text).toBe('alpha beta gamma|\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('trims trailing IFS whitespace from a single destination variable', async () => {
    const { result, stdout, stderr } = await execute({
      script: `read value
printf '<%s>\n' "$value"`,
      stdinText: '  alpha beta  \n',
    });

    expect(stdout.text).toBe('<alpha beta>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid destination variable names after consuming the input record', async () => {
    const { result, stdout, stderr } = await execute({
      script: `read bad-name
first_status=$?
read value
printf '<%s>|%s|%s\n' "$value" "$first_status" "$?"`,
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe('<beta>|1|0\n');
    expect(stderr.text).toBe("read: `bad-name': not a valid identifier\n");
    expect(result.exitCode).toBe(0);
  });

  it('does not print a read prompt when input is not a character device', async () => {
    const { result, stdout, stderr } = await execute({
      script: `read -p 'prompt>' value
printf '<%s>\n' "$value"`,
      stdinText: 'alpha\n',
    });

    expect(stdout.text).toBe('<alpha>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });



  it('decodes successive UTF-8 records without corrupting multi-byte characters', async () => {
    const { result, stdout, stderr } = await execute({
      script: `IFS= read -r first
IFS= read -r second
printf '<%s>|<%s>|%s\n' "$first" "$second" "$?"`,
      stdinText: `\
café
東京
`,
    });

    expect(stdout.text).toBe('<café>|<東京>|0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves malformed and incomplete UTF-8 bytes in assigned values', async () => {
    const malformed = await execute({
      script: `IFS= read -r value
printf '<%s>\n' "$value"`,
      stdinBytes: Uint8Array.of(0xff, 0x0a),
    });
    const incomplete = await execute({
      script: `IFS= read -r value
printf '<%s>\n' "$value"`,
      stdinBytes: Uint8Array.of(0xe2, 0x82, 0x0a),
    });
    const incompleteCLocale = await execute({
      script: `export LC_ALL=C
IFS= read -r value
printf '<%s>\n' "$value"`,
      stdinBytes: Uint8Array.of(0xe2, 0x82, 0x0a),
    });

    const quotedMalformed = await execute({
      script: `IFS= read -r value
printf '<%q>\n' "$value"`,
      stdinBytes: Uint8Array.of(0xff, 0x0a),
    });

    expect([...malformed.stdout.buffer]).toEqual([0x3c, 0xff, 0x3e, 0x0a]);
    expect([...incomplete.stdout.buffer]).toEqual([0x3c, 0xe2, 0x82, 0x0a, 0x3e, 0x0a]);
    expect([...incompleteCLocale.stdout.buffer]).toEqual([0x3c, 0xe2, 0x82, 0x3e, 0x0a]);
    expect(quotedMalformed.stdout.text).toBe(`<${String.raw`$'\377'`}>\n`);
    expect(malformed.stderr.text).toBe('');
    expect(incomplete.stderr.text).toBe('');
    expect(incompleteCLocale.stderr.text).toBe('');
    expect(quotedMalformed.stderr.text).toBe('');
    expect(malformed.result.exitCode).toBe(0);
    expect(incomplete.result.exitCode).toBe(0);
    expect(incompleteCLocale.result.exitCode).toBe(0);
    expect(quotedMalformed.result.exitCode).toBe(0);
  });

  it('supports attached file descriptor and bundled raw delimiter options', async () => {
    const attachedFd = await execute({
      script: `IFS= read -r -u0 value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: 'alpha\n',
    });
    const bundledDelimiter = await execute({
      script: `IFS= read -rd: value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: 'alpha:omega',
    });

    expect(attachedFd.stdout.text).toBe('<alpha>|0\n');
    expect(attachedFd.stderr.text).toBe('');
    expect(attachedFd.result.exitCode).toBe(0);

    expect(bundledDelimiter.stdout.text).toBe('<alpha>|0\n');
    expect(bundledDelimiter.stderr.text).toBe('');
    expect(bundledDelimiter.result.exitCode).toBe(0);
  });

  it('matches Bash prompt attachment and stops option parsing at the first variable name', async () => {
    const attachedPrompt = await execute({
      script: `IFS= read -pprompt value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: 'alpha\n',
    });
    const optionLookingName = await execute({
      script: `IFS= read value -r
status=$?
printf '<%s>|%s\n' "$value" "$status"`,
      stdinText: 'alpha\n',
    });

    expect(attachedPrompt.stdout.text).toBe('<alpha>|0\n');
    expect(attachedPrompt.stderr.text).toBe('');
    expect(attachedPrompt.result.exitCode).toBe(0);

    expect(optionLookingName.stdout.text).toBe('<alpha>|1\n');
    expect(optionLookingName.stderr.text).toContain('not a valid identifier');
    expect(optionLookingName.result.exitCode).toBe(0);
  });

  it('supports custom and NUL delimiters with read -d', async () => {
    const custom = await execute({
      script: `read -r -d : value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: 'alpha:beta',
    });
    const nul = await execute({
      script: `read -r -d '' value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: 'alpha\0beta',
    });
    const missing = await execute({
      script: `read -r -d : value
status=$?
printf '<%s>|%s\n' "$value" "$status"`,
      stdinText: 'alpha',
    });

    expect(custom.stdout.text).toBe('<alpha>|0\n');
    expect(custom.stderr.text).toBe('');
    expect(custom.result.exitCode).toBe(0);

    expect(nul.stdout.text).toBe('<alpha>|0\n');
    expect(nul.stderr.text).toBe('');
    expect(nul.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('<alpha>|1\n');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(0);
  });

  it('supports maximum and exact character counts', async () => {
    const maximum = await execute({
      script: `IFS= read -n 3 value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: 'abcdef',
    });
    const exact = await execute({
      script: `IFS= read -N 5 value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: `\
abc
def`,
    });

    expect(maximum.stdout.text).toBe('<abc>|0\n');
    expect(maximum.stderr.text).toBe('');
    expect(maximum.result.exitCode).toBe(0);

    expect(exact.stdout.text).toBe(`\
<abc
d>|0
`);
    expect(exact.stderr.text).toBe('');
    expect(exact.result.exitCode).toBe(0);
  });

  it('keeps exact mode after -N while later -n updates the count', async () => {
    const exactLast = await execute({
      script: `IFS= read -n 2 -N 4 value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: `\
a
bcd`,
    });
    const maximumLast = await execute({
      script: `IFS= read -N 4 -n 2 value
printf '<%s>|%s\n' "$value" "$?"`,
      stdinText: `\
a
bcd`,
    });

    expect(exactLast.stdout.text).toBe(`\
<a
bc>|0
`);
    expect(exactLast.stderr.text).toBe('');
    expect(exactLast.result.exitCode).toBe(0);

    expect(maximumLast.stdout.text).toBe(`\
<a
>|0
`);
    expect(maximumLast.stderr.text).toBe('');
    expect(maximumLast.result.exitCode).toBe(0);
  });

  it('assigns partial values on EOF and lets zero counts avoid consuming input', async () => {
    const partial = await execute({
      script: `IFS= read -N 5 value
status=$?
printf '<%s>|%s\n' "$value" "$status"`,
      stdinText: 'abc',
    });
    const nonConsuming = await execute({
      script: `IFS= read -n0 first
IFS= read second
printf '<%s>|<%s>|%s\n' "$first" "$second" "$?"`,
      stdinText: 'next\n',
    });

    expect(partial.stdout.text).toBe('<abc>|1\n');
    expect(partial.stderr.text).toBe('');
    expect(partial.result.exitCode).toBe(0);

    expect(nonConsuming.stdout.text).toBe('<>|<next>|0\n');
    expect(nonConsuming.stderr.text).toBe('');
    expect(nonConsuming.result.exitCode).toBe(0);
  });

  it('counts decoded Unicode code points without splitting UTF-8 input', async () => {
    const { result, stdout, stderr } = await execute({
      script: `IFS= read -n 2 first
IFS= read -n 1 second
printf '<%s>|<%s>|%s\n' "$first" "$second" "$?"`,
      stdinText: '東京x',
    });

    expect(stdout.text).toBe('<東京>|<x>|0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves UTF-8 byte-order marks across successive reads', async () => {
    const leading = await execute({
      script: `IFS= read -n 1 first
IFS= read second
printf '<%s>|<%s>|%s\n' "$first" "$second" "$?"`,
      stdinText: '\uFEFFalpha\n',
    });
    const secondLine = await execute({
      script: `IFS= read first
IFS= read second
printf '<%s>|<%s>|%s\n' "$first" "$second" "$?"`,
      stdinText: `\
alpha
\uFEFFbeta
`,
    });

    expect(leading.stdout.text).toBe('<\uFEFF>|<alpha>|0\n');
    expect(leading.stderr.text).toBe('');
    expect(leading.result.exitCode).toBe(0);
    expect(secondLine.stdout.text).toBe('<alpha>|<\uFEFFbeta>|0\n');
    expect(secondLine.stderr.text).toBe('');
    expect(secondLine.result.exitCode).toBe(0);
  });

  it('validates character counts before consuming input', async () => {
    const { result, stdout, stderr } = await execute({
      script: `read -n nope first
first_status=$?
read second
printf '<%s>|<%s>|%s\n' "$first" "$second" "$first_status"`,
      stdinText: 'next\n',
    });

    expect(stdout.text).toBe('<>|<next>|1\n');
    expect(stderr.text).toContain('read: nope: invalid number');
    expect(result.exitCode).toBe(0);
  });


  it('accepts Bash-compatible ASCII whitespace in count and fd operands', async () => {
    const accepted = [
      ...[' ', '\t', '\n', '\v', '\f', '\r'].map((whitespace) => `${whitespace}1`),
      '1 ',
      '1\t',
    ];
    for (const operand of accepted) {
      const maximum = await execute({
        script: `IFS= read -n '${operand}' value
printf '<%s>|%s\n' "$value" "$?"`,
        stdinText: 'abc',
      });
      expect(maximum.stdout.text).toBe('<a>|0\n');
      expect(maximum.stderr.text).toBe('');
      expect(maximum.result.exitCode).toBe(0);

      const descriptorOperand = operand.replace('1', '0');
      const descriptor = await execute({
        script: `IFS= read -u '${descriptorOperand}' value
printf '<%s>|%s\n' "$value" "$?"`,
        stdinText: 'abc\n',
      });
      expect(descriptor.stdout.text).toBe('<abc>|0\n');
      expect(descriptor.stderr.text).toBe('');
      expect(descriptor.result.exitCode).toBe(0);
    }
  });

  it('rejects nonblank trailing C whitespace in count and fd operands', async () => {
    for (const whitespace of ['\n', '\v', '\f', '\r']) {
      const count = await execute({
        script: `read -n '1${whitespace}' value`,
        stdinText: 'abc',
      });
      expect(count.stdout.text).toBe('');
      expect(count.stderr.text).toContain('invalid number');
      expect(count.result.exitCode).toBe(1);

      const descriptor = await execute({
        script: `read -u '0${whitespace}' value`,
        stdinText: 'abc\n',
      });
      expect(descriptor.stdout.text).toBe('');
      expect(descriptor.stderr.text).toContain('invalid file descriptor');
      expect(descriptor.result.exitCode).toBe(1);
    }
  });

  it('rejects Unicode whitespace in count and fd operands', async () => {
    for (const whitespace of ['\u00a0', '\u2003', '\ufeff']) {
      const count = await execute({
        script: `read -n '${whitespace}1' value`,
        stdinText: 'abc',
      });
      expect(count.stdout.text).toBe('');
      expect(count.stderr.text).toContain('invalid number');
      expect(count.result.exitCode).toBe(1);

      const descriptor = await execute({
        script: `read -u '${whitespace}0' value`,
        stdinText: 'abc\n',
      });
      expect(descriptor.stdout.text).toBe('');
      expect(descriptor.stderr.text).toContain('invalid file descriptor');
      expect(descriptor.result.exitCode).toBe(1);
    }
  });

});
