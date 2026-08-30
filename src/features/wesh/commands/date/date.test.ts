import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh date', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T01:02:03Z'));
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
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

  it('prints help and reports extra operands with usage', async () => {
    const help = await execute({ script: 'date --help' });
    const extra = await execute({ script: 'date +%F unexpected' });

    expect(help.stdout.text).toContain('Print the system date and time');
    expect(help.stdout.text).toContain('usage: date [-u] [-d STRING] [-I[TIMESPEC]] [--rfc-3339=TIMESPEC] [+FORMAT]');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain("date: extra operand 'unexpected'");
    expect(extra.stderr.text).toContain('usage: date');
    expect(extra.result.exitCode).toBe(1);
  });

  it('rejects a lone non-format positional operand instead of ignoring it', async () => {
    for (const script of [
      'date -',
      'date foo',
      'date -- --help',
      'date @0',
      'date -u foo',
    ]) {
      const { result, stdout, stderr } = await execute({ script });
      expect(stdout.text).toBe('');
      expect(stderr.text).toContain('date: invalid date');
      expect(result.exitCode).toBe(1);
    }
  });

  it('supports +FORMAT tokens', async () => {
    const now = new Date();
    const localExpected = [
      now.getFullYear().toString().padStart(4, '0'),
      (now.getMonth() + 1).toString().padStart(2, '0'),
      now.getDate().toString().padStart(2, '0'),
    ].join('-') + '_' + [
      now.getHours().toString().padStart(2, '0'),
      now.getMinutes().toString().padStart(2, '0'),
      now.getSeconds().toString().padStart(2, '0'),
    ].join(':') + `_${Math.floor(now.getTime() / 1000)}_%`;

    const { result, stdout, stderr } = await execute({
      script: 'date +%F_%T_%s_%%',
    });

    expect(stdout.text).toBe(`${localExpected}\n`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports weekday, month, day, and timezone tokens', async () => {
    const now = new Date();
    const localOffsetMinutes = -now.getTimezoneOffset();
    const localOffsetSign = localOffsetMinutes >= 0 ? '+' : '-';
    const localOffsetHours = Math.floor(Math.abs(localOffsetMinutes) / 60).toString().padStart(2, '0');
    const localOffsetRemainder = (Math.abs(localOffsetMinutes) % 60).toString().padStart(2, '0');

    const local = await execute({
      script: 'date +%a_%b_%e_%z',
    });
    const utc = await execute({
      script: 'date -u +%a_%b_%e_%z_%Z',
    });

    expect(local.stdout.text).toBe(`Fri_Mar_20_${localOffsetSign}${localOffsetHours}${localOffsetRemainder}\n`);
    expect(local.stderr.text).toBe('');
    expect(local.result.exitCode).toBe(0);

    expect(utc.stdout.text).toBe('Fri_Mar_20_+0000_UTC\n');
    expect(utc.stderr.text).toBe('');
    expect(utc.result.exitCode).toBe(0);
  });

  it('uses TZ for common IANA time zones', async () => {
    const tokyo = await execute({
      script: "TZ=Asia/Tokyo date '+%F %T %z'",
    });
    const newYork = await execute({
      script: "TZ=America/New_York date '+%F %T %z'",
    });
    const utcOverride = await execute({
      script: "TZ=Asia/Tokyo date -u '+%F %T %z'",
    });

    expect(tokyo.stdout.text).toBe('2026-03-20 10:02:03 +0900\n');
    expect(tokyo.stderr.text).toBe('');
    expect(tokyo.result.exitCode).toBe(0);

    expect(newYork.stdout.text).toBe('2026-03-19 21:02:03 -0400\n');
    expect(newYork.stderr.text).toBe('');
    expect(newYork.result.exitCode).toBe(0);

    expect(utcOverride.stdout.text).toBe('2026-03-20 01:02:03 +0000\n');
    expect(utcOverride.stderr.text).toBe('');
    expect(utcOverride.result.exitCode).toBe(0);
  });

  it('uses the GNU-style default output layout', async () => {
    const result = await execute({
      script: 'TZ=UTC date',
    });

    expect(result.stdout.text).toBe('Fri Mar 20 01:02:03 UTC 2026\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports -u with formatted output', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'date -u +%Y-%m-%dT%H:%M:%S',
    });

    expect(stdout.text).toBe('2026-03-20T01:02:03\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --utc as a long option alias', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'date --utc +%Y-%m-%dT%H:%M:%S',
    });

    expect(stdout.text).toBe('2026-03-20T01:02:03\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('formats RFC 3339 seconds in UTC', async () => {
    vi.setSystemTime(new Date('2026-03-20T01:02:03.456Z'));

    const { result, stdout, stderr } = await execute({ script: 'date -u --rfc-3339=seconds' });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('2026-03-20 01:02:03+00:00\n');
    expect(stderr.text).toBe('');
  });

  it('formats ISO 8601 output with the default date precision', async () => {
    vi.setSystemTime(new Date('2026-03-20T01:02:03.456Z'));

    const { result, stdout, stderr } = await execute({ script: 'date -u -I' });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('2026-03-20\n');
    expect(stderr.text).toBe('');
  });

  it('formats ISO 8601 seconds in UTC', async () => {
    vi.setSystemTime(new Date('2026-03-20T01:02:03.456Z'));

    const { result, stdout, stderr } = await execute({ script: 'date -u -Iseconds' });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('2026-03-20T01:02:03+00:00\n');
    expect(stderr.text).toBe('');
  });

  it('supports ISO 8601 optional values after bundled short flags', async () => {
    vi.setSystemTime(new Date('2026-03-20T01:02:03.456Z'));

    const datePrecision = await execute({ script: 'date -uI' });
    const secondsPrecision = await execute({ script: 'date -uIseconds' });

    expect(datePrecision.stdout.text).toBe('2026-03-20\n');
    expect(datePrecision.stderr.text).toBe('');
    expect(datePrecision.result.exitCode).toBe(0);

    expect(secondsPrecision.stdout.text).toBe('2026-03-20T01:02:03+00:00\n');
    expect(secondsPrecision.stderr.text).toBe('');
    expect(secondsPrecision.result.exitCode).toBe(0);
  });

  it('does not normalize ISO short bundles inside required option values', async () => {
    const dateValue = await execute({ script: 'date -d -uI' });
    const directIsoSuffix = await execute({ script: 'date -Iu' });

    expect(dateValue.stdout.text).toBe('');
    expect(dateValue.stderr.text).toContain("date: invalid date '-uI'");
    expect(dateValue.result.exitCode).toBe(1);

    expect(directIsoSuffix.stdout.text).toBe('');
    expect(directIsoSuffix.stderr.text).toContain("date: invalid argument 'u' for '--iso-8601'");
    expect(directIsoSuffix.result.exitCode).toBe(1);
  });

  it('uses GNU date grammar for epoch operands', async () => {
    for (const operand of ['@1', '@+1.25', '@  +1.5  ', '@\t1', '@\v1', '@\f1', '@\r1']) {
      const { result, stderr } = await execute({
        script: `date -u -d '${operand}' '+%s'`,
      });
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }

    for (const operand of ['@', '@.5', '@1.', '@1e3', '@0x10', '@\u00A01', '@\u20031', '@\uFEFF1', '@1\u00A0']) {
      const { result, stdout, stderr } = await execute({
        script: `date -u -d '${operand}' '+%s'`,
      });
      expect(stdout.text).toBe('');
      expect(stderr.text).toContain('date: invalid date');
      expect(result.exitCode).toBe(1);
    }
  });

  it('accepts only ASCII whitespace around ordinary date operands', async () => {
    for (const operand of ['1970-01-01', ' 1970-01-01 ', '\t1970-01-01\t']) {
      const { result, stdout, stderr } = await execute({
        script: `date -u -d '${operand}' '+%F'`,
      });
      expect(stdout.text).toBe('1970-01-01\n');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }

    for (const operand of ['\u00A01970-01-01\u00A0', '\u20031970-01-01', '\uFEFF1970-01-01', '1970-01-01\u00A0']) {
      const { result, stdout, stderr } = await execute({
        script: `date -u -d '${operand}' '+%F'`,
      });
      expect(stdout.text).toBe('');
      expect(stderr.text).toContain('date: invalid date');
      expect(result.exitCode).toBe(1);
    }
  });

  it('parses an epoch date operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: "date -u -d @0 '+%Y-%m-%dT%H:%M:%S%z'",
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('1970-01-01T00:00:00+0000\n');
    expect(stderr.text).toBe('');
  });

  it('supports GNU calendar, week, and compound format tokens', async () => {
    const { result, stdout, stderr } = await execute({
      script: "date -u -d @0 '+%A|%B|%C|%y|%j|%u|%w|%U|%W|%V|%G|%g|%q|%R|%D|%r'",
    });

    expect(stdout.text).toBe('Thursday|January|19|70|001|4|4|00|00|01|1970|70|1|00:00|01/01/70|12:00:00 AM\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('formats timezone offsets with GNU colon modifiers', async () => {
    const utc = await execute({
      script: "date -u -d @0 '+%z|%:z|%::z|%:::z'",
    });
    const kolkata = await execute({
      script: "TZ=Asia/Kolkata date -d @0 '+%z|%:z|%::z|%:::z'",
    });

    expect(utc.stdout.text).toBe('+0000|+00:00|+00:00:00|+00\n');
    expect(utc.stderr.text).toBe('');
    expect(utc.result.exitCode).toBe(0);
    expect(kolkata.stdout.text).toBe('+0530|+05:30|+05:30:00|+05:30\n');
    expect(kolkata.stderr.text).toBe('');
    expect(kolkata.result.exitCode).toBe(0);
  });

  it('formats ISO week-year boundaries', async () => {
    const start2000 = await execute({
      script: "date -u -d @946684800 '+%F %j %U %W %V %G %g'",
    });
    const start2016 = await execute({
      script: "date -u -d @1451606400 '+%F %j %U %W %V %G %g'",
    });

    expect(start2000.stdout.text).toBe('2000-01-01 001 00 00 52 1999 99\n');
    expect(start2016.stdout.text).toBe('2016-01-01 001 00 00 53 2015 15\n');
    for (const execution of [start2000, start2016]) {
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('supports RFC email output aliases', async () => {
    const short = await execute({ script: 'date -u -d @0 -R' });
    const long = await execute({ script: 'date -u -d @0 --rfc-email' });

    expect(short.stdout.text).toBe('Thu, 01 Jan 1970 00:00:00 +0000\n');
    expect(long.stdout.text).toBe(short.stdout.text);
    expect(short.stderr.text).toBe('');
    expect(long.stderr.text).toBe('');
    expect(short.result.exitCode).toBe(0);
    expect(long.result.exitCode).toBe(0);
  });

  it.each([
    ['-I -I'],
    ['-Ihours --rfc-3339=seconds'],
    ['--rfc-3339=date -R'],
    ['-R -R'],
    ['-I +%s'],
    ['+%F -R'],
  ])('rejects multiple output format selections: %s', async (formatArguments) => {
    const { result, stdout, stderr } = await execute({
      script: `date -u -d @0 ${formatArguments}`,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('date: multiple output formats specified\n');
  });

  it('validates an output precision before checking format conflicts or parsing the date', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'date -u -d bad -Ibogus -R',
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("date: invalid argument 'bogus' for '--iso-8601'");
  });

  it('checks output format conflicts before parsing the date', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'date -u -d bad -I -R',
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('date: multiple output formats specified\n');
  });

  it.each([
    ['--rfc-3339=bogus'],
    ['-Ibogus'],
  ])('rejects an invalid output precision: %s', async (argument) => {
    const { result, stdout, stderr } = await execute({
      script: `date ${argument}`,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('invalid argument');
  });


  it('validates fatal output-format semantics before a later --help', async () => {
    const invalidPrecision = await execute({ script: 'date --rfc-3339=bogus --help' });
    const multipleFormats = await execute({ script: 'date --rfc-3339=date --iso-8601=date --help' });
    const helpFirst = await execute({ script: 'date --help --rfc-3339=bogus' });
    const invalidDate = await execute({ script: "date -d 'not-a-date' --help" });

    expect(invalidPrecision.result.exitCode).toBe(1);
    expect(invalidPrecision.stdout.text).toBe('');
    expect(invalidPrecision.stderr.text).toContain("invalid argument 'bogus' for '--rfc-3339'");

    expect(multipleFormats.result.exitCode).toBe(1);
    expect(multipleFormats.stdout.text).toBe('');
    expect(multipleFormats.stderr.text).toBe('date: multiple output formats specified\n');

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidDate.result.exitCode).toBe(0);
    expect(invalidDate.stdout.text).not.toBe('');
    expect(invalidDate.stderr.text).toBe('');
  });

  it('preserves fractional epoch nanoseconds in %N formats', async () => {
    const positive = await execute({
      script: "date -u -d @1.123456789 '+%s|%N|%3N|%6N|%9N'",
    });
    const negative = await execute({
      script: "date -u -d @-1.1234567899 '+%s|%N'",
    });

    expect(positive.result.exitCode).toBe(0);
    expect(positive.stdout.text).toBe('1|123456789|123|123456|123456789\n');
    expect(positive.stderr.text).toBe('');
    expect(negative.result.exitCode).toBe(0);
    expect(negative.stdout.text).toBe('-2|876543210\n');
    expect(negative.stderr.text).toBe('');
  });

  it('preserves nanoseconds in ISO and RFC 3339 output', async () => {
    const iso = await execute({ script: 'date -u -d @1.25 -Ins' });
    const rfc = await execute({ script: 'date -u -d @1.25 --rfc-3339=ns' });

    expect(iso.result.exitCode).toBe(0);
    expect(iso.stdout.text).toBe('1970-01-01T00:00:01,250000000+00:00\n');
    expect(iso.stderr.text).toBe('');
    expect(rfc.result.exitCode).toBe(0);
    expect(rfc.stdout.text).toBe('1970-01-01 00:00:01.250000000+00:00\n');
    expect(rfc.stderr.text).toBe('');
  });

  it('preserves fractional seconds from accepted ISO-shaped date operands', async () => {
    const positive = await execute({
      script: "date -u -d '1970-01-01T00:00:00.1234567899Z' '+%s|%N'",
    });
    const negativeEpoch = await execute({
      script: "date -u -d '1969-12-31T23:59:59.123456789Z' '+%s|%N'",
    });
    const offset = await execute({
      script: "date -u -d '2026-03-20T01:02:03.987654321+09:00' '+%s|%N'",
    });

    expect(positive.stdout.text).toBe('0|123456789\n');
    expect(positive.stderr.text).toBe('');
    expect(positive.result.exitCode).toBe(0);
    expect(negativeEpoch.stdout.text).toBe('-1|123456789\n');
    expect(negativeEpoch.stderr.text).toBe('');
    expect(negativeEpoch.result.exitCode).toBe(0);
    expect(offset.stdout.text).toBe('1773936123|987654321\n');
    expect(offset.stderr.text).toBe('');
    expect(offset.result.exitCode).toBe(0);
  });

});
