import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';
import { TEST_ONLY } from './index';

describe('seq command', () => {
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

  it('derives equal width from sequence endpoints without scanning every value', () => {
    expect(TEST_ONLY.equalWidthForSeqPlan({
      plan: {
        first: 1n,
        increment: 1n,
        last: 999_999n,
        count: 1_000_001,
        scale: 0,
        outputPrecision: 0,
        firstInputWidth: 1,
        firstInputPrecision: 0,
        lastInputWidth: 6,
        lastInputPrecision: 0,
        firstIsNegativeZero: false,
        lastIsNegativeZero: false,
      },
    })).toBe(6);
    expect(TEST_ONLY.equalWidthForSeqPlan({
      plan: {
        first: -100n,
        increment: 1n,
        last: 99n,
        count: 200,
        scale: 0,
        outputPrecision: 0,
        firstInputWidth: 4,
        firstInputPrecision: 0,
        lastInputWidth: 2,
        lastInputPrecision: 0,
        firstIsNegativeZero: false,
        lastIsNegativeZero: false,
      },
    })).toBe(4);
  });

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
    expect(sep.stdout.text).toBe('1,2,3\n');
    expect(width.stdout.text).toBe(`\
08
09
10
`);

    const lexicalWidth = await execute({ script: 'seq -w 001 1 003' });
    expect(lexicalWidth.stdout.text).toBe(`\
001
002
003
`);
    expect(lexicalWidth.stderr.text).toBe('');
    expect(lexicalWidth.result.exitCode).toBe(0);

    const exponentWidth = await execute({ script: 'seq -w -18490e-3 3.500 +9.510' });
    expect(exponentWidth.stdout.text).toBe(`\
-00018.490
-00014.990
-00011.490
-00007.990
-00004.490
-00000.990
000002.510
000006.010
000009.510
`);
    expect(exponentWidth.stderr.text).toBe('');
    expect(exponentWidth.result.exitCode).toBe(0);

    const unreachedWideLast = await execute({ script: 'seq -w 5 -2 -10' });
    expect(unreachedWideLast.stdout.text).toBe(`\
005
003
001
-01
-03
-05
-07
-09
`);
    expect(unreachedWideLast.stderr.text).toBe('');
    expect(unreachedWideLast.result.exitCode).toBe(0);
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

    expect(separator.stdout.text).toBe('1,2,3\n');
    expect(separator.stderr.text).toBe('');
    expect(separator.result.exitCode).toBe(0);
  });

  it('uses exact decimal stepping for exponents, tiny increments, and large integers', async () => {
    const exponent = await execute({ script: 'seq 1e0 5e-1 2e0' });
    const tiny = await execute({ script: 'seq 0 0.0000000000001 0.0000000000003' });
    const large = await execute({ script: 'seq 9007199254740991 9007199254740993' });
    const negativeZero = await execute({ script: 'seq -0 1 2' });
    const generatedNegativeZero = await execute({ script: 'seq -10.8 +3.6 25.2' });

    expect(exponent.stdout.text).toBe(`\
1.0
1.5
2.0
`);
    expect(tiny.stdout.text).toBe(`\
0.0000000000000
0.0000000000001
0.0000000000002
0.0000000000003
`);
    expect(large.stdout.text).toBe(`\
9007199254740991
9007199254740992
9007199254740993
`);
    expect(negativeZero.stdout.text).toBe(`\
-0
1
2
`);
    expect(generatedNegativeZero.stdout.text).toBe(`\
-10.8
-7.2
-3.6
-0.0
3.6
7.2
10.8
14.4
18.0
21.6
25.2
`);
    expect(exponent.stderr.text).toBe('');
    expect(tiny.stderr.text).toBe('');
    expect(large.stderr.text).toBe('');
    expect(negativeZero.stderr.text).toBe('');
    expect(generatedNegativeZero.stderr.text).toBe('');
    expect(generatedNegativeZero.result.exitCode).toBe(0);
  });

  it('derives the default precision from FIRST and INCREMENT and rounds fixed formats to even', async () => {
    const oneOperand = await execute({ script: 'seq 1.5' });
    const twoOperands = await execute({ script: 'seq -1 0.5' });
    const fixed = await execute({ script: "seq -f '%.0f' 1 0.5 3" });
    const negativeFixed = await execute({ script: "seq -f '%.0f' -3 0.5 -1" });

    expect(oneOperand.stdout.text).toBe('1\n');
    expect(twoOperands.stdout.text).toBe(`\
-1
0
`);
    expect(fixed.stdout.text).toBe(`\
1
2
2
2
3
`);
    expect(negativeFixed.stdout.text).toBe(`\
-3
-2
-2
-2
-1
`);
    expect(oneOperand.stderr.text).toBe('');
    expect(twoOperands.stderr.text).toBe('');
    expect(fixed.stderr.text).toBe('');
    expect(negativeFixed.stderr.text).toBe('');
  });

  it('uses long-double arithmetic and applies GNU format-and-reparse endpoint correction', async () => {
    const lowerPrecision = await execute({ script: "seq -f '%.2f' 6.668 -0.983 -0.213" });
    const retainedPrecision = await execute({ script: "seq -f '%.3f' 6.668 -0.983 -0.213" });
    const intermediateRounding = await execute({ script: "seq -s, -f '%.3g' 4.09 5.78 21.43" });
    const trailingZeroLast = await execute({ script: "seq -f '%13.1f' 431.37 -22.29 -81.30" });
    const leftAlignedFixed = await execute({ script: "seq -f '%-11.3f' 5039.6 -884.7 -10000.3" });
    const leftAlignedPrecise = await execute({ script: "seq -f '%-11.4f' 2.261 -1.721 -6.344" });
    const leftAlignedGeneral = await execute({ script: "seq -f '%-7.6g' 769.52 -94.51 -81.07" });

    expect(lowerPrecision.stdout.text).toBe(`\
6.67
5.68
4.70
3.72
2.74
1.75
0.77
`);
    expect(retainedPrecision.stdout.text).toBe(`\
6.668
5.685
4.702
3.719
2.736
1.753
0.770
-0.213
`);
    expect(intermediateRounding.stdout.text).toBe('4.09,9.87,15.7,21.4\n');
    expect(trailingZeroLast.stdout.text.trimEnd().split('\n')).toHaveLength(24);
    expect(trailingZeroLast.stdout.text.trimEnd().split('\n').at(-1)).toBe('        -81.3');
    expect(leftAlignedFixed.stdout.text.trimEnd().split('\n')).toHaveLength(17);
    expect(leftAlignedFixed.stdout.text.trimEnd().split('\n').at(-1)).toBe('-9115.600');
    expect(leftAlignedPrecise.stdout.text.trimEnd().split('\n')).toHaveLength(5);
    expect(leftAlignedPrecise.stdout.text.trimEnd().split('\n').at(-1)).toBe('-4.6230');
    expect(leftAlignedGeneral.stdout.text.trimEnd().split('\n')).toHaveLength(9);
    expect(leftAlignedGeneral.stdout.text.trimEnd().split('\n').at(-1)).toBe('13.44');
    expect(lowerPrecision.stderr.text).toBe('');
    expect(retainedPrecision.stderr.text).toBe('');
    expect(intermediateRounding.stderr.text).toBe('');
    expect(trailingZeroLast.stderr.text).toBe('');
    expect(leftAlignedFixed.stderr.text).toBe('');
    expect(leftAlignedPrecise.stderr.text).toBe('');
    expect(leftAlignedGeneral.stderr.text).toBe('');
  });

  it('supports GNU floating-point format flags and rejects integer conversions', async () => {
    const sign = await execute({ script: "seq -f '%+05.1f' 1 2" });
    const left = await execute({ script: "seq -f '%-5.1f' 1 2" });
    const space = await execute({ script: "seq -f '% 5.1f' 1 2" });
    const zeroPrecision = await execute({ script: "seq -f '%.0g' 1 2" });
    const integer = await execute({ script: "seq -f '%d' 1 2" });

    expect(sign.stdout.text).toBe(`\
+01.0
+02.0
`);
    expect(left.stdout.text).toBe(`\
1.0${'  '}
2.0${'  '}
`);
    expect(space.stdout.text).toBe(`\
  1.0
  2.0
`);
    expect(zeroPrecision.stdout.text).toBe(`\
1
2
`);
    expect(integer.stdout.text).toBe('');
    expect(integer.stderr.text).toContain("unsupported conversion 'd'");
    expect(integer.result.exitCode).toBe(1);
  });


  it('matches GNU formatting and option-boundary behavior', async () => {
    const exponential = await execute({ script: "seq -f '%.2e' 1 2" });
    const general = await execute({ script: "seq -f '%.3G' 1000 1000 3000" });
    const emptyPrecision = await execute({ script: "seq -f '%.f' 1" });
    const hexadecimal = await execute({ script: 'seq 0x3' });
    const conflicting = await execute({ script: "seq -w -f '%.1f' 1 2" });
    const optionAfterOperand = await execute({ script: "seq 1 3 '-s,'" });
    const bundledSeparator = await execute({ script: "seq '-ws,' 1 3" });
    const separatorConsumesRest = await execute({ script: "seq '-sw,' 1 3" });
    const bundledConflict = await execute({ script: "seq '-wf%02g' 1 3" });
    const formatConsumesRest = await execute({ script: "seq '-fw%02g' 1 3" });
    const repeatedWidth = await execute({ script: 'seq -ww 8 10' });
    const invalidBundle = await execute({ script: 'seq -wz 1 3' });

    expect(exponential.stdout.text).toBe(`\
1.00e+00
2.00e+00
`);
    expect(general.stdout.text).toBe(`\
1E+03
2E+03
3E+03
`);
    expect(emptyPrecision.stdout.text).toBe('1\n');
    expect(hexadecimal.stdout.text).toBe(`\
1
2
3
`);
    expect(conflicting.stdout.text).toBe('');
    expect(conflicting.stderr.text).toContain('format string may not be specified');
    expect(conflicting.result.exitCode).toBe(1);
    expect(optionAfterOperand.stdout.text).toBe('');
    expect(optionAfterOperand.stderr.text).toContain("invalid floating point argument: '-s,'");
    expect(optionAfterOperand.result.exitCode).toBe(1);
    expect(bundledSeparator.stdout.text).toBe('1,2,3\n');
    expect(bundledSeparator.stderr.text).toBe('');
    expect(separatorConsumesRest.stdout.text).toBe('1w,2w,3\n');
    expect(separatorConsumesRest.stderr.text).toBe('');
    expect(bundledConflict.stdout.text).toBe('');
    expect(bundledConflict.stderr.text).toContain('format string may not be specified');
    expect(bundledConflict.result.exitCode).toBe(1);
    expect(formatConsumesRest.stdout.text).toBe(`\
w01
w02
w03
`);
    expect(formatConsumesRest.stderr.text).toBe('');
    expect(repeatedWidth.stdout.text).toBe(`\
08
09
10
`);
    expect(repeatedWidth.stderr.text).toBe('');
    expect(invalidBundle.stdout.text).toBe('');
    expect(invalidBundle.stderr.text).toContain("invalid option -- 'z'");
    expect(invalidBundle.result.exitCode).toBe(1);
  });


  it('accepts only leading C-locale whitespace in numeric operands', async () => {
    const accepted = [];
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      accepted.push(await execute({ script: `seq '${whitespace}1' 3` }));
    }

    const rejected = [];
    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      rejected.push(await execute({ script: `seq '${operand}' 3` }));
    }

    for (const execution of accepted) {
      expect(execution.stdout.text).toBe(`\
1
2
3
`);
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const execution of rejected) {
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid floating point argument');
      expect(execution.result.exitCode).toBe(1);
    }
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'seq --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'seq --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
