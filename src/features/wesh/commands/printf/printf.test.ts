import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';

function shellQuote({ value }: { value: string }): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe('printf command', () => {
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

  it('prints help output', async () => {
    const { result, stdout, stderr } = await execute({ script: 'printf --help' });

    expect(stdout.text).toContain('Format and print data');
    expect(stdout.text).toContain('usage: printf [-v var] FORMAT [ARGUMENT]...');
    expect(stdout.text).toContain('--help');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('formats strings, integers, escapes, and percent signs without a trailing newline', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf '%s %d %b %%' alpha 7 'line1\\nline2'`,
    });

    expect(stdout.text).toBe(`\
alpha 7 line1
line2 %`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports signs, alignment, and zero-padded field widths', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%+d|%05d|%-5s!\n' 42 42 xy`,
    });

    expect(stdout.text).toBe('+42|00042|xy   !\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports common signed and unsigned integer bases', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%x %X %o %u\n' 255 255 8 -1`,
    });

    expect(stdout.text).toBe('ff FF 10 18446744073709551615\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports fixed, exponential, and general floating-point formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%.2f %.2e %.3g\n' 3.5 3.5 3.5`,
    });

    expect(stdout.text).toBe('3.50 3.50e+00 3.5\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches Bash interactions between integer precision and zero field padding', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '<%08.5d>|<%#08.5x>|<%08.0d>\n' 17 42 0`,
    });

    expect(stdout.text).toBe('<   00017>|< 0x0002a>|<        >\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches Bash alternate floating decimal points and non-finite field padding', async () => {
    const alternate = await execute({
      script: `printf '<%#5.0f>|<%#8.0e>|<%#6.1g>|<%#8.3G>\n' 65 1 1 12`,
    });
    const special = await execute({
      script: `printf '<%08f>|<%+08G>|<%08E>|<%f>\n' inf nan -inf -nan`,
    });

    expect(alternate.stdout.text).toBe('<  65.>|<  1.e+00>|<    1.>|<    12.0>\n');
    expect(alternate.stderr.text).toBe('');
    expect(alternate.result.exitCode).toBe(0);

    expect(special.stdout.text).toBe('<     inf>|<    +NAN>|<    -INF>|<-nan>\n');
    expect(special.stderr.text).toBe('');
    expect(special.result.exitCode).toBe(0);
  });

  it('accepts leading C-locale whitespace for numeric conversions', async () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const value = `${whitespace}7`;
      const { result, stdout, stderr } = await execute({
        script: `env LC_ALL=C printf '%d|%.1f\\n' ${shellQuote({ value })} ${shellQuote({ value })}`,
      });

      expect(stdout.text).toBe('7|7.0\n');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });

  it('prints converted prefixes and reports incomplete numeric arguments', async () => {
    const integer = await execute({
      script: `printf '%d|%d|%d\\n' 7.9 1e2 7x`,
    });
    const floating = await execute({
      script: `printf '%.1f\\n' 7x`,
    });

    expect(integer.stdout.text).toBe('7|1|7\n');
    expect(integer.stderr.text.match(/value not completely converted/gu)).toHaveLength(3);
    expect(integer.result.exitCode).toBe(1);

    expect(floating.stdout.text).toBe('7.0\n');
    expect(floating.stderr.text).toContain('value not completely converted');
    expect(floating.result.exitCode).toBe(1);
  });

  it('does not treat Unicode whitespace as numeric whitespace', async () => {
    for (const whitespace of ['\u00a0', '\u2003', '\ufeff']) {
      const value = `${whitespace}7`;
      const { result, stdout, stderr } = await execute({
        script: `env LC_ALL=C printf '%d|%.1f\\n' ${shellQuote({ value })} ${shellQuote({ value })}`,
      });

      expect(stdout.text).toBe('0|0.0\n');
      expect(stderr.text.match(/expected a numeric value/gu)).toHaveLength(2);
      expect(result.exitCode).toBe(1);
    }
  });

  it('uses locale-aware character constants for numeric conversions', async () => {
    const ascii = await execute({
      script: `env LC_ALL=C printf '%d|%.1f\\n' "'😀" "'é"`,
    });
    const unicode = await execute({
      script: `env LC_ALL=C.utf8 printf '%d|%.1f\\n' "'😀" "'é"`,
    });

    expect(ascii.stdout.text).toBe('240|195.0\n');
    expect(ascii.stderr.text.match(/following character constant/gu)).toHaveLength(2);
    expect(ascii.result.exitCode).toBe(0);

    expect(unicode.stdout.text).toBe('128512|233.0\n');
    expect(unicode.stderr.text).toBe('');
    expect(unicode.result.exitCode).toBe(0);
  });

  it('supports hexadecimal floating values and special floating values', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%.1f|%f|%f\\n' 0x1.8p1 inf nan`,
    });

    expect(stdout.text).toBe('3.0|inf|nan\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints the first input character for %c', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%c %c\n' A 66`,
    });

    expect(stdout.text).toBe('A 6\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('measures string width and precision in output bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%5s|%.1s|%.4s' '😀' '😀' '😀'`,
    });

    expect(Array.from(stdout.buffer)).toEqual([
      0x20, 0xf0, 0x9f, 0x98, 0x80,
      0x7c, 0xf0,
      0x7c, 0xf0, 0x9f, 0x98, 0x80,
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints the first input byte for %c', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%5c|%c' '😀' 'é'`,
    });

    expect(Array.from(stdout.buffer)).toEqual([
      0x20, 0x20, 0x20, 0x20, 0xf0,
      0x7c, 0xc3,
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('writes escaped bytes without UTF-8 re-encoding', async () => {
    const conversion = await execute({
      script: String.raw`printf '%b|%.1b|%5b' "\\0377" "\\0303\\0251" "\\0303\\0251"`,
    });
    const literal = await execute({
      script: String.raw`printf "\\xFF|\\u00E9"`,
    });

    expect(Array.from(conversion.stdout.buffer)).toEqual([
      0xff, 0x7c, 0xc3, 0x7c, 0x20, 0x20, 0x20, 0xc3, 0xa9,
    ]);
    expect(conversion.stderr.text).toBe('');
    expect(conversion.result.exitCode).toBe(0);

    expect(Array.from(literal.stdout.buffer)).toEqual([0xff, 0x7c, 0xc3, 0xa9]);
    expect(literal.stderr.text).toBe('');
    expect(literal.result.exitCode).toBe(0);
  });

  it('supports GNU shell quoting with %q', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%q\n' 'alpha beta' ''`,
    });

    expect(stdout.text).toBe(['alpha\\ beta', "''", ''].join('\n'));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('quotes non-ASCII values according to the active locale', async () => {
    const ascii = await execute({
      script: `env LC_ALL=C printf '%q\n' '😀' 'é β'`,
    });
    const unicode = await execute({
      script: `env LC_ALL=C.utf8 printf '%q\n' '😀' 'é β'`,
    });

    expect(ascii.stdout.text).toBe([
      String.raw`$'\360\237\230\200'`,
      String.raw`$'\303\251 \316\262'`,
      '',
    ].join('\n'));
    expect(ascii.stderr.text).toBe('');
    expect(ascii.result.exitCode).toBe(0);

    expect(unicode.stdout.text).toBe(['😀', 'é\\ β', ''].join('\n'));
    expect(unicode.stderr.text).toBe('');
    expect(unicode.result.exitCode).toBe(0);
  });

  it('uses Bash printability rules for Unicode %q input', async () => {
    const nbsp = '\u00a0';
    const emSpace = '\u2003';
    const lineSeparator = '\u2028';
    const { result, stdout, stderr } = await execute({
      script: `env LC_ALL=C.utf8 printf '%q|%q|%q' '${nbsp}' '${emSpace}' '${lineSeparator}'`,
    });

    expect(stdout.text).toBe(`${nbsp}|${emSpace}|$'\\342\\200\\250'`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies %q width and precision to output bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `env LC_ALL=C.utf8 printf '%10q|%.3q' 'é' '😀'`,
    });

    expect(Array.from(stdout.buffer)).toEqual([
      0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0xc3, 0xa9,
      0x7c, 0xf0, 0x9f, 0x98,
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('repeats the format string over extra arguments', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf '%s-' a b c`,
    });

    expect(stdout.text).toBe('a-b-c-');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('consumes dynamic field width and precision arguments like Bash', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '<%*s>|<%.*s>|<%*.*x>|<%0*.*d>|<%.*f>\n' -5 x 2 abcd 8 4 42 8 5 17 -1 1.25`,
    });

    expect(stdout.text).toBe('<x    >|<ab>|<    002a>|<   00017>|<1.250000>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('repeats formats while consuming dynamic fields for every conversion', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '<%*.*x>' 8 4 42 6 2 15`,
    });

    expect(stdout.text).toBe('<    002a><    0f>');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports invalid and excessive dynamic fields without materializing unsafe output', async () => {
    const invalid = await execute({
      script: `printf '<%*s>|<%.*f>' bad x bad 1.25`,
    });
    expect(invalid.stdout.text).toBe('<x>|<1>');
    expect(invalid.stderr.text.match(/expected a numeric value/gu)?.length).toBe(2);
    expect(invalid.result.exitCode).toBe(1);

    const width = await execute({ script: `printf '%*s' 1000001 x` });
    expect(width.stdout.text).toBe('');
    expect(width.stderr.text).toContain('printf: field width exceeds safety limit 1000000');
    expect(width.result.exitCode).toBe(1);

    const precision = await execute({ script: `printf '%.*f' 101 1` });
    expect(precision.stdout.text).toBe('');
    expect(precision.stderr.text).toContain('printf: precision exceeds safety limit 100');
    expect(precision.result.exitCode).toBe(1);

    const extremeWidth = '9'.repeat(512);
    const extreme = await execute({ script: `printf '%*s' ${extremeWidth} x` });
    expect(extreme.stdout.text).toBe('');
    expect(extreme.stderr.text).toContain('printf: field width exceeds safety limit 1000000');
    expect(extreme.result.exitCode).toBe(1);
  });

  it('rejects field widths and floating precision beyond materialization limits', async () => {
    const width = await execute({ script: "printf '%1000001s' x" });
    expect(width.stdout.text).toBe('');
    expect(width.stderr.text).toContain('printf: field width exceeds safety limit 1000000');
    expect(width.result.exitCode).toBe(1);

    const precision = await execute({ script: "printf '%.101f' 1" });
    expect(precision.stdout.text).toBe('');
    expect(precision.stderr.text).toContain('printf: precision exceeds safety limit 100');
    expect(precision.result.exitCode).toBe(1);
  });

  it('rejects invalid formats and missing format operands with usage', async () => {
    const invalid = await execute({ script: "printf '%j' x" });
    const missing = await execute({ script: 'printf' });

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('printf: missing format character');
    expect(invalid.stderr.text).toContain('usage: printf [-v var] FORMAT [ARGUMENT]...');
    expect(invalid.result.exitCode).toBe(1);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('printf: missing format operand');
    expect(missing.stderr.text).toContain('usage: printf [-v var] FORMAT [ARGUMENT]...');
    expect(missing.result.exitCode).toBe(1);
  });
  it('uses round-to-nearest-even for halfway floating-point values', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%.1f %.1e %.2g\n' 1.25 12.5 12.5`,
    });

    expect(stdout.text).toBe('1.2 1.2e+01 12\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('assigns formatted output to a variable with -v', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf -v value '%s-%d' alpha 7
printf '<%s>|%s\n' "$value" "$?"`,
    });

    expect(stdout.text).toBe('<alpha-7>|0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('ignores zero padding for nonnumeric -v conversions', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf -v value '%05s|%05c|%05b|%05q' x y z a
printf '<%s>\n' "$value"`,
    });

    expect(stdout.text).toBe('<    x|    y|    z|    a>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('clears the target on format errors but not option errors', async () => {
    const invalidFormat = await execute({
      script: `value=outer
printf -v value '%j' x
printf '<%s>|%s\n' "$value" "$?"`,
    });
    const invalidOption = await execute({
      script: `value=outer
printf -v value -x
printf '<%s>|%s\n' "$value" "$?"`,
    });

    expect(invalidFormat.stdout.text).toBe('<>|1\n');
    expect(invalidFormat.stderr.text).toContain('missing format character');
    expect(invalidFormat.result.exitCode).toBe(0);

    expect(invalidOption.stdout.text).toBe('<outer>|2\n');
    expect(invalidOption.stderr.text).toContain('invalid option');
    expect(invalidOption.result.exitCode).toBe(0);
  });

  it('matches Bash %q escaping and applies precision after quoting', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`value=$(printf 'a\007b')
printf '<%q>|<%.3q>|<%q>\n' '~a#b!c' 'a b c' "$value"`,
    });

    expect(stdout.text).toBe([String.raw`<\~a#b\!c>|<a\ >|<$'a\ab'>`, ''].join('\n'));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts common C-style length modifiers on numeric conversions', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '<%hhd>|<%ld>|<%llu>|<%zx>|<%Lf>|<%*.*lld>\n' 7 42 255 42 1.25 8 4 17`,
    });

    expect(stdout.text).toBe('<7>|<42>|<255>|<2a>|<1.250000>|<    0017>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('escapes comment and comma syntax while preserving internal tilde', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '<%q>|<%q>|<%q>\n' '#comment' 'a,b' 'a~b'`,
    });

    expect(stdout.text).toBe([String.raw`<\#comment>|<a\,b>|<a~b>`, ''].join('\n'));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

});
