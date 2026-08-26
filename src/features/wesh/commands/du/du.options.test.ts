import { beforeEach, describe, expect, it } from 'vitest';
import { formatDuValue } from './format';
import {
  createDuTestContext,
  executeDuTest,
  type DuTestContext,
  writeDuTestFile,
} from './test-utils';

describe('wesh du options', () => {
  let testContext: DuTestContext;

  beforeEach(async () => {
    testContext = await createDuTestContext();
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'file.txt',
      data: 'abc',
    });
  });

  it('supports --help', async () => {
    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --help',
      stdin: '',
    });

    expect(stdout.text).toContain('Estimate logical file size usage');
    expect(stdout.text).toContain('--files0-from=FILE');
    expect(stdout.text).not.toContain('--one-file-system');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves GNU help ordering across nonfatal and fatal option diagnostics', async () => {
    const unknownThenHelp = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --definitely-invalid-option --help',
      stdin: '',
    });
    const invalidDepthThenHelp = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --max-depth=bogus --help',
      stdin: '',
    });
    const invalidBlockSizeThenHelp = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=bogus --help',
      stdin: '',
    });
    const helpBeforeInvalid = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --help --block-size=bogus',
      stdin: '',
    });

    expect(unknownThenHelp.stdout.text).toContain('Estimate logical file size usage');
    expect(unknownThenHelp.stderr.text).toContain("du: unrecognized option '--definitely-invalid-option'");
    expect(unknownThenHelp.result.exitCode).toBe(0);
    expect(invalidDepthThenHelp.stdout.text).toContain('Estimate logical file size usage');
    expect(invalidDepthThenHelp.stderr.text).toContain("du: invalid maximum depth 'bogus'");
    expect(invalidDepthThenHelp.result.exitCode).toBe(0);
    expect(invalidBlockSizeThenHelp.stdout.text).toBe('');
    expect(invalidBlockSizeThenHelp.stderr.text).toContain("du: invalid size suffix in 'bogus'");
    expect(invalidBlockSizeThenHelp.result.exitCode).toBe(1);
    expect(helpBeforeInvalid.stdout.text).toContain('Estimate logical file size usage');
    expect(helpBeforeInvalid.stderr.text).toBe('');
    expect(helpBeforeInvalid.result.exitCode).toBe(0);
  });

  it('suppresses runtime warnings when help wins', async () => {
    const summarize = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -s --max-depth=0 --help',
      stdin: '',
    });
    const inodes = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --inodes -b --help',
      stdin: '',
    });

    expect(summarize.result.exitCode).toBe(0);
    expect(summarize.stdout.text).toContain('Estimate logical file size usage');
    expect(summarize.stderr.text).toBe('');
    expect(inodes.result.exitCode).toBe(0);
    expect(inodes.stdout.text).toContain('Estimate logical file size usage');
    expect(inodes.stderr.text).toBe('');
  });

  it('lets help bypass post-parse conflicts while retaining pre-help exclude-file diagnostics', async () => {
    const conflicting = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -a -s --help',
      stdin: '',
    });
    const missingExclude = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -X missing-file --help',
      stdin: '',
    });

    expect(conflicting.stdout.text).toContain('Estimate logical file size usage');
    expect(conflicting.stderr.text).toBe('');
    expect(conflicting.result.exitCode).toBe(0);
    expect(missingExclude.stdout.text).toContain('Estimate logical file size usage');
    expect(missingExclude.stderr.text).toContain('du:');
    expect(missingExclude.stderr.text).toContain('missing-file');
    expect(missingExclude.result.exitCode).toBe(0);
  });

  it('rejects incompatible --all and --summarize options', async () => {
    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -as file.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('du: cannot both summarize and show all entries');
    expect(result.exitCode).toBe(1);
  });

  it('rejects a nonzero max depth with --summarize', async () => {
    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -s --max-depth=1 file.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('du: summarizing conflicts with --max-depth=1');
    expect(result.exitCode).toBe(1);
  });

  it('accepts --max-depth=0 as summary behavior', async () => {
    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b -s --max-depth=0 file.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('3\tfile.txt\n');
    expect(stderr.text).toBe('du: warning: summarizing is the same as using --max-depth=0\n');
    expect(result.exitCode).toBe(0);
  });

  it('warns when logical-size options are ineffective with --inodes', async () => {
    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --inodes -b file.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('1\tfile.txt\n');
    expect(stderr.text).toBe('du: warning: options --apparent-size and -b are ineffective with --inodes\n');
    expect(result.exitCode).toBe(0);
  });

  it('uses human-readable formatting for inode counts', () => {
    expect(formatDuValue({
      value: 1201n,
      outputFormat: { kind: 'human', base: 1024 },
      metric: 'inodes',
    })).toBe('1.2K');
    expect(formatDuValue({
      value: 1201n,
      outputFormat: { kind: 'human', base: 1000 },
      metric: 'inodes',
    })).toBe('1.3k');
    expect(formatDuValue({
      value: 1201n,
      outputFormat: { kind: 'blocks', unit: 100n, suffix: 'x' },
      metric: 'inodes',
    })).toBe('1201');
  });

  it('uses the last size formatting option', async () => {
    const bytesLast = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -k -b file.txt',
      stdin: '',
    });
    expect(bytesLast.stdout.text).toBe('3\tfile.txt\n');

    const blocksLast = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b -k file.txt',
      stdin: '',
    });
    expect(blocksLast.stdout.text).toBe('1\tfile.txt\n');
  });

  it('supports decimal and binary block-size suffixes', async () => {
    const decimal = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -B2KB file.txt',
      stdin: '',
    });
    expect(decimal.stdout.text).toBe('1\tfile.txt\n');

    const binary = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=2KiB file.txt',
      stdin: '',
    });
    expect(binary.stdout.text).toBe('1\tfile.txt\n');
  });

  it('rejects invalid size and depth values', async () => {
    const size = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=wat file.txt',
      stdin: '',
    });
    expect(size.stderr.text).toContain("du: invalid size suffix in 'wat'");
    expect(size.result.exitCode).toBe(1);

    const depth = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --max-depth=-1 file.txt',
      stdin: '',
    });
    expect(depth.stderr.text).toContain("du: invalid maximum depth '-1'");
    expect(depth.result.exitCode).toBe(1);
  });

  it('keeps inode mode when apparent-size or byte options are also present', async () => {
    const first = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --inodes -b file.txt',
      stdin: '',
    });
    expect(first.stdout.text).toBe('1\tfile.txt\n');

    const second = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --inodes file.txt',
      stdin: '',
    });
    expect(second.stdout.text).toBe('1\tfile.txt\n');

    const third = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --inodes --apparent-size file.txt',
      stdin: '',
    });
    expect(third.stdout.text).toBe('1\tfile.txt\n');
  });

  it('uses block-size environment variables when no command-line format overrides them', async () => {
    const bytes = await executeDuTest({
      wesh: testContext.wesh,
      script: 'DU_BLOCK_SIZE=1 du file.txt',
      stdin: '',
    });
    expect(bytes.stdout.text).toBe('3\tfile.txt\n');

    const human = await executeDuTest({
      wesh: testContext.wesh,
      script: 'DU_BLOCK_SIZE=human-readable du file.txt',
      stdin: '',
    });
    expect(human.stdout.text).toBe('3\tfile.txt\n');

    const suffix = await executeDuTest({
      wesh: testContext.wesh,
      script: 'DU_BLOCK_SIZE=K du file.txt',
      stdin: '',
    });
    expect(suffix.stdout.text).toBe('1K\tfile.txt\n');
  });

  it('falls back to the default when the highest-priority block-size variable is invalid', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'large.txt',
      data: 'x'.repeat(1025),
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'DU_BLOCK_SIZE=wat BLOCK_SIZE=1 du large.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('2\tlarge.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves unit suffixes for implicit block-size multipliers', async () => {
    const binary = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=KiB file.txt',
      stdin: '',
    });
    expect(binary.stdout.text).toBe('1KiB\tfile.txt\n');

    const short = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=K file.txt',
      stdin: '',
    });
    expect(short.stdout.text).toBe('1K\tfile.txt\n');

    const decimal = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=KB file.txt',
      stdin: '',
    });
    expect(decimal.stdout.text).toBe('1kB\tfile.txt\n');
    expect(decimal.stderr.text).toBe('');
    expect(decimal.result.exitCode).toBe(0);
  });

  it('accepts signed numeric block sizes and rejects invalid suffix casing', async () => {
    const positive = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=+1K file.txt',
      stdin: '',
    });
    expect(positive.stdout.text).toBe('1\tfile.txt\n');
    expect(positive.stderr.text).toBe('');
    expect(positive.result.exitCode).toBe(0);

    const invalid = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --block-size=kb file.txt',
      stdin: '',
    });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("du: invalid size suffix in 'kb'");
    expect(invalid.result.exitCode).toBe(1);
  });

  it('supports decimal human units, mebibyte units, and apparent-size compatibility', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'decimal.txt',
      data: 'x'.repeat(1000),
    });

    const si = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --si decimal.txt',
      stdin: '',
    });
    expect(si.stdout.text).toBe('1.0k\tdecimal.txt\n');

    const mebibytes = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -m decimal.txt',
      stdin: '',
    });
    expect(mebibytes.stdout.text).toBe('1\tdecimal.txt\n');

    const apparent = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --apparent-size decimal.txt',
      stdin: '',
    });
    expect(apparent.stdout.text).toBe('1000\tdecimal.txt\n');
    expect(apparent.stderr.text).toBe('');
    expect(apparent.result.exitCode).toBe(0);
  });

  it('uses 512-byte units when POSIXLY_CORRECT is present', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'large.txt',
      data: 'x'.repeat(513),
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'POSIXLY_CORRECT=1 du large.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('2\tlarge.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports implicit threshold units and validates signed thresholds', async () => {
    const implicitUnit = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --threshold=K file.txt',
      stdin: '',
    });
    expect(implicitUnit.stdout.text).toBe('');
    expect(implicitUnit.stderr.text).toBe('');
    expect(implicitUnit.result.exitCode).toBe(0);

    const explicitPositive = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --threshold=+1K file.txt',
      stdin: '',
    });
    expect(explicitPositive.stdout.text).toBe('');
    expect(explicitPositive.stderr.text).toBe('');
    expect(explicitPositive.result.exitCode).toBe(0);

    for (const threshold of ['-0', '+K', '-K']) {
      const invalid = await executeDuTest({
        wesh: testContext.wesh,
        script: `du --threshold=${threshold} file.txt`,
        stdin: '',
      });
      expect(invalid.stdout.text).toBe('');
      expect(invalid.stderr.text).toContain(`du: invalid`);
      expect(invalid.result.exitCode).toBe(1);
    }
  });

  it('treats operands after -- as paths even when they begin with a dash', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: '-file',
      data: 'abc',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b -- -file',
      stdin: '',
    });

    expect(stdout.text).toBe('3\t-file\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not advertise or accept unsupported filesystem-boundary traversal', async () => {
    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -x file.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("du: invalid option -- 'x'");
    expect(result.exitCode).toBe(1);
  });

  it('rejects file operands with --files0-from', async () => {
    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --files0-from=- file.txt',
      stdin: 'file.txt\0',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("du: extra operand 'file.txt'");
    expect(stderr.text).toContain('file operands cannot be combined with --files0-from');
    expect(result.exitCode).toBe(1);
  });

  it('accepts only leading C-locale whitespace in maximum depth', async () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await executeDuTest({
        wesh: testContext.wesh,
        script: `du -b --max-depth='${whitespace}0' file.txt`,
        stdin: '',
      });
      expect(execution.stdout.text).toBe('3\tfile.txt\n');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['0 ', '\u00a00', '\u20030', '\ufeff0']) {
      const execution = await executeDuTest({
        wesh: testContext.wesh,
        script: `du -b --max-depth='${operand}' file.txt`,
        stdin: '',
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid maximum depth');
      expect(execution.result.exitCode).toBe(1);
    }
  });


  it('accepts an explicit positive sign in maximum depth', async () => {
    const execution = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --max-depth=+0 file.txt',
      stdin: '',
    });

    expect(execution.stdout.text).toBe('3\tfile.txt\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

});
